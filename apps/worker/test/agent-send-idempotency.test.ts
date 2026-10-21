import { env } from "cloudflare:test";
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { addressGrants, agents, messages } from "@boxox/db";
import { createDb } from "../src/db";
import type { Env } from "../src/env";
import { agent_apiRoutes, type AgentEnv } from "../src/routes/agent-api";
import { mintAgentToken } from "../src/services/agent-auth";
import { organizationSendLimit } from "../src/services/agent-rate-limit";
import { id, seedMailbox } from "./helpers/seed";

const secret = "dGVzdC1hZ2VudC1qd3Qtc2VjcmV0LTMyLWJ5dGVzISE=";
const db = createDb(env);
const app = new Hono<AgentEnv>().use("*", async (c, next) => { c.set("db", createDb(c.env)); await next(); }).route("/", agent_apiRoutes);
beforeAll(() => {});

async function fixture(fail = false) {
  const mailbox = await seedMailbox(db, { orgId: id() });
  const agentId = id();
  await db.insert(agents).values({ id: agentId, organizationId: mailbox.orgId, name: "worker", clientId: id(), clientSecretHash: "unused", sendHourlyCap: 100, sendDailyCap: 1000, createdBy: "owner@example.test" });
  const grantId = id();
  await db.insert(addressGrants).values({ id: grantId, addressId: mailbox.addressId, organizationId: mailbox.orgId, principalType: "agent", principalId: agentId, permissions: ["read", "send_new"], createdBy: "owner@example.test" });
  const calls: unknown[] = [];
  const bindings = { ...env, AGENT_JWT_SECRET: secret, BOXOX_SIGNING_SECRET: secret, EMAIL: { async send(message: unknown) { calls.push(message); if (fail) throw new Error("transport failed"); return { messageId: `<${id()}@test>` }; } } } as unknown as Env;
  const { token } = await mintAgentToken(bindings, agentId, mailbox.orgId);
  const body = { fromAddressId: mailbox.addressId, to: ["customer@example.test"], subject: "Receipt", text: "Order received", idempotencyKey: id() };
  const send = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) => app.request("/send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ ...body, ...over }) }, bindings);
  return { mailbox, agentId, grantId, body, send, calls, bindings };
}

it("replays the same result across client retries without sending or writing another message", async () => {
  const f = await fixture();
  const first = await f.send(); expect(first.status).toBe(200);
  const result = await first.json();
  const again = await f.send(); expect(again.status).toBe(200); expect(await again.json()).toEqual(result);
  expect(f.calls).toHaveLength(1);
  expect(await db.select().from(messages).where(eq(messages.organizationId, f.mailbox.orgId))).toHaveLength(1);
  const [record] = await db.all<{ fingerprint: string; result: string }>(sql`SELECT fingerprint,result FROM agent_send_requests WHERE agent_id=${f.agentId}`);
  expect(record!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(record!.result).not.toContain(f.body.text);
});

it("reserves one send under concurrent identical requests and allows later replay", async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 5 }, () => f.send()));
  expect(results.filter(r => r.status === 200).length).toBeGreaterThanOrEqual(1);
  expect(results.every(r => [200, 409].includes(r.status))).toBe(true);
  expect(f.calls).toHaveLength(1);
  expect((await f.send()).status).toBe(200);
});

it("rejects key reuse with different content or a conflicting HTTP header", async () => {
  const f = await fixture(); expect((await f.send()).status).toBe(200);
  expect((await f.send({ text: "Changed" })).status).toBe(409);
  expect((await f.send({}, { "Idempotency-Key": "other" })).status).toBe(400);
  expect(f.calls).toHaveLength(1);
});

it("accepts an HTTP-only key and rechecks revoked grants before returning a cached result", async () => {
  const f = await fixture();
  expect((await f.send({ idempotencyKey: undefined }, { "Idempotency-Key": "receipt-1" })).status).toBe(200);
  expect((await f.send({ idempotencyKey: undefined }, { "Idempotency-Key": "receipt-1" })).status).toBe(200);
  await db.delete(addressGrants).where(eq(addressGrants.id, f.grantId));
  expect((await f.send({ idempotencyKey: undefined }, { "Idempotency-Key": "receipt-1" })).status).toBe(403);
  expect(f.calls).toHaveLength(1);
});

it("does not retry an ambiguous transport failure under the same key", async () => {
  const f = await fixture(true);
  const first = await f.send(); expect(first.status).toBe(502); const failure = await first.json();
  const retry = await f.send(); expect(retry.status).toBe(502); expect(await retry.json()).toEqual(failure);
  expect(f.calls).toHaveLength(1);
});

it("keeps a crashed pending request reserved instead of sending it again", async () => {
  const f = await fixture(); expect((await f.send()).status).toBe(200);
  await db.run(sql`UPDATE agent_send_requests SET state='pending', result=NULL WHERE agent_id=${f.agentId}`);
  const response = await f.send(); expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "send_state_unknown" } });
  expect(f.calls).toHaveLength(1);
});

it("preserves the unkeyed API and validates owner throughput settings", async () => {
  const f = await fixture();
  expect((await f.send({ idempotencyKey: undefined })).status).toBe(200);
  expect((await f.send({ idempotencyKey: undefined })).status).toBe(200);
  expect(f.calls).toHaveLength(2);
  expect(organizationSendLimit({})).toBe(200);
  expect(organizationSendLimit({ AGENT_SEND_LIMIT_PER_15_MIN: "5000" })).toBe(5000);
  expect(organizationSendLimit({ AGENT_SEND_LIMIT_PER_15_MIN: "-1" })).toBe(200);
});

it("coordinates a shared reply key across authorized agents without crossing mailboxes", async () => {
  const f = await fixture();
  const other = id();
  await db.insert(agents).values({ id: other, organizationId: f.mailbox.orgId, name: "second worker", clientId: id(), clientSecretHash: "unused", createdBy: "owner@example.test" });
  await db.insert(addressGrants).values({ id: id(), addressId: f.mailbox.addressId, organizationId: f.mailbox.orgId, principalType: "agent", principalId: other, permissions: ["read", "send_new"], createdBy: "owner@example.test" });
  const { token } = await mintAgentToken(f.bindings, other, f.mailbox.orgId);
  const first = await f.send({ idempotencyGroup: "support" }); expect(first.status).toBe(200);
  const second = await app.request("/send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...f.body, idempotencyGroup: "support" }) }, f.bindings);
  expect(second.status).toBe(200); expect(await second.json()).toEqual(await first.json());
  expect(f.calls).toHaveLength(1);
  expect((await f.send({ idempotencyKey: undefined, idempotencyGroup: "support" })).status).toBe(400);
});

it("allows the same logical send to retry after a pre-delivery cap refusal", async () => {
  const f = await fixture();
  await db.update(agents).set({ sendHourlyCap: 0 }).where(eq(agents.id, f.agentId));
  expect((await f.send()).status).toBe(429);
  expect(f.calls).toHaveLength(0);
  await db.update(agents).set({ sendHourlyCap: 100 }).where(eq(agents.id, f.agentId));
  expect((await f.send()).status).toBe(200);
  expect(f.calls).toHaveLength(1);
});
