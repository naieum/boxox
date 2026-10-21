import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { apiMessages, domains, webhookDeliveries } from "@boxox/db";
import { createDb } from "../src/db";
import type { Env } from "../src/env";
import type { DevContext } from "../src/dev/auth";
import { authenticateSecret, createDomainKey } from "../src/dev/keys";
import { runApiSend, type ApiSendStep } from "../src/dev/messages";
import { createWebhook, signPayload, type WebhookQueueMessage } from "../src/dev/webhooks";
import { devWebhookRoutes } from "../src/dev/webhooks-routes";
import { trackingRoutes } from "../src/dev/tracking-routes";
import { handleEmailEvents } from "../src/queues/cf-email-events";
import { handleWebhookDeliveries } from "../src/queues/webhook-delivery";

const db = createDb(env);
const open: WebSocket[] = [];
afterEach(() => { for (const ws of open.splice(0)) ws.close(1000, "done"); vi.restoreAllMocks(); });
const step = {
  async do(_name: string, a: unknown, b?: unknown) { return ((typeof a === "function" ? a : b) as () => Promise<unknown>)(); },
  async sleep() {}, async sleepUntil() {},
} as unknown as ApiSendStep;
const id = () => crypto.randomUUID();

async function harness() {
  const domainId = id(), messageId = id(), domain = `${domainId}.test`, r2Key = `fanout/${messageId}`;
  await db.insert(domains).values({ id: domainId, organizationId: "owner", name: domain, sendingEnabled: true });
  await env.MAIL_STORE.put(r2Key, JSON.stringify({ text: "hello", html: '<p>Hello</p><a href="https://shop.test/order?private=token">Order</a>', headers: {}, attachments: [] }));
  await db.insert(apiMessages).values({ id: messageId, domainId, fromEmail: `hello@${domain}`, toEmails: ["person@example.test"], subject: "Fanout", r2Key, trackOpens: true, trackClicks: true });
  const created = await createDomainKey(db, "owner", { type: "owner", email: "owner@example.test" }, { domainId, name: "observer", permissions: ["webhooks"] });
  const key = (await authenticateSecret(db, created.secret))!;
  const hook = await createWebhook({ BOXOX_SIGNING_SECRET: "local-test-signing-secret-0000000000" }, db, key, { url: "https://hooks.example.test/mail", events: [] });
  const queued: WebhookQueueMessage[] = [], sent: EmailMessageBuilder[] = [];
  let failEnqueue = false;
  const binding = {
    async send(body: WebhookQueueMessage) { if (failEnqueue) throw new Error("simulated queue outage"); queued.push(body); },
    async sendBatch(messages: { body: WebhookQueueMessage }[]) { if (failEnqueue) throw new Error("simulated queue outage"); queued.push(...messages.map((m) => m.body)); },
  } as unknown as Queue<WebhookQueueMessage>;
  const bindings = { ...env, WEBHOOK_QUEUE: binding, PUBLIC_URL: "https://mail.test", BOXOX_SIGNING_SECRET: "local-test-signing-secret-0000000000",
    EMAIL: { async send(message: EmailMessageBuilder) { sent.push(message); return { messageId: `<${messageId}@sending.test>` }; } } as unknown as SendEmail,
  };
  const app = new Hono<DevContext>().use("*", async (c, next) => { c.set("db", createDb(c.env)); await next(); })
    .route("/dev/v1/webhooks", devWebhookRoutes);
  const response = await app.request("https://mail.test/dev/v1/webhooks/listen", { headers: { Upgrade: "websocket", authorization: `Bearer ${created.secret}` } }, bindings);
  expect(response.status).toBe(101);
  const ws = response.webSocket!; ws.accept(); open.push(ws);
  const frames: { id: string; payload: string }[] = [], waiters: ((frame: { id: string; payload: string }) => void)[] = [];
  ws.addEventListener("message", (event) => { const frame = JSON.parse(event.data as string); frames.push(frame); waiters.shift()?.(frame); });
  let read = 0;
  function next() {
    const at = read++; if (frames[at]) return Promise.resolve(frames[at]!);
    return new Promise<{ id: string; payload: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("missing production event frame")), 5000);
      waiters.push((frame) => { clearTimeout(timer); resolve(frame); });
    });
  }
  const requests: { body: string; headers: Headers }[] = [];
  async function flush() {
    while (queued.length) {
      let acked = false;
      const body = queued.shift()!;
      await handleWebhookDeliveries({ queue: "webhook-delivery", messages: [{ id: id(), body, ack: () => { acked = true; }, retry: () => { throw new Error("unexpected delivery retry"); } }] } as unknown as MessageBatch<unknown>, bindings, {
        fetch: (async (_url: unknown, init: RequestInit) => { requests.push({ body: String(init.body), headers: new Headers(init.headers) }); return new Response(null, { status: 204 }); }) as typeof fetch,
      });
      expect(acked).toBe(true);
      const request = requests.at(-1)!;
      expect(request.headers.get("webhook-signature")).toBe(await signPayload(hook.secret, request.headers.get("webhook-id")!, Number(request.headers.get("webhook-timestamp")), request.body));
    }
  }
  function cfEvent(type: string, eventId = id()) {
    return { type: `cf.email.sending.message.${type}`, metadata: { eventTimestamp: "2026-10-18T00:00:00Z" },
      payload: { eventId, messageId: `<${messageId}@sending.test>`, sender: `hello@${domain}`, recipient: "person@example.test", bounce: { type: "hard" } } };
  }
  async function deliver(body: unknown) {
    const actions: string[] = [];
    await handleEmailEvents({ queue: "cf-email-events", messages: [{ id: id(), body, ack: () => actions.push("ack"), retry: () => actions.push("retry") }] } as unknown as MessageBatch<unknown>, bindings);
    return actions;
  }
  return { bindings, messageId, hook, frames, next, queued, requests, sent, flush, cfEvent, deliver, failQueue: (value: boolean) => { failEnqueue = value; }, rows: () => db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook.id)) };
}

describe("production developer event fanout", () => {
  it("send completion reaches the authenticated listener and signed HTTP delivery once across replay", async () => {
    const h = await harness();
    expect(await runApiSend(h.bindings, { messageId: h.messageId }, step)).toBe("sent");
    const frame = await h.next(); expect(frame.id).toBe(`sent:${h.messageId}`);
    expect(JSON.parse(frame.payload)).toMatchObject({ type: "message.sent", data: { messageId: h.messageId } });
    await h.flush(); expect(h.requests).toHaveLength(1); expect(h.requests[0]!.body).toBe(frame.payload);
    expect(await runApiSend(h.bindings, { messageId: h.messageId }, step)).toBe("sent");
    expect(h.sent).toHaveLength(1); expect(h.frames).toHaveLength(1); expect(h.queued).toHaveLength(0); expect(await h.rows()).toHaveLength(1);
  });

  it("a permanent send failure publishes message.failed without resending on replay", async () => {
    const h = await harness();
    h.bindings.EMAIL = { async send() { throw Object.assign(new Error("Sender is not verified"), { code: "E_SENDER_NOT_VERIFIED" }); } } as unknown as SendEmail;
    expect(await runApiSend(h.bindings, { messageId: h.messageId }, step)).toBe("failed");
    const frame = await h.next(); expect(frame.id).toBe(`failed:${h.messageId}`);
    expect(JSON.parse(frame.payload)).toMatchObject({ type: "message.failed", data: { reason: "permanent" } });
    await h.flush(); expect(h.requests).toHaveLength(1);
    expect(await runApiSend(h.bindings, { messageId: h.messageId }, step)).toBe("failed");
    expect(h.frames).toHaveLength(1); expect(h.queued).toHaveLength(0); expect(await h.rows()).toHaveLength(1);
  });

  it("delivery, bounce, complaint, defer and failure queue events fan out before ack and deduplicate redelivery", async () => {
    const h = await harness();
    await db.update(apiMessages).set({ status: "sent", sentMessageId: `<${h.messageId}@sending.test>` }).where(eq(apiMessages.id, h.messageId));
    for (const type of ["delivered", "bounced", "complained", "deferred", "failed", "rejected"]) {
      const event = h.cfEvent(type); expect(await h.deliver(event)).toEqual(["ack"]);
      const frame = await h.next(); expect(frame.id).toBe(`cf:${event.payload.eventId}`);
      expect(JSON.parse(frame.payload).type).toBe(`message.${type === "rejected" ? "failed" : type}`);
      const pending = h.queued.length;
      expect(await h.deliver(event)).toEqual(["ack"]); expect(h.queued).toHaveLength(pending);
      await h.flush(); const count = h.frames.length;
      expect(await h.deliver(event)).toEqual(["ack"]); expect(h.frames).toHaveLength(count); expect(h.queued).toHaveLength(0);
    }
    expect(await h.rows()).toHaveLength(6); expect(h.requests).toHaveLength(6);
  });

  it("an enqueue outage retries the upstream event and recovers the existing delivery row", async () => {
    const h = await harness();
    await db.update(apiMessages).set({ status: "sent", sentMessageId: `<${h.messageId}@sending.test>` }).where(eq(apiMessages.id, h.messageId));
    const event = h.cfEvent("delivered"); h.failQueue(true);
    expect(await h.deliver(event)).toEqual(["retry"]); await h.next(); expect(await h.rows()).toHaveLength(1);
    h.failQueue(false); expect(await h.deliver(event)).toEqual(["ack"]); await h.flush();
    expect(h.frames).toHaveLength(1); expect(await h.rows()).toHaveLength(1); expect(h.requests).toHaveLength(1);
  });

  it("signed tracking requests emit sanitized opened/clicked events once per minute", async () => {
    const h = await harness();
    // Avoid a minute boundary making a legitimate new tracking event during the replay assertion.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T00:00:10Z"));
    await runApiSend(h.bindings, { messageId: h.messageId }, step); await h.next(); await h.flush();
    const html = (h.sent[0] as unknown as { html: string }).html;
    const app = new Hono<{ Bindings: Env }>().route("/t", trackingRoutes);
    for (const kind of ["o", "c"]) {
      const token = html.match(new RegExp(`/t/${kind}/([A-Za-z0-9_.-]+)`))![1]!;
      const path = `https://mail.test/t/${kind}/${token}`;
      expect((await app.request(path, {}, h.bindings)).status).toBe(kind === "o" ? 200 : 302);
      const frame = await h.next(); const event = JSON.parse(frame.payload);
      expect(event.type).toBe(kind === "o" ? "message.opened" : "message.clicked"); expect(frame.payload).not.toContain("private=token");
      await h.flush(); const count = h.frames.length;
      await app.request(path, {}, h.bindings); expect(h.frames).toHaveLength(count); expect(h.queued).toHaveLength(0);
    }
    expect(await h.rows()).toHaveLength(3); expect(h.requests).toHaveLength(3);
  });
});
