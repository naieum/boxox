import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { addressGrants, agents, auditEvents, messages, threads } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import type { Env } from "../src/env";
import type { AgentEnv } from "../src/routes/agent-api";
import { agentWorkRoutes } from "../src/routes/agent-work";
import { mintAgentToken } from "../src/services/agent-auth";
import { setAgentsKilled } from "../src/services/agent-policy";
import { id, messageRow, seedMailbox, seedThread } from "./helpers/seed";

let db: Db;
const SECRET = "agent-work-secret-synthetic-tests-only";
const testEnv = () => ({ ...env, AGENT_JWT_SECRET: SECRET }) as Env;
const app = new Hono<AgentEnv>().use("*", async (c, next) => { c.set("db", createDb(c.env)); await next(); }).route("/api/agent/v1", agentWorkRoutes);
beforeAll(() => { db = createDb(env); });
async function setup(permissions = ["read"], mailbox?: Awaited<ReturnType<typeof seedMailbox>>) {
  const box = mailbox ?? await seedMailbox(db, { orgId: id() });
  const agentId = id();
  await db.insert(agents).values({ id: agentId, organizationId: box.orgId, name: "worker", clientId: id(), createdBy: "owner@example.test" });
  await db.insert(addressGrants).values({ id: id(), addressId: box.addressId, organizationId: box.orgId, principalType: "agent", principalId: agentId, permissions, createdBy: "owner@example.test" });
  const { token } = await mintAgentToken(testEnv(), agentId, box.orgId);
  return { ...box, mailbox: box, agentId, token };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function message(s: Setup, over: Partial<typeof messages.$inferInsert> = {}, folder: "inbox" | "spam" | "quarantine" | "trash" = "inbox") {
  const threadId = await seedThread(db, s, { folder });
  const row = messageRow(s, threadId, { subject: "Synthetic job", scanStatus: "scanned", occurredAt: new Date("2026-01-01T00:00:00Z"), ...over });
  await db.insert(messages).values(row);
  return { messageId: row.id, threadId };
}
function request(s: Setup, method: string, path: string, body?: unknown) {
  return app.request(`/api/agent/v1${path}`, { method, headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, testEnv());
}
async function claim(s: Setup, messageId: string, extra: Record<string, unknown> = {}) {
  const res = await request(s, "POST", "/work/claim", { messageId, ...extra });
  expect(res.status).toBe(200);
  return await res.json() as any;
}
async function pending(s: Setup, query = "") {
  const res = await request(s, "GET", `/addresses/${s.addressId}/work${query}`);
  expect(res.status).toBe(200);
  return await res.json() as any;
}

describe("durable agent work", () => {
  it("coordinates one shared-group winner under parallel D1 claims, completes idempotently and leaves unread alone", async () => {
    const s = await setup(); const peer = await setup(["read"], s.mailbox); const m = await message(s);
    const responses = await Promise.all([s, peer, s, peer].map((owner) => request(owner, "POST", "/work/claim", { messageId: m.messageId, group: "support" })));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const winnerIndex = responses.findIndex((r) => r.status === 200);
    const winner = winnerIndex % 2 === 0 ? s : peer;
    const loser = winner.agentId === s.agentId ? peer : s;
    const receipt = await responses[winnerIndex]!.json() as any;
    expect((await pending(s, "?group=support")).messages).toEqual([]);
    expect((await request(loser, "POST", "/work/complete", { messageId: m.messageId, claimToken: receipt.claimToken, group: "support" })).status).toBe(409);
    for (let attempt = 0; attempt < 2; attempt++) expect((await request(winner, "POST", "/work/complete", { messageId: m.messageId, claimToken: receipt.claimToken, group: "support" })).status).toBe(200);
    expect((await request(winner, "POST", "/work/claim", { messageId: m.messageId, group: "support" })).status).toBe(409);
    expect((await db.select().from(threads).where(eq(threads.id, m.threadId)))[0]!.unread).toBe(true);
    // Private agent consumers are independent of shared work and one another.
    expect((await pending(peer)).messages).toHaveLength(1);
    await claim(peer, m.messageId);
    expect((await pending(s)).messages).toHaveLength(1);
  });

  it("reclaims expired leases with a new token and refuses stale owners/tokens", async () => {
    const s = await setup(); const peer = await setup(["read"], s.mailbox); const m = await message(s);
    const old = await claim(s, m.messageId, { group: "jobs", leaseSeconds: 30 });
    await db.run(sql`UPDATE agent_work SET lease_until = ${Date.now() - 1} WHERE message_id = ${m.messageId}`);
    expect((await request(s, "POST", "/work/complete", { messageId: m.messageId, claimToken: old.claimToken, group: "jobs" })).status).toBe(409);
    const next = await claim(peer, m.messageId, { group: "jobs" });
    expect(next.claimToken).not.toBe(old.claimToken); expect(next.attempts).toBe(2);
    for (const op of ["complete", "retry", "renew"]) expect((await request(s, "POST", `/work/${op}`, { messageId: m.messageId, claimToken: old.claimToken, group: "jobs" })).status).toBe(409);
    const renew = await request(peer, "POST", "/work/renew", { messageId: m.messageId, claimToken: next.claimToken, group: "jobs", leaseSeconds: 3600 });
    expect(renew.status).toBe(200); expect((await renew.json() as any).claimToken).toBe(next.claimToken);
  });

  it("schedules retries, hides delayed work and prevents completing a released claim", async () => {
    const s = await setup(); const m = await message(s); const r = await claim(s, m.messageId);
    expect((await request(s, "POST", "/work/retry", { messageId: m.messageId, claimToken: r.claimToken, delaySeconds: 100 })).status).toBe(200);
    expect((await pending(s)).messages).toEqual([]);
    expect((await request(s, "POST", "/work/claim", { messageId: m.messageId })).status).toBe(409);
    expect((await request(s, "POST", "/work/complete", { messageId: m.messageId, claimToken: r.claimToken })).status).toBe(409);
    await db.run(sql`UPDATE agent_work SET available_at = 0 WHERE message_id = ${m.messageId}`);
    const next = await claim(s, m.messageId);
    expect(next.attempts).toBe(2);
    expect((await request(s, "POST", "/work/retry", { messageId: m.messageId, claimToken: next.claimToken, delaySeconds: 0 })).status).toBe(200);
    expect((await pending(s)).messages).toHaveLength(1);
  });

  it("paginates equal-timestamp pending metadata without fetching R2 or skipping messages", async () => {
    const s = await setup(); const ids = [];
    for (let n = 0; n < 5; n++) ids.push((await message(s)).messageId);
    const seen = []; let cursor: string | null = null;
    do {
      const page = await pending(s, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...page.messages.map((m: any) => m.messageId));
      expect(page.messages.every((m: any) => m.text === undefined && m.claimToken === undefined)).toBe(true);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids.sort());
    expect((await request(s, "GET", `/addresses/${s.addressId}/work?cursor=broken`)).status).toBe(400);
  });

  it("requires current grants and visibility, isolates organizations, and honors disabling", async () => {
    const s = await setup(); const other = await setup(); const denied = await setup([], s.mailbox);
    const ordinary = await message(s); const r = await claim(s, ordinary.messageId);
    for (const folder of ["spam", "quarantine", "trash"] as const) {
      const m = await message(s, {}, folder);
      expect((await request(s, "POST", "/work/claim", { messageId: m.messageId })).status).toBe(404);
    }
    const injected = await message(s, { spamVerdict: { ai: { prompt_injection: 0.95 } } });
    expect((await request(s, "POST", "/work/claim", { messageId: injected.messageId })).status).toBe(404);
    expect((await request(other, "POST", "/work/claim", { messageId: ordinary.messageId })).status).toBe(404);
    expect((await request(denied, "POST", "/work/claim", { messageId: ordinary.messageId })).status).toBe(403);
    await db.update(addressGrants).set({ permissions: [] }).where(eq(addressGrants.principalId, s.agentId));
    for (const op of ["complete", "renew", "retry"]) expect((await request(s, "POST", `/work/${op}`, { messageId: ordinary.messageId, claimToken: r.claimToken })).status).toBe(403);
    await db.update(addressGrants).set({ permissions: ["read", "classify"] }).where(eq(addressGrants.principalId, s.agentId));
    await claim(s, injected.messageId);
    await db.update(agents).set({ status: "disabled" }).where(eq(agents.id, s.agentId));
    expect((await request(s, "GET", `/addresses/${s.addressId}/work`)).status).toBe(401);
    await setAgentsKilled(db, true);
    try { expect((await request(other, "GET", `/addresses/${other.addressId}/work`)).status).toBe(403); }
    finally { await setAgentsKilled(db, false); }
  });

  it("rechecks classify and folder visibility on renew, retry and acknowledgment and keeps tokens out of audit", async () => {
    const s = await setup(["read", "classify"]);
    const hidden = await message(s, {}, "quarantine");
    const r = await claim(s, hidden.messageId);
    await db.update(addressGrants).set({ permissions: ["read"] }).where(eq(addressGrants.principalId, s.agentId));
    for (const op of ["complete", "renew", "retry"]) expect((await request(s, "POST", `/work/${op}`, { messageId: hidden.messageId, claimToken: r.claimToken })).status).toBe(404);
    await db.update(addressGrants).set({ permissions: ["read", "classify"] }).where(eq(addressGrants.principalId, s.agentId));
    expect((await request(s, "POST", "/work/complete", { messageId: hidden.messageId, claimToken: r.claimToken })).status).toBe(200);
    const ordinary = await message(s); const work = await claim(s, ordinary.messageId);
    await db.update(threads).set({ folder: "trash" }).where(eq(threads.id, ordinary.threadId));
    expect((await request(s, "POST", "/work/complete", { messageId: ordinary.messageId, claimToken: work.claimToken })).status).toBe(404);
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.actorId, s.agentId));
    expect(JSON.stringify(audits)).not.toContain(r.claimToken);
    expect(JSON.stringify(audits)).not.toContain(work.claimToken);
  });

  it("waits for safety scanning before listing, claiming or completing even with classify", async () => {
    const s = await setup(["read", "classify"]); const m = await message(s, { scanStatus: "pending" });
    expect((await pending(s)).messages).toEqual([]);
    expect((await request(s, "POST", "/work/claim", { messageId: m.messageId })).status).toBe(404);
    await db.update(messages).set({ scanStatus: "unscanned" }).where(eq(messages.id, m.messageId));
    expect((await pending(s)).messages).toHaveLength(1);
    const r = await claim(s, m.messageId);
    await db.update(messages).set({ scanStatus: "pending" }).where(eq(messages.id, m.messageId));
    for (const op of ["complete", "renew", "retry"]) expect((await request(s, "POST", `/work/${op}`, { messageId: m.messageId, claimToken: r.claimToken })).status).toBe(404);
    await db.update(messages).set({ scanStatus: "scanned" }).where(eq(messages.id, m.messageId));
    expect((await request(s, "POST", "/work/complete", { messageId: m.messageId, claimToken: r.claimToken })).status).toBe(200);
  });

  it("waits for pending inbound siblings but does not block on outbound scan defaults", async () => {
    const s = await setup(["read", "classify"]); const m = await message(s);
    const sibling = messageRow(s, m.threadId, { scanStatus: "pending" });
    await db.insert(messages).values(sibling);
    expect((await pending(s)).messages).toEqual([]);
    expect((await request(s, "POST", "/work/claim", { messageId: m.messageId })).status).toBe(404);
    await db.update(messages).set({ scanStatus: "scanned" }).where(eq(messages.id, sibling.id));
    const outgoing = messageRow(s, m.threadId, { direction: "outbound", scanStatus: "pending" });
    await db.insert(messages).values(outgoing);
    expect((await pending(s)).messages).toHaveLength(2);
    await claim(s, m.messageId);
    expect((await request(s, "POST", "/work/claim", { messageId: outgoing.id })).status).toBe(404);
  });

  it("bounds batches and returns per-item acknowledgment errors safely", async () => {
    const s = await setup(); const m1 = await message(s); const m2 = await message(s);
    const r1 = await claim(s, m1.messageId); const r2 = await claim(s, m2.messageId);
    const items = [{ messageId: m1.messageId, claimToken: r1.claimToken }, { messageId: m2.messageId, claimToken: "wrong" }];
    const result = await request(s, "POST", "/work/complete-batch", { items });
    expect(result.status).toBe(200);
    expect((await result.json() as any).results).toEqual([{ messageId: m1.messageId, completed: true }, { messageId: m2.messageId, error: { code: "claim_lost", message: expect.any(String) } }]);
    for (const bad of [[], Array.from({ length: 11 }, () => items[0]), [null]]) expect((await request(s, "POST", "/work/complete-batch", { items: bad })).status).toBe(400);
    for (const leaseSeconds of [0, 3601, -1, 1.5]) expect((await request(s, "POST", "/work/claim", { messageId: m2.messageId, leaseSeconds })).status).toBe(400);
    expect((await request(s, "POST", "/work/complete", { messageId: m2.messageId, claimToken: r2.claimToken, group: "agent:forged" })).status).toBe(400);
  });
});
