import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { addresses, apiMessages, attachments, domains, messages, threads, webhookDeliveries, webhooks } from "@boxox/db";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db";
import type { DevContext } from "../src/dev/auth";
import { createDomainKey, revokeKey, type DomainKeyPermission } from "../src/dev/keys";
import { emitReceivedEvent, resolveRawToken } from "../src/dev/received";
import { devReceivedRoutes } from "../src/dev/received-routes";
import { devSuppressionRoutes } from "../src/dev/suppressions-routes";
import { handleEmailEvents } from "../src/queues/cf-email-events";
import { fixture } from "./helpers/fixtures";
import { id } from "./helpers/seed";

/**
 * /dev/v1/received and /dev/v1/suppressions against a local D1 and R2
 * (workerd, via Miniflare) with the real migrations. The workflow and queue
 * bindings are fakes.
 */
const ORG = "owner";
const OWNER = { type: "owner" as const, email: "owner@example.test" };
const PUBLIC_URL = "https://mail.example.test";
const AGENT_JWT_SECRET = "test-only-signing-secret-not-real";

let DB: D1Database;
let MAIL_STORE: R2Bucket;
let db: Db;

beforeAll(() => {
  DB = env.DB;
  MAIL_STORE = env.MAIL_STORE;
  db = createDb({ DB });
});

const app = new Hono<DevContext>()
  .use("*", async (c, next) => {
    c.set("db", db);
    await next();
  })
  .route("/dev/v1/received", devReceivedRoutes)
  .route("/dev/v1/suppressions", devSuppressionRoutes);

function call(method: string, path: string, key?: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { DB, MAIL_STORE, PUBLIC_URL, AGENT_JWT_SECRET },
  );
}

async function seedDomain() {
  const domainId = id();
  const name = `${domainId.slice(0, 8)}.test`;
  await db.insert(domains).values({ id: domainId, organizationId: ORG, name, sendingEnabled: true, receivingEnabled: true });
  return { id: domainId, name };
}

async function seedAddress(domainId: string, localPart: string, deliveryMode: "inbox" | "webhook" | "both") {
  const addressId = id();
  await db.insert(addresses).values({ id: addressId, domainId, organizationId: ORG, localPart, deliveryMode, createdBy: OWNER.email });
  return addressId;
}

/** One stored inbound message, its raw MIME and body JSON in R2. */
async function seedReceived(addressId: string, over: { subject?: string; folder?: "inbox" | "spam" | "quarantine"; at?: Date } = {}) {
  const messageId = id();
  const threadId = id();
  const rawKey = `inbound-20261017-${messageId}`;
  const raw = `From: Customer <customer@ext.test>\r\nTo: support\r\nSubject: ${over.subject ?? "Help"}\r\nMessage-ID: <${messageId}@ext.test>\r\n\r\nPlease help.\r\n`;
  await MAIL_STORE.put(rawKey, raw);
  await MAIL_STORE.put(`body/${rawKey}.json`, JSON.stringify({ text: "Please help.", html: null }));
  await db.insert(threads).values({ id: threadId, organizationId: ORG, addressId, subject: over.subject ?? "Help", folder: over.folder ?? "inbox" });
  await db.insert(messages).values({
    id: messageId,
    threadId,
    organizationId: ORG,
    addressId,
    dedupeScope: addressId,
    direction: "inbound",
    fromEmail: "customer@ext.test",
    fromName: "Customer",
    toEmails: ["support@x.test"],
    subject: over.subject ?? "Help",
    snippet: "Please help.",
    authenticated: true,
    scanStatus: "scanned",
    rfcMessageId: `<${messageId}@ext.test>`,
    r2Key: `body/${rawKey}.json`,
    rawMimeKey: rawKey,
    hasText: true,
    occurredAt: over.at ?? new Date(),
  });
  return { messageId, raw, rawKey };
}

async function domainKey(domainId: string, permissions: DomainKeyPermission[] = ["read_received"], extra: { allowedRecipients?: string[] } = {}) {
  const created = await createDomainKey(db, ORG, OWNER, { name: "app", domainId, permissions, ...extra });
  return { secret: created.secret, id: created.key.id };
}

describe("receiving API", () => {
  it("does not expose pending safety scans through reads or received webhooks", async () => {
    const domain = await seedDomain();
    const address = await seedAddress(domain.id, "support", "both");
    const message = await seedReceived(address);
    await db.update(messages).set({ scanStatus: "pending" }).where(eq(messages.id, message.messageId));
    const key = await domainKey(domain.id);
    const list = await (await call("GET", "/dev/v1/received", key.secret)).json() as { data: unknown[] };
    expect(list.data).toEqual([]);
    expect((await call("GET", `/dev/v1/received/${message.messageId}`, key.secret)).status).toBe(404);
    expect(await emitReceivedEvent({ DB, WEBHOOK_QUEUE: { send: vi.fn() } as unknown as Queue<{ deliveryId: string }> }, message.messageId)).toEqual([]);
  });
  it("lists received mail only for the key's domain", async () => {
    const a = await seedDomain();
    const b = await seedDomain();
    const supportA = await seedAddress(a.id, "support", "both");
    const hooksA = await seedAddress(a.id, "hooks", "webhook");
    const personalA = await seedAddress(a.id, "owner", "inbox");
    const supportB = await seedAddress(b.id, "support", "both");

    const older = await seedReceived(supportA, { subject: "first", at: new Date(Date.now() - 60_000) });
    const newer = await seedReceived(hooksA, { subject: "second" });
    const spam = await seedReceived(supportA, { subject: "spam", folder: "spam", at: new Date(Date.now() - 120_000) });
    const quarantined = await seedReceived(supportA, { folder: "quarantine" });
    const personal = await seedReceived(personalA, { subject: "personal" });
    const other = await seedReceived(supportB, { subject: "other domain" });

    const key = await domainKey(a.id);
    const res = await call("GET", "/dev/v1/received", key.secret);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { data: { id: string; to: string; subject: string; spam: boolean }[]; nextCursor: string | null };
    expect(list.data.map((m) => m.id)).toEqual([newer.messageId, older.messageId, spam.messageId]);
    expect(list.data[0]).toMatchObject({ to: `hooks@${a.name}`, subject: "second", spam: false });
    expect(list.data[2]!.spam).toBe(true);

    // Other domains, non-app inboxes and quarantined mail are not reachable by id either.
    for (const hidden of [other, personal, quarantined]) {
      expect((await call("GET", `/dev/v1/received/${hidden.messageId}`, key.secret)).status).toBe(404);
    }
    const keyB = await domainKey(b.id);
    const listB = (await (await call("GET", "/dev/v1/received", keyB.secret)).json()) as { data: { id: string }[] };
    expect(listB.data.map((m) => m.id)).toEqual([other.messageId]);
    expect((await call("GET", `/dev/v1/received/${older.messageId}`, keyB.secret)).status).toBe(404);

    // Filtering by address, and refusing an address on another domain.
    const filtered = (await (await call("GET", `/dev/v1/received?to=support@${a.name}`, key.secret)).json()) as { data: { id: string }[] };
    expect(filtered.data.map((m) => m.id)).toEqual([older.messageId, spam.messageId]);
    expect((await call("GET", `/dev/v1/received?to=support@${b.name}`, key.secret)).status).toBe(400);

    // Pagination.
    const page1 = (await (await call("GET", "/dev/v1/received?limit=2", key.secret)).json()) as { data: { id: string }[]; nextCursor: string };
    expect(page1.data).toHaveLength(2);
    const page2 = (await (await call("GET", `/dev/v1/received?limit=2&cursor=${page1.nextCursor}`, key.secret)).json()) as { data: { id: string }[]; nextCursor: string | null };
    expect(page2.data.map((m) => m.id)).toEqual([spam.messageId]);
    expect(page2.nextCursor).toBeNull();

    // A key limited to support@ sees only that address.
    const narrow = await domainKey(a.id, ["read_received"], { allowedRecipients: [`support@${a.name}`] });
    const narrowList = (await (await call("GET", "/dev/v1/received", narrow.secret)).json()) as { data: { id: string }[] };
    expect(narrowList.data.map((m) => m.id)).toEqual([older.messageId, spam.messageId]);
    expect((await call("GET", `/dev/v1/received/${newer.messageId}`, narrow.secret)).status).toBe(404);

    // The detail view: parsed fields, authentication and attachments.
    await db.insert(attachments).values({
      id: `att-${older.messageId}-0`,
      messageId: older.messageId,
      sha256: "0".repeat(64),
      filename: "invoice.pdf",
      declaredType: "application/pdf",
      detectedType: "application/pdf",
      size: 10,
      risk: "safe",
    });
    const detail = (await (await call("GET", `/dev/v1/received/${older.messageId}`, key.secret)).json()) as Record<string, any>;
    expect(detail).toMatchObject({
      id: older.messageId,
      to: `support@${a.name}`,
      from: { email: "customer@ext.test", name: "Customer" },
      subject: "first",
      messageId: `<${older.messageId}@ext.test>`,
      authentication: { authenticated: true },
      text: "Please help.",
      hasRaw: true,
    });
    expect(detail.attachments).toEqual([expect.objectContaining({ filename: "invoice.pdf", detectedType: "application/pdf", risk: "safe" })]);
  });

  it("needs a domain key with read_received", async () => {
    const d = await seedDomain();
    const addr = await seedAddress(d.id, "support", "both");
    await seedReceived(addr);
    expect((await call("GET", "/dev/v1/received")).status).toBe(401);
    const sendOnly = await domainKey(d.id, ["send"]);
    expect((await call("GET", "/dev/v1/received", sendOnly.secret)).status).toBe(403);
  });

  it("raw download uses a signed expiring url", async () => {
    const d = await seedDomain();
    const addr = await seedAddress(d.id, "support", "both");
    const msg = await seedReceived(addr);
    const key = await domainKey(d.id);

    const res = await call("GET", `/dev/v1/received/${msg.messageId}/raw?expiresIn=120`, key.secret);
    expect(res.status).toBe(200);
    const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: string };
    expect(url.startsWith(`${PUBLIC_URL}/dev/v1/received/raw/`)).toBe(true);
    const ttl = new Date(expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(100_000);
    expect(ttl).toBeLessThanOrEqual(120_000);

    // The link works without the API key and returns the original bytes.
    const path = new URL(url).pathname;
    const download = await call("GET", path);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("message/rfc822");
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="${msg.messageId}.eml"`);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(new TextDecoder().decode(await download.arrayBuffer())).toBe(msg.raw);

    // Tampering with the payload or the signature breaks it.
    const token = path.split("/").pop()!;
    const [body, mac] = token.split(".");
    const forged = btoa(JSON.stringify({ m: msg.messageId, k: key.id, e: Math.floor(Date.now() / 1000) + 86_400 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect((await call("GET", `/dev/v1/received/raw/${forged}.${mac}`)).status).toBe(404);
    expect((await call("GET", `/dev/v1/received/raw/${body}.${mac!.slice(0, -2)}AA`)).status).toBe(404);
    expect((await call("GET", "/dev/v1/received/raw/not-a-token")).status).toBe(404);

    // It expires.
    const rawEnv = { DB, PUBLIC_URL, AGENT_JWT_SECRET };
    expect(await resolveRawToken(rawEnv, token, Date.now() + 60_000)).not.toBeNull();
    expect(await resolveRawToken(rawEnv, token, Date.now() + 121_000)).toBeNull();
    vi.useFakeTimers({ now: Date.now() + 121_000, toFake: ["Date"] });
    try {
      expect((await call("GET", path)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }

    // The lifetime is capped, and another domain's key can't get a link.
    expect((await call("GET", `/dev/v1/received/${msg.messageId}/raw?expiresIn=86400`, key.secret)).status).toBe(400);
    const other = await seedDomain();
    const otherKey = await domainKey(other.id);
    expect((await call("GET", `/dev/v1/received/${msg.messageId}/raw`, otherKey.secret)).status).toBe(404);

    // Revoking the key kills links it already handed out.
    await revokeKey(db, ORG, OWNER, key.id);
    expect((await call("GET", path)).status).toBe(404);
  });

  it("emits message.received once for an app inbox", async () => {
    const d = await seedDomain();
    const support = await seedAddress(d.id, "support", "both");
    const personal = await seedAddress(d.id, "owner", "inbox");
    const app = await seedReceived(support);
    const mine = await seedReceived(personal);
    const hookId = id();
    await db.insert(webhooks).values({ id: hookId, domainId: d.id, url: "https://hooks.example.test/in", secret: "whsec_dGVzdA==", events: ["message.received"], createdBy: OWNER.email });
    const sent: unknown[] = [];
    const WEBHOOK_QUEUE = { sendBatch: async (m: unknown[]) => void sent.push(...m) } as unknown as Queue<{ deliveryId: string }>;

    expect(await emitReceivedEvent({ DB, WEBHOOK_QUEUE }, app.messageId)).toHaveLength(1);
    expect(await emitReceivedEvent({ DB, WEBHOOK_QUEUE }, app.messageId)).toHaveLength(0);
    expect(await emitReceivedEvent({ DB, WEBHOOK_QUEUE }, mine.messageId)).toHaveLength(0);
    const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hookId));
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as { type: string; data: { id: string; to: string } };
    expect(payload).toMatchObject({ type: "message.received", data: { id: app.messageId, to: `support@${d.name}` } });
    expect(sent).toHaveLength(1);
  });
});

describe("suppressions API", () => {
  it("a hard bounce appears in suppressions", async () => {
    const d = await seedDomain();
    const other = await seedDomain();
    const key = await domainKey(d.id, ["send", "read_log"]);
    const otherKey = await domainKey(other.id, ["send", "read_log"]);

    const sentMessageId = `<${id()}@${d.name}>`;
    await db.insert(apiMessages).values({
      id: id(),
      domainId: d.id,
      apiKeyId: key.id,
      fromEmail: `noreply@${d.name}`,
      toEmails: ["gone@ext.test"],
      subject: "Welcome",
      r2Key: `api/${id()}.json`,
      status: "sent",
      sentMessageId,
    });
    const body = fixture("event-bounced.json").body;
    body.payload.eventId = id();
    body.payload.messageId = sentMessageId;
    body.payload.sender = `noreply@${d.name}`;
    body.payload.recipient = "Gone@ext.test";
    const msgs = [{ id: id(), body, attempts: 1, ack: vi.fn(), retry: vi.fn() }];
    await handleEmailEvents({ queue: "cf-email-events", messages: msgs } as unknown as MessageBatch<unknown>, { DB });
    expect(msgs[0]!.ack).toHaveBeenCalled();

    const res = await call("GET", "/dev/v1/suppressions", key.secret);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { data: { email: string; reason: string; detail: string }[] };
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ email: "gone@ext.test", reason: "bounce" });
    expect(list.data[0]!.detail).toContain("mailbox does not exist");
    expect((await call("GET", "/dev/v1/suppressions/gone@ext.test", key.secret)).status).toBe(200);
    expect(await (await call("GET", "/dev/v1/suppressions?reason=complaint", key.secret)).json()).toMatchObject({ data: [] });

    // Scoped to the domain: the other domain's key sees nothing and can't remove it.
    const otherList = (await (await call("GET", "/dev/v1/suppressions", otherKey.secret)).json()) as { data: unknown[] };
    expect(otherList.data).toEqual([]);
    expect((await call("DELETE", "/dev/v1/suppressions/gone@ext.test", otherKey.secret)).status).toBe(404);

    // Manual add and removal.
    const added = await call("POST", "/dev/v1/suppressions", key.secret, { email: "Manual@Ext.test", detail: "asked to stop" });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ email: "manual@ext.test", reason: "manual" });
    const readOnly = await domainKey(d.id, ["read_log"]);
    expect((await call("DELETE", "/dev/v1/suppressions/gone@ext.test", readOnly.secret)).status).toBe(403);
    const removed = await call("DELETE", "/dev/v1/suppressions/gone@ext.test", key.secret);
    expect(removed.status).toBe(200);
    expect((await call("GET", "/dev/v1/suppressions/gone@ext.test", key.secret)).status).toBe(404);
  });
});
