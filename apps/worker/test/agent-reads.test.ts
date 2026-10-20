import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { messages, threads } from "@boxox/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../src/db";
import type { Env } from "../src/env";
import { getAgentMessage, getAgentThread, listAgentChanges, listAgentThreads } from "../src/services/agent-reads";
import { id, messageRow as rawMessageRow, seedMailbox, seedThread } from "./helpers/seed";

const messageRow: typeof rawMessageRow = (box, threadId, over = {}) => rawMessageRow(box, threadId, { scanStatus: "scanned", ...over });

let db: Db;
beforeAll(() => { db = createDb(env); });
const agent = { id: "reader", organizationId: "owner" };
const grantsFor = (addressId: string, classify = false) => [{ addressId, permissions: classify ? ["read", "classify"] : ["read"] }];
async function setup() {
  const box = await seedMailbox(db, { orgId: agent.organizationId });
  return { box, grants: grantsFor(box.addressId) };
}
function bodyStore() {
  const get = vi.fn(async (_key: string) => ({ size: 80_000, json: async () => ({ text: "x".repeat(70_000) }) }));
  return { get, bindings: { ...env, MAIL_STORE: { get } } as unknown as Env };
}

describe("bounded agent reads", () => {
  it("walks more than 100 threads with timestamp ties exactly once", async () => {
    const { box, grants } = await setup();
    const stamp = new Date("2026-10-01T10:00:00Z");
    for (let start = 0; start < 205; start += 5) {
      await db.insert(threads).values(Array.from({ length: Math.min(5, 205 - start) }, (_, i) => ({ id: `${box.addressId}-${String(start + i).padStart(3, "0")}`, organizationId: box.orgId, addressId: box.addressId, lastMessageAt: stamp })));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listAgentThreads(db, agent, grants, box.addressId, { limit: 40, cursor });
      expect(page.threads.length).toBeLessThanOrEqual(40);
      seen.push(...page.threads.map(t => t.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(205);
    expect(new Set(seen).size).toBe(205);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("paginates a long conversation without reading any bodies by default", async () => {
    const { box, grants } = await setup();
    const threadId = await seedThread(db, box);
    const stamp = new Date("2026-10-01T10:00:00Z");
    for (let start = 0; start < 130; start += 3) {
      await db.insert(messages).values(Array.from({ length: Math.min(3, 130 - start) }, (_, i) => messageRow(box, threadId, { id: `${threadId}-${String(start + i).padStart(3, "0")}`, occurredAt: stamp })));
    }
    const store = bodyStore();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getAgentThread(store.bindings, db, agent, grants, threadId, { cursor });
      expect(page.messages.length).toBeLessThanOrEqual(50);
      expect(page.messages.every(m => m.text === null)).toBe(true);
      seen.push(...page.messages.map(m => m.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
    expect(seen).toEqual([...seen].sort());
    expect(store.get).not.toHaveBeenCalled();

    const bodyPage = await getAgentThread(store.bindings, db, agent, grants, threadId, { includeBody: true, limit: 2 });
    expect(store.get).toHaveBeenCalledTimes(2);
    expect(bodyPage.messages.every(m => m.text?.length === 32_768 && m.bodyTruncated)).toBe(true);
    expect(JSON.stringify(bodyPage).length).toBeLessThan(70_000);
    await expect(getAgentThread(store.bindings, db, agent, grants, threadId, { includeBody: true, limit: 11 })).rejects.toMatchObject({ status: 400 });
    const single = await getAgentMessage(store.bindings, db, agent, grants, seen[64]!, { includeBody: true });
    expect(single.message.id).toBe(seen[64]);
    expect(store.get).toHaveBeenCalledTimes(3);
  });

  it("does not load oversized body objects and marks the omission explicitly", async () => {
    const { box, grants } = await setup();
    const threadId = await seedThread(db, box);
    const row = messageRow(box, threadId);
    await db.insert(messages).values(row);
    const json = vi.fn();
    const cancel = vi.fn(async () => {});
    const bindings = { ...env, MAIL_STORE: { get: async () => ({ size: 3_000_000, body: { cancel }, json }) } } as unknown as Env;
    const result = await getAgentMessage(bindings, db, agent, grants, row.id, { includeBody: true });
    expect(result.message).toMatchObject({ text: null, bodyUnavailable: "too_large" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
  });

  it("enforces org, mailbox, and classify policy before reading bodies", async () => {
    const { box, grants } = await setup();
    const other = await seedMailbox(db, { orgId: "another-org" });
    const stranger = await seedThread(db, other);
    const hidden = await seedThread(db, box, { folder: "quarantine" });
    const injected = await seedThread(db, box);
    const row = messageRow(box, injected, { spamVerdict: { ai: { prompt_injection: 0.9 } } });
    await db.insert(messages).values(row);
    const store = bodyStore();
    await expect(getAgentThread(store.bindings, db, agent, grants, stranger)).rejects.toMatchObject({ status: 404 });
    await expect(getAgentThread(store.bindings, db, agent, grants, hidden)).rejects.toMatchObject({ status: 404 });
    await expect(getAgentMessage(store.bindings, db, agent, grants, row.id, { includeBody: true })).rejects.toMatchObject({ status: 404 });
    await expect(listAgentThreads(db, agent, [], box.addressId)).rejects.toMatchObject({ status: 403 });
    expect(store.get).not.toHaveBeenCalled();
    const classified = await getAgentMessage(store.bindings, db, agent, grantsFor(box.addressId, true), row.id, { includeBody: true });
    expect(classified.message.text).toHaveLength(32_768);
  });

  it("rejects malformed, wrong-mailbox, and wrong-thread cursors", async () => {
    const { box, grants } = await setup();
    const other = await seedMailbox(db, { orgId: box.orgId });
    const allGrants = [...grants, ...grantsFor(other.addressId)];
    await seedThread(db, box);
    const tid = await seedThread(db, box);
    const page = await listAgentThreads(db, agent, grants, box.addressId, { limit: 1 });
    expect(page.nextCursor).toBeTruthy();
    await expect(listAgentThreads(db, agent, allGrants, other.addressId, { cursor: page.nextCursor! })).rejects.toMatchObject({ code: "bad_cursor" });
    await expect(getAgentThread(env as Env, db, agent, grants, tid, { cursor: page.nextCursor! })).rejects.toMatchObject({ code: "bad_cursor" });
    await expect(listAgentChanges(db, agent, grants, box.addressId, { cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "bad_cursor" });
    await expect(listAgentThreads(db, agent, grants, box.addressId, { limit: 101 })).rejects.toMatchObject({ status: 400 });
  });
});

describe("durable mailbox changes", () => {
  it("withholds pending inbound mail even from classify and releases completed fallback scans", async () => {
    const { box, grants } = await setup();
    const tid = await seedThread(db, box);
    const pending = messageRow(box, tid, { scanStatus: "pending" });
    await db.insert(messages).values(pending);
    const classifying = grantsFor(box.addressId, true);
    const store = bodyStore();
    expect((await listAgentThreads(db, agent, classifying, box.addressId)).threads).toEqual([]);
    await expect(getAgentMessage(store.bindings, db, agent, classifying, pending.id, { includeBody: true })).rejects.toMatchObject({ status: 404 });
    expect(store.get).not.toHaveBeenCalled();
    const checkpoint = await listAgentChanges(db, agent, grants, box.addressId);
    expect(checkpoint.changes).toEqual([]);
    expect((await listAgentChanges(db, agent, classifying, box.addressId)).changes).toEqual([]);
    await db.update(messages).set({ scanStatus: "unscanned" }).where(eq(messages.id, pending.id));
    const released = await listAgentChanges(db, agent, grants, box.addressId, { cursor: checkpoint.nextCursor });
    expect(released.changes.map(c => c.kind)).toEqual(["message_updated"]);
    expect((await getAgentThread(store.bindings, db, agent, grants, tid)).messages).toHaveLength(1);
    // Outbound messages do not run the inbound scanner.
    await db.insert(messages).values(messageRow(box, tid, { direction: "outbound", scanStatus: "pending" }));
    expect((await listAgentThreads(db, agent, grants, box.addressId)).threads).toHaveLength(1);
  });

  it("replays paginated changes, scopes checkpoints, and ignores read receipt noise", async () => {
    const { box, grants } = await setup();
    const other = await seedMailbox(db, { orgId: "foreign" });
    await seedThread(db, other);
    const tid = await seedThread(db, box);
    const row = messageRow(box, tid);
    await db.insert(messages).values(row);
    await db.update(threads).set({ folder: "archive" }).where(eq(threads.id, tid));
    const first = await listAgentChanges(db, agent, grants, box.addressId, { limit: 1 });
    expect(first.hasMore).toBe(true);
    expect(first.changes).toHaveLength(1);
    expect(await listAgentChanges(db, agent, grants, box.addressId, { limit: 1 })).toEqual(first);
    const second = await listAgentChanges(db, agent, grants, box.addressId, { cursor: first.nextCursor });
    expect(second.changes.map(c => c.kind)).toEqual(["message_created", "thread_updated"]);
    expect(second.changes.every(c => c.threadId === tid)).toBe(true);
    expect(second.hasMore).toBe(false);
    await db.update(threads).set({ unread: false, updatedAt: new Date() }).where(eq(threads.id, tid));
    const idle = await listAgentChanges(db, agent, grants, box.addressId, { cursor: second.nextCursor });
    expect(idle.changes).toEqual([]);
    expect(idle.nextCursor).toEqual(second.nextCursor);
    await expect(listAgentChanges(db, { ...agent, organizationId: "foreign" }, grants, box.addressId, { cursor: second.nextCursor })).rejects.toMatchObject({ code: "bad_cursor" });
    await expect(listAgentChanges(db, agent, [], box.addressId)).rejects.toMatchObject({ status: 403 });
  });

  it("does not skip mail that becomes visible after its earlier event was checkpointed", async () => {
    const { box, grants } = await setup();
    const quarantined = await seedThread(db, box, { folder: "quarantine" });
    const injected = await seedThread(db, box);
    const row = messageRow(box, injected, { spamVerdict: { prompt_injection: 0.8 } });
    await db.insert(messages).values(row);
    const initial = await listAgentChanges(db, agent, grants, box.addressId);
    expect(initial.changes).toEqual([]);
    // The cursor advances past hidden events, without exposing their IDs.
    await db.update(threads).set({ folder: "inbox" }).where(eq(threads.id, quarantined));
    await db.update(messages).set({ spamVerdict: { prompt_injection: 0 } }).where(eq(messages.id, row.id));
    const released = await listAgentChanges(db, agent, grants, box.addressId, { cursor: initial.nextCursor });
    expect(released.changes.map(c => c.threadId)).toEqual([quarantined, injected]);
    expect(released.changes.map(c => c.kind)).toEqual(["thread_updated", "message_updated"]);
    await db.update(messages).set({ spamVerdict: { ai: { prompt_injection: 0.95 } } }).where(eq(messages.id, row.id));
    const replay = await listAgentChanges(db, agent, grants, box.addressId);
    expect(replay.changes.every(c => c.threadId !== injected)).toBe(true);
    const classifyReplay = await listAgentChanges(db, agent, grantsFor(box.addressId, true), box.addressId);
    expect(classifyReplay.changes.some(c => c.threadId === injected)).toBe(true);
    await expect(listAgentChanges(db, agent, grantsFor(box.addressId, true), box.addressId, { cursor: released.nextCursor })).rejects.toMatchObject({ code: "cursor_permissions_changed" });
  });

  it("re-discovers a thread when its flagged message is moved or removed", async () => {
    const { box, grants } = await setup();
    const source = await seedThread(db, box);
    const target = await seedThread(db, box, { folder: "quarantine" });
    const row = messageRow(box, source, { spamVerdict: { prompt_injection: 0.99 } });
    await db.insert(messages).values(row);
    const initial = await listAgentChanges(db, agent, grants, box.addressId);
    expect(initial.changes).toEqual([]);
    await db.update(messages).set({ threadId: target }).where(eq(messages.id, row.id));
    const moved = await listAgentChanges(db, agent, grants, box.addressId, { cursor: initial.nextCursor });
    expect(moved.changes.map(c => c.threadId)).toEqual([source]);
    expect(moved.changes[0]!.kind).toBe("message_removed");
  });

  it("records safe deletion tombstones without leaking hidden thread IDs", async () => {
    const { box, grants } = await setup();
    const visible = await seedThread(db, box);
    const hidden = await seedThread(db, box);
    await db.insert(messages).values(messageRow(box, hidden, { spamVerdict: { prompt_injection: 0.95 } }));
    const start = await listAgentChanges(db, agent, grants, box.addressId);
    await db.delete(threads).where(eq(threads.id, visible));
    await db.delete(threads).where(eq(threads.id, hidden));
    const removed = await listAgentChanges(db, agent, grants, box.addressId, { cursor: start.nextCursor });
    expect(removed.changes.map(c => [c.kind, c.threadId])).toEqual([["thread_deleted", visible]]);
    const raw = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM agent_changes WHERE address_id = ${box.addressId} AND kind = 'thread_deleted'`);
    expect(raw[0]!.n).toBe(2);
  });
});
