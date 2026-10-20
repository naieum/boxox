import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { messages } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import {
  deliverQueuedMessage,
  failExpiredSends,
  MAX_SEND_ATTEMPTS,
  pendingOutbound,
  RETRY_WINDOW_MS,
  type OutboundPayload,
} from "../src/services/outbound";
import { messageRow, seedMailbox, seedThread } from "./helpers/seed";

/**
 * Outbound durability against a local D1. The failure this exists to prevent:
 * a provider outage returning an error with nothing persisted, destroying the
 * composed message — the one failure mode a mail product cannot have.
 */
let db: Db;

beforeAll(() => {
  db = createDb(env);
});

describe("retry bounds", () => {
  it("stops well inside a 24h idempotency window", () => {
    // Past 24h a retry risks a SECOND copy of a message that may already have
    // been delivered. Duplicate mail is worse than a visibly-failed message
    // someone resends on purpose, so this must stay comfortably under it.
    expect(RETRY_WINDOW_MS).toBeLessThan(24 * 3600 * 1000);
    expect(RETRY_WINDOW_MS).toBe(12 * 3600 * 1000);
  });

  it("gives up after a bounded number of attempts", () => {
    expect(MAX_SEND_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_SEND_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe("pendingOutbound", () => {
  const now = Date.UTC(2026, 6, 24, 12, 0, 0);
  let box: Awaited<ReturnType<typeof seedMailbox>>;

  const out = (threadId: string, id: string, over: Partial<typeof messages.$inferInsert> = {}) =>
    messageRow(box, threadId, {
      id,
      direction: "outbound",
      fromEmail: "me@s.test",
      r2Key: `sent/${id}`,
      occurredAt: new Date(now - 60_000),
      sendStatus: "queued",
      sendAttempts: 0,
      ...over,
    });

  beforeAll(async () => {
    box = await seedMailbox(db, { orgId: "out", domain: "s.test" });
    const t = await seedThread(db, box);
    // One row per insert: D1 binds at most 100 parameters per statement.
    for (const row of [
      out(t, "queued_recent"),
      out(t, "already_sent", { sendStatus: "sent" }),
      out(t, "hard_failed", { sendStatus: "failed" }),
      out(t, "exhausted", { sendAttempts: MAX_SEND_ATTEMPTS }),
      // Older than the retry window — replaying it could duplicate.
      out(t, "too_old", { occurredAt: new Date(now - RETRY_WINDOW_MS - 60_000) }),
      out(t, "inbound_row", { direction: "inbound", sendStatus: null }),
    ]) {
      await db.insert(messages).values(row);
    }
  });

  const pendingIds = async () => (await pendingOutbound(db, "out", now)).map((r) => r.id);

  it("selects a recently queued message", async () => {
    expect(await pendingIds()).toEqual(["queued_recent"]);
  });

  it("never re-sends something already delivered", async () => {
    expect(await pendingIds()).not.toContain("already_sent");
  });

  it("leaves terminally failed messages for a human", async () => {
    const ids = await pendingIds();
    expect(ids).not.toContain("hard_failed");
    expect(ids).not.toContain("exhausted");
  });

  it("refuses anything past the retry window", async () => {
    // This is the duplicate-prevention boundary, not a performance cap.
    expect(await pendingIds()).not.toContain("too_old");
  });

  it("ignores inbound rows entirely", async () => {
    expect(await pendingIds()).not.toContain("inbound_row");
  });

  it("does not cross organizations", async () => {
    await seedMailbox(db, { orgId: "out2", domain: "s2.test" });
    expect(await pendingOutbound(db, "out2", now)).toEqual([]);
  });

  it("returns the r2Key a retry needs to rebuild the message", async () => {
    const row = (await pendingOutbound(db, "out", now)).find((r) => r.id === "queued_recent");
    // Without the stored payload there is nothing to resend — this column is
    // why a provider outage is survivable at all.
    expect(row?.r2Key).toBe("sent/queued_recent");
  });

  it("does not treat a row with no send status as retryable", async () => {
    const box2 = await seedMailbox(db, { orgId: "legacy" });
    const t = await seedThread(db, box2);
    await db.insert(messages).values(
      messageRow(box2, t, { id: "legacy", direction: "outbound", sentMessageId: "msg_123", sendStatus: null }),
    );
    expect(await pendingOutbound(db, "legacy", Date.now())).toEqual([]);
    const [row] = await db.select({ status: messages.sendStatus }).from(messages).where(eq(messages.id, "legacy"));
    expect(row?.status).toBeNull();
  });
});

describe("failExpiredSends", () => {
  it("closes out queued sends past the retry window instead of stranding them", async () => {
    // Nothing else moves rows out of `queued` once pendingOutbound stops
    // selecting them, so they would claim to be pending forever with no error.
    const box = await seedMailbox(db, { orgId: "exp" });
    const t = await seedThread(db, box);
    const now = Date.now();
    const base = { direction: "outbound" as const, sendStatus: "queued" as const };
    await db.insert(messages).values(messageRow(box, t, { ...base, id: "stranded", occurredAt: new Date(now - RETRY_WINDOW_MS - 60_000) }));
    await db.insert(messages).values(messageRow(box, t, { ...base, id: "still_fresh", occurredAt: new Date(now - 60_000) }));

    expect(await failExpiredSends(db, "exp", now)).toBe(1);

    const rows = await db
      .select({ id: messages.id, s: messages.sendStatus, e: messages.sendError })
      .from(messages)
      .where(eq(messages.organizationId, "exp"));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("stranded")?.s).toBe("failed");
    // A null error is what made this invisible; the reason must be recorded.
    expect(byId.get("stranded")?.e).toMatch(/retry window/);
    expect(byId.get("still_fresh")?.s).toBe("queued");
    // Running it again finds nothing new.
    expect(await failExpiredSends(db, "exp", now)).toBe(0);
  });
});

describe("deliverQueuedMessage", () => {
  const payload = (messageId: string, organizationId: string): OutboundPayload => ({
    messageId,
    organizationId,
    from: "me@s.test",
    to: ["ann@example.test"],
    cc: [],
    subject: "Hello",
    text: "synthetic body",
    html: null,
    attachments: [{ filename: "a.txt", content: btoa("hi"), contentType: "text/plain" }],
    inReplyTo: "<parent@ext.test>",
    references: "<root@ext.test> <parent@ext.test>",
    attempts: 0,
  });

  async function queued(orgId: string) {
    const box = await seedMailbox(db, { orgId });
    const t = await seedThread(db, box);
    const row = messageRow(box, t, { direction: "outbound", sendStatus: "queued", sendAttempts: 0 });
    await db.insert(messages).values(row);
    return row.id!;
  }

  const status = async (id: string) =>
    (await db.select().from(messages).where(eq(messages.id, id)))[0]!;

  it("records the provider message id once the binding accepts the message", async () => {
    const id = await queued("deliver-ok");
    const sent: unknown[] = [];
    const email = { send: async (m: unknown) => (sent.push(m), { messageId: "<cf-1@s.test>" }) } as unknown as SendEmail;

    expect(await deliverQueuedMessage(db, email, payload(id, "deliver-ok"))).toEqual({ ok: true, sentMessageId: "<cf-1@s.test>" });
    const row = await status(id);
    expect(row.sendStatus).toBe("sent");
    expect(row.sendAttempts).toBe(1);
    expect(row.sentMessageId).toBe("<cf-1@s.test>");
    expect(sent[0]).toMatchObject({
      to: ["ann@example.test"],
      headers: { "In-Reply-To": "<parent@ext.test>", References: "<root@ext.test> <parent@ext.test>" },
    });
    const att = (sent[0] as { attachments: { content: Uint8Array }[] }).attachments[0]!;
    expect(new TextDecoder().decode(att.content)).toBe("hi");
  });

  it("marks the message failed with a bounded error and does not retry", async () => {
    const id = await queued("deliver-fail");
    const email = { send: async () => { throw new Error("x".repeat(2000)); } } as unknown as SendEmail;

    const result = await deliverQueuedMessage(db, email, payload(id, "deliver-fail"));
    expect(result).toMatchObject({ ok: false, retryable: false });
    const row = await status(id);
    expect(row.sendStatus).toBe("failed");
    expect(row.sendError).toHaveLength(500);
  });

  it("never overwrites a terminal state written by a concurrent attempt", async () => {
    const id = await queued("deliver-race");
    await db.update(messages).set({ sendStatus: "sent", sentMessageId: "<first@s.test>" }).where(eq(messages.id, id));
    const email = { send: async () => { throw new Error("late failure"); } } as unknown as SendEmail;

    await deliverQueuedMessage(db, email, payload(id, "deliver-race"));
    const row = await status(id);
    expect(row.sendStatus).toBe("sent");
    expect(row.sentMessageId).toBe("<first@s.test>");
  });

  it("is scoped to the message's organization", async () => {
    const id = await queued("deliver-scope");
    const email = { send: async () => ({ messageId: "<cf-2@s.test>" }) } as unknown as SendEmail;

    await deliverQueuedMessage(db, email, payload(id, "someone-else"));
    expect((await status(id)).sendStatus).toBe("queued");
  });
});
