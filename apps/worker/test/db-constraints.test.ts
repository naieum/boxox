import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { addresses, domains, messages, threads } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import { encodeThreadCursor, parseThreadCursor } from "../src/routes/threads";
import { dedupeScopeFor, resolveThread } from "../src/services/ingest";
import { failure, id, messageRow, seedMailbox, seedThread } from "./helpers/seed";

/**
 * Guarantees that live in the D1 schema rather than in TypeScript, so the pure
 * suites cannot catch a regression in them. Ported from v1's Postgres suite.
 */
let db: Db;

beforeAll(() => {
  db = createDb(env);
});

const dedupeTarget = { target: [messages.organizationId, messages.dedupeScope, messages.rfcMessageId] };

describe("inbound idempotency (messages_dedupe_idx)", () => {
  let box: Awaited<ReturnType<typeof seedMailbox>>;
  let threadId: string;
  const message = (over: Partial<typeof messages.$inferInsert> = {}) =>
    messageRow(box, threadId, { id: id(), rfcMessageId: "<same@ext.test>", ...over });
  const insertOnce = (row: typeof messages.$inferInsert) =>
    db.insert(messages).values(row).onConflictDoNothing(dedupeTarget).returning({ id: messages.id });

  beforeAll(async () => {
    box = await seedMailbox(db, { orgId: "orga", domain: "a.test" });
    threadId = await seedThread(db, box);
  });

  it("admits the first delivery of a message", async () => {
    expect(await insertOnce(message())).toHaveLength(1);
  });

  it("silently drops a redelivery into the same mailbox", async () => {
    // The guarantee ingest relies on: two concurrent deliveries can both pass a
    // SELECT-then-INSERT check, but only one insert can win the unique index.
    expect(await insertOnce(message())).toHaveLength(0);
    const rows = await db.select().from(messages).where(eq(messages.rfcMessageId, "<same@ext.test>"));
    expect(rows).toHaveLength(1);
  });

  it("raises on an unguarded duplicate insert rather than storing it", async () => {
    expect(await failure(db.insert(messages).values(message()))).toMatch(/UNIQUE constraint failed/);
  });

  it("treats the same message to a different mailbox as a distinct delivery", async () => {
    // One email addressed to two of our mailboxes must produce one row each —
    // the key is (org, scope, message-id), not the message id alone.
    const second = await seedMailbox(db, { orgId: "orga", localPart: "second" });
    const t2 = await seedThread(db, second);
    const row = messageRow(second, t2, { rfcMessageId: "<same@ext.test>", dedupeScope: dedupeScopeFor(second) });
    expect(await insertOnce(row)).toHaveLength(1);
  });

  it("scopes held/unrouted copies by recipient, so retries of held mail dedupe", async () => {
    // A plain address_id unique index could not cover this: held rows have
    // address_id NULL and SQLite treats NULLs as distinct, so every retry
    // would insert again.
    const held = await seedThread(db, box, {
      addressId: null,
      domainId: box.domainId,
      originalRecipient: "typo@a.test",
      folder: "unrouted",
    });
    const copy = () =>
      messageRow(box, held, {
        id: id(),
        addressId: null,
        dedupeScope: dedupeScopeFor({ heldRecipient: "typo@a.test" }),
        rfcMessageId: "<held@ext.test>",
      });
    expect(await insertOnce(copy())).toHaveLength(1);
    expect(await insertOnce(copy())).toHaveLength(0);
    // A different held recipient is a different delivery.
    expect(await insertOnce({ ...copy(), dedupeScope: dedupeScopeFor({ heldRecipient: "other@a.test" }) })).toHaveLength(1);
  });
});

describe("cross-tenant isolation of held mail", () => {
  it("keeps two orgs holding the same domain name independent", async () => {
    // domains is unique on (organization_id, name), so the same name can exist
    // in two orgs; the held-mail key must be org-scoped or org B's copy would
    // collide with org A's and be discarded.
    const a = await seedMailbox(db, { orgId: "dup_a", domain: "shared.test" });
    const b = await seedMailbox(db, { orgId: "dup_b", domain: "shared.test" });
    for (const org of [a, b]) {
      const t = await seedThread(db, org, {
        addressId: null,
        domainId: org.domainId,
        originalRecipient: "typo@shared.test",
        folder: "unrouted",
      });
      await db.insert(messages).values(
        messageRow(org, t, {
          id: `m_${org.orgId}`,
          addressId: null,
          dedupeScope: "held:typo@shared.test",
          rfcMessageId: "<shared@ext.test>",
        }),
      );
    }
    for (const org of [a, b]) {
      expect(await db.select().from(messages).where(eq(messages.organizationId, org.orgId))).toHaveLength(1);
    }
    const probe = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, b.orgId),
          eq(messages.dedupeScope, "held:typo@shared.test"),
          eq(messages.rfcMessageId, "<shared@ext.test>"),
        ),
      );
    expect(probe).toEqual([{ id: "m_dup_b" }]);
  });

  it("refuses a second domain with the same name in one org", async () => {
    const org = await seedMailbox(db, { orgId: "dup_c", domain: "once.test" });
    expect(
      await failure(db.insert(domains).values({ id: id(), organizationId: org.orgId, name: "once.test" })),
    ).toMatch(/UNIQUE constraint failed/);
  });
});

describe("reply threading is address-scoped", () => {
  it("does not resolve a parent message belonging to another mailbox", async () => {
    // Grants are per-address, so attaching a reply to a thread owned by a
    // different address would expose mail across a permission boundary.
    const one = await seedMailbox(db, { orgId: "thr", domain: "t.test", localPart: "one" });
    const two = { ...one, addressId: id() };
    await db.insert(addresses).values({
      id: two.addressId,
      domainId: one.domainId,
      organizationId: one.orgId,
      localPart: "two",
      createdBy: "owner@example.test",
    });
    const parentThread = await seedThread(db, one, { subject: "Contract" });
    await db.insert(messages).values(messageRow(one, parentThread, { rfcMessageId: "<parent@ext.test>" }));
    const sender = { email: "sender@ext.test", name: null };
    const at = new Date();

    // The same reply delivered to mailbox one joins the parent's thread...
    expect(await resolveThread(db, one.orgId, one.addressId, "Re: Contract", sender, "<parent@ext.test>", null, at)).toBe(
      parentThread,
    );
    // ...while mailbox two starts its own thread instead of joining a foreign one,
    // even with the parent named in both In-Reply-To and References.
    const other = await resolveThread(
      db,
      two.orgId,
      two.addressId,
      "Re: Contract",
      sender,
      "<parent@ext.test>",
      "<parent@ext.test>",
      at,
    );
    expect(other).not.toBe(parentThread);
    const [created] = await db.select().from(threads).where(eq(threads.id, other));
    expect(created?.addressId).toBe(two.addressId);
  });

  it("joins through an older ancestor in References when the parent never arrived", async () => {
    const box = await seedMailbox(db, { orgId: "thr2" });
    const root = await seedThread(db, box, { subject: "Plans" });
    await db.insert(messages).values(messageRow(box, root, { rfcMessageId: "<root@ext.test>" }));
    const joined = await resolveThread(
      db,
      box.orgId,
      box.addressId,
      "Re: Plans",
      { email: "late@ext.test", name: null },
      "<missing@ext.test>",
      "<root@ext.test> <missing@ext.test>",
      new Date(),
    );
    expect(joined).toBe(root);
  });
});

describe("catch-all referential integrity", () => {
  it("nulls the catch-all pointer when its target address is deleted", async () => {
    const org = await seedMailbox(db, { orgId: "ca", domain: "ca.test" });
    await db
      .update(domains)
      .set({ unknownMailPolicy: "catch_all", catchAllAddressId: org.addressId })
      .where(eq(domains.id, org.domainId));

    await db.delete(addresses).where(eq(addresses.id, org.addressId));

    const [domain] = await db.select().from(domains).where(eq(domains.id, org.domainId));
    // Not a dangling id: routing sees a null target and degrades to `hold`,
    // so mail is parked rather than lost.
    expect(domain?.catchAllAddressId).toBeNull();
  });

  it("rejects a catch-all pointing at a non-existent address", async () => {
    const org = await seedMailbox(db, { orgId: "ca2", domain: "ca2.test" });
    expect(
      await failure(db.update(domains).set({ catchAllAddressId: "does-not-exist" }).where(eq(domains.id, org.domainId))),
    ).toMatch(/FOREIGN KEY constraint failed/);
  });
});

describe("keyset pagination", () => {
  it("walks every thread exactly once across pages", async () => {
    const box = await seedMailbox(db, { orgId: "page", domain: "p.test" });
    const base = Date.UTC(2026, 0, 1);
    // Several threads share a lastMessageAt: without the id tiebreaker the
    // cursor stalls or skips inside that group.
    for (let i = 0; i < 25; i++) {
      await seedThread(db, box, { id: `t${String(i).padStart(2, "0")}`, lastMessageAt: new Date(base + Math.floor(i / 5) * 60_000) });
    }

    const seen: string[] = [];
    let raw: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const cursor = parseThreadCursor(raw);
      const conds = [eq(threads.organizationId, box.orgId)];
      // Mirrors routes/threads.ts: the cursor is bound as epoch millis.
      if (cursor) conds.push(sql`(${threads.lastMessageAt}, ${threads.id}) < (${cursor.lastMessageAt.getTime()}, ${cursor.id})`);
      const rows = await db
        .select({ id: threads.id, lastMessageAt: threads.lastMessageAt })
        .from(threads)
        .where(and(...conds))
        .orderBy(desc(threads.lastMessageAt), desc(threads.id))
        .limit(10);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      raw = encodeThreadCursor(rows.at(-1)!);
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe("t24");
    expect(seen.at(-1)).toBe("t00");
  });

  it("treats a malformed cursor as the first page", () => {
    for (const raw of ["", "abc", ".t1", "-5.t1", "NaN.t1", "Infinity.t1", "9007199254740993.t1", "12."]) {
      expect(parseThreadCursor(raw)).toBeNull();
    }
    expect(parseThreadCursor("1700000000000.t.1")).toEqual({ lastMessageAt: new Date(1700000000000), id: "t.1" });
  });
});
