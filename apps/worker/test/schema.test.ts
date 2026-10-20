import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  addresses,
  apiKeyDomains,
  apiKeys,
  attachments,
  domains,
  drafts,
  idempotencyKeys,
  labels,
  messages,
  threadLabels,
  threads,
} from "@boxox/db";
import { createDb, ftsQuery, searchThreads, type Db } from "../src/db";

/**
 * Runs against a local D1 (workerd, via Miniflare) holding the real
 * migrations, split by readD1Migrations the way `wrangler d1 migrations apply`
 * splits them.
 */
const ORG = "owner";

let DB: D1Database;
let db: Db;

beforeAll(() => {
  DB = env.DB;
  db = createDb({ DB });
});

/** Drizzle wraps D1 errors; the SQLite reason is on the cause. */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} ${e.cause?.message ?? ""}`;
  }
  throw new Error("expected the statement to be rejected");
}

const id = () => crypto.randomUUID();

async function seedDomain(name = `${id()}.test`) {
  const domainId = id();
  await db.insert(domains).values({ id: domainId, organizationId: ORG, name });
  return domainId;
}

async function seedAddress(domainId: string, localPart = "me") {
  const addressId = id();
  await db.insert(addresses).values({
    id: addressId,
    domainId,
    organizationId: ORG,
    localPart,
    createdBy: "owner@example.com",
  });
  return addressId;
}

async function seedThread(addressId: string, subject: string, bodies: string[]) {
  const threadId = id();
  await db.insert(threads).values({ id: threadId, organizationId: ORG, addressId, subject, subjectNorm: subject.toLowerCase() });
  const messageIds: string[] = [];
  for (const body of bodies) {
    const messageId = id();
    messageIds.push(messageId);
    await db.insert(messages).values({
      id: messageId,
      threadId,
      organizationId: ORG,
      addressId,
      direction: "inbound",
      fromEmail: "Alice@Example.com",
      fromName: "Alice Liddell",
      toEmails: ["me@box.test"],
      subject,
      snippet: body.slice(0, 40),
      searchText: body,
      r2Key: `msg/${messageId}`,
      dedupeScope: addressId,
      rfcMessageId: `<${messageId}@example.com>`,
    });
  }
  return { threadId, messageIds };
}

const count = async (table: string, where: string, ...binds: unknown[]) =>
  (await DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).bind(...binds).first<{ n: number }>())!.n;

describe("threads_fts", () => {
  it("threads_fts finds a thread by body text", async () => {
    const domainId = await seedDomain();
    const mine = await seedAddress(domainId, "me");
    const theirs = await seedAddress(domainId, "other");
    const quarterly = await seedThread(mine, "Planning", ["Lunch on Friday?", "The quarterly flamingo budget is attached."]);
    const unrelated = await seedThread(mine, "Flamingo", ["Nothing to see here."]);
    const hidden = await seedThread(theirs, "Budgets", ["Another flamingo budget, in a mailbox we can't read."]);

    const hits = await searchThreads(db, { query: "flamingo budget", addressIds: [mine] });
    expect(hits.map((h) => h.threadId)).toEqual([quarterly.threadId]);
    expect(typeof hits[0]!.rank).toBe("number");

    // Prefix terms, case and diacritics folding; the owner (null scope) sees every mailbox.
    const owner = await searchThreads(db, { query: "FLAMÍNG budg", addressIds: null });
    expect(owner.map((h) => h.threadId).sort()).toEqual([quarterly.threadId, hidden.threadId].sort());

    // Subject matches outrank body-only matches.
    const ranked = await searchThreads(db, { query: "flamingo", addressIds: [mine] });
    expect(ranked.map((h) => h.threadId)).toEqual([unrelated.threadId, quarterly.threadId]);

    // Participants are indexed; FTS syntax in user input is neutralised.
    expect((await searchThreads(db, { query: "liddell", addressIds: [mine] })).length).toBe(2);
    expect(await searchThreads(db, { query: '"* OR NEAR(', addressIds: [mine] })).toEqual([]);
    expect(ftsQuery("  ")).toBeNull();
    expect(await searchThreads(db, { query: "flamingo", addressIds: [] })).toEqual([]);

    // Triggers keep the index in step with updates and deletes.
    await db.update(messages).set({ searchText: "rescheduled to Monday" }).where(eq(messages.id, quarterly.messageIds[1]!));
    expect(await searchThreads(db, { query: "flamingo budget", addressIds: [mine] })).toEqual([]);
    expect((await searchThreads(db, { query: "monday", addressIds: [mine] })).map((h) => h.threadId)).toEqual([
      quarterly.threadId,
    ]);
    await db.delete(messages).where(eq(messages.id, quarterly.messageIds[1]!));
    expect(await searchThreads(db, { query: "monday", addressIds: [mine] })).toEqual([]);
    expect(await count("threads_fts_docs", "message_id = ?", quarterly.messageIds[1])).toBe(0);
  });
});

describe("cascades", () => {
  it("deleting an address cascades to its threads and messages", async () => {
    const domainId = await seedDomain();
    const doomed = await seedAddress(domainId, "doomed");
    const kept = await seedAddress(domainId, "kept");
    const a = await seedThread(doomed, "Walrus", ["walrus one", "walrus two"]);
    const b = await seedThread(doomed, "Walrus again", ["walrus three"]);
    const survivor = await seedThread(kept, "Walrus elsewhere", ["walrus four"]);

    const labelId = id();
    await db.insert(labels).values({ id: labelId, name: `L-${labelId}`, createdBy: "owner@example.com" });
    await db.insert(threadLabels).values([
      { threadId: a.threadId, labelId },
      { threadId: survivor.threadId, labelId },
    ]);
    await db.insert(attachments).values({
      id: id(),
      messageId: a.messageIds[0]!,
      sha256: "ab".repeat(32),
      filename: "invoice.pdf",
      detectedType: "application/pdf",
      size: 10,
      risk: "previewable",
    });
    await db.insert(drafts).values({ id: id(), addressId: doomed, threadId: b.threadId, createdBy: "owner@example.com" });

    const doomedMessages = [...a.messageIds, ...b.messageIds];
    expect(await count("messages", "address_id = ?", doomed)).toBe(3);
    expect(await count("threads_fts_docs", `message_id IN (${doomedMessages.map(() => "?").join(",")})`, ...doomedMessages)).toBe(3);

    await db.delete(addresses).where(eq(addresses.id, doomed));

    expect(await count("threads", "address_id = ?", doomed)).toBe(0);
    expect(await count("messages", "address_id = ?", doomed)).toBe(0);
    expect(await count("messages", "thread_id IN (?, ?)", a.threadId, b.threadId)).toBe(0);
    expect(await count("attachments", "message_id = ?", a.messageIds[0])).toBe(0);
    expect(await count("thread_labels", "thread_id = ?", a.threadId)).toBe(0);
    expect(await count("drafts", "address_id = ?", doomed)).toBe(0);
    // The FTS triggers fire for cascaded deletes too.
    expect(await count("threads_fts_docs", `message_id IN (${doomedMessages.map(() => "?").join(",")})`, ...doomedMessages)).toBe(0);
    expect((await searchThreads(db, { query: "walrus", addressIds: null })).map((h) => h.threadId)).toEqual([
      survivor.threadId,
    ]);

    // Other mailboxes and the label itself are untouched.
    expect(await count("messages", "address_id = ?", kept)).toBe(1);
    expect(await count("labels", "id = ?", labelId)).toBe(1);
    expect(await count("thread_labels", "thread_id = ?", survivor.threadId)).toBe(1);
  });
});

describe("api_keys", () => {
  const key = (over: Partial<typeof apiKeys.$inferInsert>) => ({
    id: id(),
    name: "k",
    secretHash: id(),
    prefix: "bxk_",
    last4: "abcd",
    createdBy: "owner:owner@example.com",
    ...over,
  } as typeof apiKeys.$inferInsert);

  it("api_keys rejects a domain key without a domain", async () => {
    const domainId = await seedDomain();
    const other = await seedDomain();

    expect(await failure(db.insert(apiKeys).values(key({ kind: "domain", domainId: null })))).toMatch(
      /CHECK constraint failed/,
    );
    // Management keys are never bound to a single domain or a parent.
    expect(
      await failure(db.insert(apiKeys).values(key({ kind: "management", prefix: "bxm_", domainId }))),
    ).toMatch(/CHECK constraint failed/);
    expect(await failure(DB.prepare("INSERT INTO api_keys (id, kind, name, secret_hash, prefix, last4, created_by) VALUES (?, 'superuser', 'k', ?, 'x', 'x', 'x')").bind(id(), id()).run())).toMatch(
      /CHECK constraint failed/,
    );

    const owned = key({ kind: "domain", domainId, permissions: ["send"] });
    await db.insert(apiKeys).values(owned);
    expect(await count("api_keys", "id = ? AND domain_id = ?", owned.id, domainId)).toBe(1);

    // A management key mints only for its own domains, within its ceiling.
    const mgmt = key({ kind: "management", prefix: "bxm_" });
    await db.insert(apiKeys).values(mgmt);
    await db.insert(apiKeyDomains).values({ apiKeyId: mgmt.id!, domainId, grantablePermissions: ["send", "read_log"] });

    await db.insert(apiKeys).values(key({ kind: "domain", domainId, parentKeyId: mgmt.id, permissions: ["send"] }));
    expect(
      await failure(db.insert(apiKeys).values(key({ kind: "domain", domainId: other, parentKeyId: mgmt.id, permissions: ["send"] }))),
    ).toMatch(/parent must be a live management key/);
    expect(
      await failure(db.insert(apiKeys).values(key({ kind: "domain", domainId, parentKeyId: mgmt.id, permissions: ["send", "webhooks"] }))),
    ).toMatch(/permissions exceed/);
    expect(
      await failure(db.insert(apiKeys).values(key({ kind: "domain", domainId, parentKeyId: owned.id, permissions: [] }))),
    ).toMatch(/parent must be a live management key/);

    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, mgmt.id!));
    expect(
      await failure(db.insert(apiKeys).values(key({ kind: "domain", domainId, parentKeyId: mgmt.id, permissions: ["send"] }))),
    ).toMatch(/parent must be a live management key/);
    // Revoking the parent leaves existing children working.
    expect(await count("api_keys", "parent_key_id = ? AND revoked_at IS NULL", mgmt.id)).toBe(1);
  });

  it("idempotency key is unique per api key", async () => {
    const domainId = await seedDomain();
    const k1 = key({ kind: "domain", domainId });
    const k2 = key({ kind: "domain", domainId });
    await db.insert(apiKeys).values([k1, k2]);
    const row = (apiKeyId: string) => ({
      id: id(),
      apiKeyId,
      key: "order-1234",
      requestHash: "h1",
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    });

    await db.insert(idempotencyKeys).values(row(k1.id!));
    expect(await failure(db.insert(idempotencyKeys).values(row(k1.id!)))).toMatch(/UNIQUE constraint failed/);

    // The claim path: a concurrent duplicate inserts nothing and must answer 409.
    const claim = await db.insert(idempotencyKeys).values(row(k1.id!)).onConflictDoNothing().returning({ id: idempotencyKeys.id });
    expect(claim).toEqual([]);

    // The same key under a different API key is a different request.
    await db.insert(idempotencyKeys).values(row(k2.id!));
    const rows = await db
      .select({ apiKeyId: idempotencyKeys.apiKeyId, status: idempotencyKeys.status })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, "order-1234"));
    expect(rows.map((r) => r.apiKeyId).sort()).toEqual([k1.id, k2.id].sort());
    expect(rows.every((r) => r.status === "in_progress")).toBe(true);

    // Keys go with their API key.
    await db.delete(apiKeys).where(eq(apiKeys.id, k1.id!));
    expect(await count("idempotency_keys", "api_key_id = ?", k1.id)).toBe(0);
  });
});

describe("columns", () => {
  it("json columns are TEXT queryable with json_*, and raw SQL inserts get timestamps", async () => {
    const domainId = await seedDomain();
    const addressId = await seedAddress(domainId);
    const { messageIds } = await seedThread(addressId, "Cc check", ["hello"]);
    await db.update(messages).set({ ccEmails: ["carol@example.com", "dave@example.com"] }).where(eq(messages.id, messageIds[0]!));

    const hits = await db.all<{ id: string }>(
      sql`SELECT m.id FROM messages m, json_each(m.cc_emails) cc WHERE cc.value = ${"dave@example.com"}`,
    );
    expect(hits.map((h) => h.id)).toEqual([messageIds[0]]);
    const [m] = await db.select({ ccEmails: messages.ccEmails }).from(messages).where(eq(messages.id, messageIds[0]!));
    expect(m!.ccEmails).toEqual(["carol@example.com", "dave@example.com"]);

    const rawId = id();
    await DB.prepare("INSERT INTO domains (id, organization_id, name) VALUES (?, ?, ?)").bind(rawId, ORG, `${rawId}.test`).run();
    const [d] = await db.select().from(domains).where(eq(domains.id, rawId));
    expect(Math.abs(d!.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(d!.unknownMailPolicy).toBe("hold");
  });
});
