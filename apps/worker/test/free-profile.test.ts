import { env, SELF, introspectWorkflowInstance } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { addressGrants, agents, aiSettings, domains, messages } from "@boxox/db";
import worker from "../src/index";
import { createDb } from "../src/db";
import type { Env } from "../src/env";
import type { AppContext } from "../src/middleware";
import { createSetupRoutes } from "../src/routes/setup";
import { sendAgentEmail } from "../src/routes/agent-api";
import { freeRuntime } from "../src/services/capabilities";
import { updateProcessing } from "../src/services/processing";
import { mintAgentToken } from "../src/services/agent-auth";
import { id, seedMailbox } from "./helpers/seed";

const db = createDb(env);
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM ai_settings").run();
  await db.insert(aiSettings).values({ id: 1, localFilters: true, reputationLookups: false, ai: false });
});

describe("Free deployment with paid bindings absent", () => {
  it("serves health through the CPU runtime and keeps owner access closed", async () => {
    expect(env.BOXOX_EDITION).toBe("free");
    for (const name of ["EMAIL", "AI", "BROWSER", "VECTORS", "ANALYTICS", "SEND_WORKFLOW"]) expect((env as unknown as Record<string, unknown>)[name]).toBeUndefined();
    const health = await SELF.fetch("https://box.test/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    const protectedPage = await SELF.fetch("https://box.test/api/me");
    expect(protectedPage.status).toBe(503);
    expect(await protectedPage.json()).toMatchObject({ error: { code: "access_not_configured" } });
  });

  it("parses, stores, scans, indexes, and notifies through real Workflow and Durable Object bindings", async () => {
    const domain = `${id()}.test`;
    const mailbox = await seedMailbox(db, { orgId: "default", domain, localPart: "hello" });
    const rawKey = `free-${id()}`;
    const raw = `From: Sender <sender@outside.test>\r\nTo: hello@${domain}\r\nSubject: Free inbox pipeline\r\nMessage-ID: <${id()}@outside.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA searchable message. ${"mail content ".repeat(12_000)}`;
    await env.MAIL_STORE.put(rawKey, raw, { customMetadata: { to: `hello@${domain}`, from: "sender@outside.test" } });
    const instance = await introspectWorkflowInstance(env.INGEST_WORKFLOW, rawKey);
    try {
      await env.INGEST_WORKFLOW.create({ id: rawKey, params: { rawKey, receivedAt: new Date().toISOString() } });
      await instance.waitForStatus("complete");
      const result = await instance.getOutput() as { status: string; messageId: string; folder: string };
      expect(result.status).toBe("stored");
      const message = await db.query.messages.findFirst({ where: eq(messages.id, result.messageId) });
      expect(message).toMatchObject({ addressId: mailbox.addressId, rawMimeKey: rawKey, scanStatus: "scanned" });
      const enrichment = await introspectWorkflowInstance(env.ENRICH_WORKFLOW!, rawKey);
      try {
        await enrichment.waitForStatus("complete");
        const index = await enrichment.waitForStepResult({ name: "index message for search" });
        expect(index).toMatchObject({ vectors: { ok: false, reason: "no-index" } });
      } finally { await enrichment.dispose(); }
      const fts = await env.DB.prepare("SELECT count(*) AS n FROM threads_fts_docs WHERE message_id = ?").bind(result.messageId).first<{ n: number }>();
      expect(fts?.n).toBe(1);
      expect(await env.MAIL_STORE.head(rawKey)).not.toBeNull();
    } finally { await instance.dispose(); }
  });

  it("accepts a streamed inbound email through the Free edge handler", async () => {
    const domain = `${id()}.test`;
    const box = await seedMailbox(db, { orgId: "default", domain, localPart: "hello" });
    const raw = new TextEncoder().encode(`From: sender@external.test\r\nTo: hello@${domain}\r\nSubject: Streamed Free mail\r\nMessage-ID: <${id()}@external.test>\r\n\r\nEmail through the edge and Durable Object.`);
    let rejection: string | null = null;
    await worker.email({ from: "sender@external.test", to: `hello@${domain}`, headers: new Headers({ from: "sender@external.test" }), raw: new Blob([raw]).stream(), rawSize: raw.length, setReject: (reason: string) => { rejection = reason; } } as ForwardableEmailMessage, env);
    expect(rejection).toBeNull();
    await vi.waitFor(async () => {
      const received = await db.query.messages.findFirst({ where: eq(messages.addressId, box.addressId) });
      expect(received?.subject).toBe("Streamed Free mail");
    }, { timeout: 15_000, interval: 50 });
  });

  it("blocks outgoing API and agent sends before storing mail", async () => {
    const before = await env.DB.prepare("SELECT count(*) AS n FROM messages").first<{ n: number }>();
    for (const path of ["/dev/v1/messages", "/dev/v1/messages/batch", "/api/agent/v1/send"]) {
      const response = await SELF.fetch(`https://box.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "feature_unavailable" } });
    }
    await expect(sendAgentEmail(env, db, "default", "unused", [], { fromAddressId: "unused", to: ["outside@example.test"], subject: "No send", text: "No send" })).rejects.toMatchObject({ code: "feature_unavailable" });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM messages").first()).toEqual(before);
  });

  it("rejects AI enablement without changing the saved setting or calling a provider", async () => {
    await expect(updateProcessing(db, env, { ai: true, provider: "cloudflare" }, async () => { throw new Error("must not call Cloudflare"); })).rejects.toMatchObject({ code: "feature_unavailable" });
    expect((await db.query.aiSettings.findFirst())?.ai).toBe(false);
  });

  it("does not expose internal runtime RPC methods as public HTTP routes", async () => {
    for (const path of ["/receive", "/parse", "/scheduled", "/deliverWebhook"]) {
      const response = await SELF.fetch(`https://box.test${path}`, { method: "POST", body: "{}" });
      expect(response.status).toBe(503);
    }
  });

  it("keeps MCP reading available while omitting and refusing the send tool", async () => {
    const mailbox = await seedMailbox(db, { orgId: "default", domain: `${id()}.test` });
    const agentId = id();
    await db.insert(agents).values({ id: agentId, organizationId: "default", name: "Reader", clientId: id(), createdBy: "owner@example.test" });
    await db.insert(addressGrants).values({ id: id(), organizationId: "default", addressId: mailbox.addressId, principalType: "agent", principalId: agentId, permissions: ["read", "send_new"], createdBy: "owner@example.test" });
    const { token } = await mintAgentToken(env, agentId, "default");
    async function rpc(method: string, params = {}) {
      const response = await SELF.fetch("https://box.test/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      expect(response.status).toBe(200);
      const text = await response.text();
      return JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text);
    }
    const list = await rpc("tools/list");
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain("list_threads");
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("send_email");
    const read = await rpc("tools/call", { name: "list_addresses", arguments: {} });
    expect(read.result.isError).not.toBe(true);
    const send = await rpc("tools/call", { name: "send_email", arguments: { fromAddressId: mailbox.addressId, to: ["recipient@example.test"], subject: "No send", text: "No send" } });
    expect(send.result.isError).toBe(true);
  });
});

describe("Free domain setup", () => {
  it("requires MX confirmation and enables receiving without Email Sending or delivery-event subscriptions", async () => {
    const calls: string[] = [];
    const zone = { id: "free-zone", name: `${id()}.test`, status: "active", account: { id: "free-account" } };
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/client/v4", "");
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (path.includes("/sending") || path.includes("/queues") || path.includes("/event_subscriptions")) throw new Error("Free must not configure sending");
      let result: unknown = {};
      if (path === "/zones") result = [zone];
      else if (path.endsWith("/dns_records") && url.searchParams.get("type") === "MX") result = [{ id: "old-mx", name: zone.name, type: "MX", content: "mx.old-provider.test", priority: 10, ttl: 1 }];
      else if (path.endsWith("/dns_records")) result = [];
      else if (path.endsWith("/email/routing") || path.endsWith("/email/routing/enable")) result = { enabled: true, status: "ready" };
      return Response.json({ success: true, errors: [], result });
    }) as typeof fetch;
    const app = new Hono<AppContext>().use("*", async (c, next) => {
      c.set("db", db); c.set("user", { id: "owner@example.test", email: "owner@example.test", name: "Owner", role: "owner" }); await next();
    }).route("/setup", createSetupRoutes({ fetch: fake }));
    const bindings: Env = { ...env, CF_API_TOKEN: "test-only", CF_ACCOUNT_ID: "free-account" };
    const onboard = (confirm: boolean) => app.request("/setup/domains", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain: zone.name, receive: true, confirmMxReplacement: confirm }) }, bindings);
    expect((await onboard(false)).status).toBe(409);
    expect(calls.some(call => call.startsWith("DELETE"))).toBe(false);
    const response = await onboard(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ domain: { sendingEnabled: false, receivingEnabled: true }, sending: null, subscriptionId: null });
    expect((await db.query.domains.findFirst({ where: eq(domains.name, zone.name) }))?.sendingEnabled).toBe(false);
    expect(calls.some(call => call.startsWith("DELETE"))).toBe(true);
  });
});
