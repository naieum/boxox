import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { addressGrants, addresses, aiSettings, messages } from "@boxox/db";
import { createDb } from "../src/db";
import type { Env } from "../src/env";
import { requireSameOrigin, type AppContext, type SessionUser } from "../src/middleware";
import { threadRoutes } from "../src/routes/threads";
import { kvBudgetStore, utcDay } from "../src/services/ai";
import { indexStoredMessage } from "../src/services/search/runtime";
import { fakeAi, fakeVectorize } from "./helpers/ai";
import { id, messageRow, seedMailbox, seedThread } from "./helpers/seed";

const db = createDb(env);
const OWNER: SessionUser = { id: "owner@example.test", email: "owner@example.test", name: "Owner", role: "owner" };
const GUEST: SessionUser = { id: "guest@example.test", email: "guest@example.test", name: "Guest", role: "member" };
let user: SessionUser | null = OWNER;
const app = new Hono<AppContext>()
  .use("*", requireSameOrigin)
  .use("*", async (c, next) => {
    c.set("db", createDb(c.env));
    if (user) c.set("user", user);
    await next();
  })
  .route("/api/orgs/:orgId/threads", threadRoutes);

function call(orgId: string, path: string, bindings: Env, method = "POST", origin = "https://mail.test") {
  return app.request(`https://mail.test/api/orgs/${orgId}/threads/${path}`, {
    method,
    headers: { origin, "x-boxox-csrf": "1" },
  }, bindings);
}

async function settings(over: Partial<typeof aiSettings.$inferInsert> = {}) {
  const row = { id: 1, ai: true, provider: "openai" as const, dailyBudgetMicros: 1_000_000, ...over };
  await db.insert(aiSettings).values(row).onConflictDoUpdate({ target: aiSettings.id, set: row });
}

async function mail() {
  const box = await seedMailbox(db, { orgId: id() });
  const threadId = await seedThread(db, box, { subject: "Invoice" });
  const row = messageRow(box, threadId, { subject: "Invoice", searchText: "Please pay invoice tomorrow" });
  await db.insert(messages).values(row);
  return { ...box, threadId, messageId: row.id! };
}

beforeEach(async () => {
  user = OWNER;
  await db.delete(aiSettings);
  await env.KV.delete(`ai-spend:${utcDay()}`);
});

describe("persisted mail AI entrypoints", () => {
  it("indexes stored messages with persisted consent, address opt-outs and shared budget", async () => {
    const item = await mail();
    const ai = fakeAi(() => ({ data: [{ embedding: Array.from({ length: 1536 }, () => 1) }] }));
    const vec = fakeVectorize();
    const bindings = { ...env, AI: ai.ai, VECTORS: vec.index };
    await settings({ ai: false });
    expect((await indexStoredMessage(bindings, item.messageId))?.vectors).toMatchObject({ ok: false, reason: "ai-off" });
    expect(ai.run).not.toHaveBeenCalled();
    await settings();
    expect((await indexStoredMessage(bindings, item.messageId))?.vectors).toEqual({ ok: true, count: 1 });
    expect(vec.vectors.get(item.messageId)?.metadata?.threadId).toBe(item.threadId);
    expect(await kvBudgetStore(env.KV).spent(utcDay())).toBeGreaterThan(0);
    ai.run.mockClear();
    await db.update(addresses).set({ aiOptOut: true }).where(eq(addresses.id, item.addressId));
    expect((await indexStoredMessage(bindings, item.messageId))?.vectors).toMatchObject({ ok: false, reason: "address-opted-out" });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("serves fused search through the real route within the caller's grants and organization", async () => {
    await settings();
    const item = await mail();
    const elsewhere = await mail();
    const semanticId = await seedThread(db, item, { subject: "Payment discussion" });
    const ai = fakeAi(() => ({ data: [{ embedding: new Array(1536).fill(1) }] }));
    const vec = fakeVectorize();
    const bindings = { ...env, AI: ai.ai, VECTORS: vec.index };
    await indexStoredMessage(bindings, item.messageId);
    await vec.index.upsert([
      { id: "semantic-only", values: new Array(1536).fill(1), metadata: { threadId: semanticId } },
      { id: "other-org", values: new Array(1536).fill(1), metadata: { threadId: elsewhere.threadId } },
    ]);
    const res = await call(item.orgId, "search?q=invoice", bindings, "GET");
    const body = await res.json() as { mode: string; threads: { id: string; labels: unknown[] }[] };
    expect(body.mode).toBe("hybrid");
    expect(body.threads.map((t) => t.id)).toEqual([item.threadId, semanticId]);
    expect(body.threads.every((t) => Array.isArray(t.labels))).toBe(true);

    user = GUEST;
    ai.run.mockClear();
    expect(await (await call(item.orgId, "search?q=invoice", bindings, "GET")).json()).toMatchObject({ threads: [] });
    expect(ai.run).not.toHaveBeenCalled();
    await db.insert(addressGrants).values({ id: id(), organizationId: item.orgId, addressId: item.addressId, principalType: "user", principalId: GUEST.id, createdBy: OWNER.id, permissions: ["read"] });
    expect((await (await call(item.orgId, "search?q=invoice", bindings, "GET")).json() as { threads: unknown[] }).threads).toHaveLength(2);
    await db.update(addresses).set({ aiOptOut: true }).where(eq(addresses.id, item.addressId));
    expect((await (await call(item.orgId, "search?q=unmatched", bindings, "GET")).json() as { threads: unknown[] }).threads).toEqual([]);
  });

  it("falls back to FTS search without model calls when AI is off or its budget is spent", async () => {
    const item = await mail();
    const ai = fakeAi(() => { throw new Error("AI must not run"); });
    const bindings = { ...env, AI: ai.ai, VECTORS: fakeVectorize().index };
    for (const config of [{ ai: false }, { dailyBudgetMicros: 0 }]) {
      await settings(config);
      const res = await call(item.orgId, "search?q=invoi", bindings, "GET");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ mode: "keyword", threads: [{ id: item.threadId }] });
    }
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("runs plain-text summaries and replies only through authenticated, read-granted POST actions", async () => {
    await settings({ provider: "cloudflare" });
    const item = await mail();
    const ai = fakeAi((_model, input) => {
      const data = input as { messages: { content: string }[] };
      expect(input).not.toHaveProperty("tools");
      expect(input).not.toHaveProperty("tool_choice");
      return { choices: [{ message: { content: data.messages[0]!.content.includes("summarize") ? "**Invoice** is due <script>bad()</script>tomorrow." : "Thanks, I will review it.\nPlease confirm the amount." }, finish_reason: "stop" }] };
    });
    const bindings = { ...env, AI: ai.ai };
    expect((await call(item.orgId, item.threadId, bindings, "GET")).status).toBe(200);
    expect(ai.run).not.toHaveBeenCalled();
    expect((await call(item.orgId, `${item.threadId}/summary`, bindings, "GET")).status).toBe(404);
    expect((await call(item.orgId, `${item.threadId}/summary`, bindings, "POST", "https://evil.test")).status).toBe(403);
    user = null;
    expect((await call(item.orgId, `${item.threadId}/summary`, bindings)).status).toBe(401);
    user = GUEST;
    expect((await call(item.orgId, `${item.threadId}/summary`, bindings)).status).toBe(403);
    expect((await call("another-org", `${item.threadId}/replies`, bindings)).status).toBe(404);
    expect(ai.run).not.toHaveBeenCalled();

    await db.insert(addressGrants).values({ id: id(), organizationId: item.orgId, addressId: item.addressId, principalType: "user", principalId: GUEST.id, createdBy: OWNER.id, permissions: ["read"] });
    const first = await call(item.orgId, `${item.threadId}/summary`, bindings);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store, private");
    expect(await first.json()).toMatchObject({ summary: "Invoice is due tomorrow.", cached: false });
    expect(await (await call(item.orgId, `${item.threadId}/summary`, bindings)).json()).toMatchObject({ cached: true });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(await (await call(item.orgId, `${item.threadId}/replies`, bindings)).json()).toMatchObject({ replies: ["Thanks, I will review it.", "Please confirm the amount."] });
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("honors revocation, address opt-out and budget for on-demand assistance", async () => {
    const item = await mail();
    const ai = fakeAi();
    const bindings = { ...env, AI: ai.ai };
    for (const [config, code] of [[{ ai: false }, "ai-off"], [{ dailyBudgetMicros: 0 }, "budget-spent"]] as const) {
      await settings(config);
      const res = await call(item.orgId, `${item.threadId}/summary`, bindings);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code } });
    }
    await settings();
    await db.update(addresses).set({ aiOptOut: true }).where(eq(addresses.id, item.addressId));
    expect(await (await call(item.orgId, `${item.threadId}/replies`, bindings)).json()).toMatchObject({ error: { code: "address-opted-out" } });
    expect(ai.run).not.toHaveBeenCalled();
  });
});
