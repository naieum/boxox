import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentRateHits, attachments, auditEvents, messages, operationalEvents, threads } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import { purgeEphemeralRows, RETENTION_TRASH_DAYS, runRetentionPurge } from "../src/services/retention";
import { messageRow, seedMailbox, seedThread } from "./helpers/seed";
import { fakeAi, fakeVectorize } from "./helpers/ai";
import { memoryBudgetStore } from "../src/services/ai";
import { attachmentKey, attachmentTextKey } from "../src/services/attachments";
import { indexMessage, vectorId } from "../src/services/search/indexer";

/**
 * Nothing else deletes from the append-only operational tables or the
 * fixed-window rate-limit table, so without this sweep they grow for the life
 * of the deployment — operational_events gains several rows per inbound email.
 * Runs against a local D1 and R2 with the real migrations.
 */
const DAY = 24 * 3600 * 1000;
let db: Db;

beforeAll(() => {
  db = createDb(env);
});

describe("purgeEphemeralRows", () => {
  const now = Date.UTC(2026, 6, 1);
  const ago = (days: number) => new Date(now - days * DAY);

  beforeAll(async () => {
    await db.insert(operationalEvents).values([
      { id: "op_old", organizationId: "ret", kind: "ingest.delivered", createdAt: ago(120) },
      { id: "op_new", organizationId: "ret", kind: "ingest.delivered", createdAt: ago(10) },
    ]);
    await db.insert(auditEvents).values([
      // Older than operational retention but well inside the audit window —
      // the security record is deliberately kept far longer.
      { id: "au_mid", organizationId: "ret", actorType: "user", action: "key.connected", createdAt: ago(120) },
      { id: "au_old", organizationId: "ret", actorType: "user", action: "key.connected", createdAt: ago(400) },
    ]);
    await db.insert(agentRateHits).values([
      { key: "pair:ip:stale", count: 9, windowStart: now - 5 * DAY },
      { key: "pair:ip:live", count: 1, windowStart: now - 60_000 },
    ]);

    await purgeEphemeralRows(db, now);
  });

  const operational = async () => (await db.select().from(operationalEvents)).map((r) => r.id).sort();

  it("ages out operational events past 90 days", async () => {
    expect(await operational()).toEqual(["op_new"]);
  });

  it("keeps audit events far longer than operational ones", async () => {
    // au_mid is 120 days old — purged from operational_events at that age, but
    // retained here because audit is the incident-investigation record.
    expect((await db.select().from(auditEvents)).map((r) => r.id)).toEqual(["au_mid"]);
  });

  it("drops rate-limit counters whose window has long closed", async () => {
    expect((await db.select().from(agentRateHits)).map((r) => r.key)).toEqual(["pair:ip:live"]);
  });

  it("never deletes a counter for an in-flight window", async () => {
    // Deleting a live window would reset someone's budget mid-attack.
    const [live] = await db.select().from(agentRateHits).where(eq(agentRateHits.key, "pair:ip:live"));
    expect(live?.count).toBe(1);
  });

  it("is safe to run twice", async () => {
    await expect(purgeEphemeralRows(db, now)).resolves.toBeUndefined();
    expect(await operational()).toEqual(["op_new"]);
  });
});

describe("runRetentionPurge", () => {
  const old = () => new Date(Date.now() - (RETENTION_TRASH_DAYS + 1) * DAY);
  const put = (key: string) => env.MAIL_STORE.put(key, `object ${key}`);
  const exists = async (key: string) => (await env.MAIL_STORE.head(key)) !== null;

  it("purges a thread trashed past the window, with its R2 objects", async () => {
    const box = await seedMailbox(db, { orgId: "purge" });
    const threadId = await seedThread(db, box, { folder: "trash", updatedAt: old() });
    const row = messageRow(box, threadId, {
      r2Key: "raw/purge/a.full.json",
      rawMimeKey: "originals/purge/a.eml",
      attachmentsMeta: [{ r2Key: "attachments/purge/a/0-invoice.pdf" }],
    });
    await db.insert(messages).values(row);
    for (const key of ["raw/purge/a.full.json", "raw/purge/a.json", "originals/purge/a.eml", "attachments/purge/a/0-invoice.pdf"]) {
      await put(key);
    }

    await runRetentionPurge({ ...env, VECTORS: undefined });

    expect(await db.select().from(threads).where(eq(threads.id, threadId))).toEqual([]);
    expect(await db.select().from(messages).where(eq(messages.id, row.id))).toEqual([]);
    // The .eml and the raw sibling of a fetched body go too: nothing else references them.
    for (const key of ["raw/purge/a.full.json", "raw/purge/a.json", "originals/purge/a.eml", "attachments/purge/a/0-invoice.pdf"]) {
      expect(await exists(key)).toBe(false);
    }
    const [summary] = await db
      .select()
      .from(operationalEvents)
      .where(eq(operationalEvents.organizationId, "purge"));
    expect(summary?.kind).toBe("retention.trash_purged");
    expect(summary?.detail).toMatchObject({ threads: 1, messages: 1, r2Deleted: 4, r2Failed: 0, r2Shared: 0 });
    // Counts only: no keys or bodies in the operational record.
    expect(JSON.stringify(summary?.detail)).not.toContain("purge/");
  });

  it("keeps a thread trashed recently, so the undo window starts at trash time", async () => {
    const box = await seedMailbox(db, { orgId: "recent" });
    // Old mail, trashed yesterday: lastMessageAt must not be the gate.
    const threadId = await seedThread(db, box, {
      folder: "trash",
      lastMessageAt: new Date(Date.now() - 400 * DAY),
      updatedAt: new Date(Date.now() - DAY),
    });
    await db.insert(messages).values(messageRow(box, threadId, { r2Key: "raw/recent/a.json" }));
    await put("raw/recent/a.json");

    await runRetentionPurge({ ...env, VECTORS: undefined });

    expect(await db.select({ id: threads.id }).from(threads).where(eq(threads.id, threadId))).toEqual([{ id: threadId }]);
    expect(await exists("raw/recent/a.json")).toBe(true);
  });

  it("never purges a thread outside trash, however old", async () => {
    const box = await seedMailbox(db, { orgId: "inbox" });
    const threadId = await seedThread(db, box, { folder: "archive", updatedAt: new Date(Date.now() - 400 * DAY) });
    await db.insert(messages).values(messageRow(box, threadId));

    await runRetentionPurge({ ...env, VECTORS: undefined });

    expect(await db.select({ id: threads.id }).from(threads).where(eq(threads.id, threadId))).toEqual([{ id: threadId }]);
  });

  it("keeps an R2 object another thread still references", async () => {
    // One inbound email routed to two mailboxes shares one body and one .eml.
    const box = await seedMailbox(db, { orgId: "shared" });
    const other = await seedMailbox(db, { orgId: "shared", localPart: "other" });
    const doomed = await seedThread(db, box, { folder: "trash", updatedAt: old() });
    const kept = await seedThread(db, other, { folder: "inbox" });
    const shared = {
      r2Key: "raw/shared/one.json",
      rawMimeKey: "originals/shared/one.eml",
      attachmentsMeta: [{ r2Key: "attachments/shared/one/0-a.png" }],
      rfcMessageId: "<one@ext.test>",
    };
    await db.insert(messages).values(messageRow(box, doomed, shared));
    await db.insert(messages).values(messageRow(other, kept, shared));
    for (const key of ["raw/shared/one.json", "originals/shared/one.eml", "attachments/shared/one/0-a.png"]) await put(key);

    await runRetentionPurge({ ...env, VECTORS: undefined });

    expect(await db.select().from(threads).where(eq(threads.id, doomed))).toEqual([]);
    for (const key of ["raw/shared/one.json", "originals/shared/one.eml", "attachments/shared/one/0-a.png"]) {
      expect(await exists(key)).toBe(true);
    }
    const [summary] = await db.select().from(operationalEvents).where(eq(operationalEvents.organizationId, "shared"));
    expect(summary?.detail).toMatchObject({ threads: 1, r2Deleted: 0, r2Shared: 3 });
  });

  async function indexedMessage(box: Awaited<ReturnType<typeof seedMailbox>>, threadId: string, hash: string, vectors: Vectorize) {
    const row = messageRow(box, threadId, { searchText: "Private attachment invoice", attachmentsMeta: [] });
    await db.insert(messages).values(row);
    await put(row.r2Key!);
    await put(attachmentKey(hash));
    await env.MAIL_STORE.put(attachmentTextKey(hash), "Private extracted invoice text");
    await db.insert(attachments).values({
      id: crypto.randomUUID(), messageId: row.id!, sha256: hash, filename: "invoice.pdf", detectedType: "application/pdf", size: 10, risk: "safe", textR2Key: null,
    });
    const fake = fakeAi((_model, input) => ({ result: { data: (input as { input: string[] }).input.map(() => ({ embedding: Array(1536).fill(0.25) })) } }));
    const ai = Object.assign(fake.ai, { toMarkdown: vi.fn(async () => { throw new Error("conversion cache should already exist"); }) });
    expect(await indexMessage({ db, bucket: env.MAIL_STORE, vectors, ai, consent: { enabled: true, provider: "openai" }, budget: memoryBudgetStore(), dailyBudgetUsd: 1 }, row.id!))
      .toMatchObject({ attachments: 1, vectors: { ok: true, count: 2 } });
    return row;
  }

  it("purges indexed message and attachment vectors plus derived text after the trash window", async () => {
    const box = await seedMailbox(db, { orgId: "derived-purge" });
    const threadId = await seedThread(db, box, { folder: "trash", updatedAt: old() });
    const vectors = fakeVectorize();
    const hash = "a".repeat(64);
    const row = await indexedMessage(box, threadId, hash, vectors.index);
    const before = [vectorId(row.id!), vectorId(row.id!, 0)];
    expect([...vectors.vectors.keys()].sort()).toEqual(before.sort());
    expect(await exists(attachmentTextKey(hash))).toBe(true);
    await db.update(attachments).set({ textR2Key: null }).where(eq(attachments.messageId, row.id!));

    await runRetentionPurge({ ...env, VECTORS: vectors.index });

    expect(await db.select().from(messages).where(eq(messages.id, row.id!))).toEqual([]);
    expect(await db.select().from(attachments).where(eq(attachments.messageId, row.id!))).toEqual([]);
    expect([...vectors.vectors.keys()]).toEqual([]);
    expect(await exists(attachmentKey(hash))).toBe(false);
    expect(await exists(attachmentTextKey(hash))).toBe(false);
    expect(await exists(row.r2Key!)).toBe(false);
  });

  it("keeps content-addressed bytes/text and the survivor's vectors until their last referencing message is purged", async () => {
    const box = await seedMailbox(db, { orgId: "derived-shared" });
    const other = await seedMailbox(db, { orgId: "another-org", localPart: "other" });
    const doomed = await seedThread(db, box, { folder: "trash", updatedAt: old() });
    const kept = await seedThread(db, other, { folder: "inbox" });
    const vectors = fakeVectorize(), hash = "b".repeat(64);
    const deleted = await indexedMessage(box, doomed, hash, vectors.index);
    const survivor = await indexedMessage(other, kept, hash, vectors.index);
    // Cache pointers can be absent even though the content-addressed cache
    // exists; the shared hash itself remains an authoritative reference.
    await db.update(attachments).set({ textR2Key: null }).where(eq(attachments.messageId, survivor.id!));
    await runRetentionPurge({ ...env, VECTORS: vectors.index });

    expect(await exists(attachmentKey(hash))).toBe(true);
    expect(await exists(attachmentTextKey(hash))).toBe(true);
    expect([...vectors.vectors.keys()].sort()).toEqual([vectorId(survivor.id!), vectorId(survivor.id!, 0)].sort());
    expect(await db.select().from(messages).where(eq(messages.id, deleted.id!))).toEqual([]);
    expect(await db.select().from(attachments).where(eq(attachments.messageId, survivor.id!))).toHaveLength(1);

    await db.update(threads).set({ folder: "trash", updatedAt: old() }).where(eq(threads.id, kept));
    await runRetentionPurge({ ...env, VECTORS: vectors.index });
    expect(await exists(attachmentKey(hash))).toBe(false);
    expect(await exists(attachmentTextKey(hash))).toBe(false);
    expect(vectors.vectors.size).toBe(0);
  });

  it("retains purge metadata across a vector deletion failure and retries the same derived artifacts", async () => {
    const box = await seedMailbox(db, { orgId: "derived-retry" });
    const threadId = await seedThread(db, box, { folder: "trash", updatedAt: old() });
    const vectors = fakeVectorize(), hash = "c".repeat(64);
    const row = await indexedMessage(box, threadId, hash, vectors.index);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const unavailable = { ...vectors.index, deleteByIds: async () => { throw new Error("index unavailable"); } } as unknown as Vectorize;
      await runRetentionPurge({ ...env, VECTORS: unavailable });
      expect(await db.select().from(messages).where(eq(messages.id, row.id!))).toHaveLength(1);
      expect(await db.select().from(attachments).where(eq(attachments.messageId, row.id!))).toHaveLength(1);
      expect(await exists(attachmentTextKey(hash))).toBe(true);
      expect(vectors.vectors.size).toBe(2);
      await runRetentionPurge({ ...env, VECTORS: vectors.index });
      expect(await db.select().from(messages).where(eq(messages.id, row.id!))).toEqual([]);
      expect(await exists(attachmentTextKey(hash))).toBe(false);
      expect(vectors.vectors.size).toBe(0);
    } finally { errorLog.mockRestore(); }
  });


  it("keeps attachment references when R2 erasure fails so the next sweep can finish deleting derived text", async () => {
    const box = await seedMailbox(db, { orgId: "derived-r2-retry" });
    const threadId = await seedThread(db, box, { folder: "trash", updatedAt: old() });
    const vectors = fakeVectorize(), hash = "e".repeat(64);
    const row = await indexedMessage(box, threadId, hash, vectors.index);
    const failingBucket = { async delete(key: string) {
      if (key === attachmentTextKey(hash)) throw new Error("temporary object-store outage");
      await env.MAIL_STORE.delete(key);
    } } as unknown as R2Bucket;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runRetentionPurge({ ...env, MAIL_STORE: failingBucket, VECTORS: vectors.index });
      expect(await db.select().from(messages).where(eq(messages.id, row.id!))).toHaveLength(1);
      expect(await db.select().from(attachments).where(eq(attachments.messageId, row.id!))).toHaveLength(1);
      expect(await exists(attachmentTextKey(hash))).toBe(true);
      await runRetentionPurge({ ...env, VECTORS: vectors.index });
      expect(await db.select().from(messages).where(eq(messages.id, row.id!))).toEqual([]);
      expect(await exists(attachmentTextKey(hash))).toBe(false);
    } finally { errorLog.mockRestore(); }
  });

});
