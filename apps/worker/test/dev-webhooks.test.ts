import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { domains, webhookDeliveries, webhooks } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import type { DevContext } from "../src/dev/auth";
import { createDomainKey } from "../src/dev/keys";
import {
  AUTO_DISABLE_AFTER,
  checkTargetUrl,
  emitWebhookEvent,
  isSealedWebhookSecret,
  MAX_ATTEMPTS,
  resealWebhookSecrets,
  RETRY_SCHEDULE_MS,
  signatureHeaders,
  signPayload,
  unsealWebhookSecret,
  type AttemptLogEntry,
  type WebhookQueueMessage,
} from "../src/dev/webhooks";
import { devWebhookRoutes } from "../src/dev/webhooks-routes";
import { handleWebhookDeliveries } from "../src/queues/webhook-delivery";

/**
 * /dev/v1/webhooks and the webhook-delivery consumer against a local D1
 * (workerd, via Miniflare) with the real migrations. The queue and the
 * receiving endpoint are fakes that record what was sent.
 */
const ORG = "owner";
const OWNER = { type: "owner" as const, email: "owner@example.test" };

let DB: D1Database;
let db: Db;

beforeAll(() => {
  DB = env.DB;
  db = createDb({ DB });
});

/** Holds sent messages until `next()` hands them to the consumer. */
function fakeQueue() {
  const pending: { body: WebhookQueueMessage; delaySeconds?: number }[] = [];
  const sent: { body: WebhookQueueMessage; delaySeconds?: number }[] = [];
  const binding = {
    async send(body: WebhookQueueMessage, opts?: { delaySeconds?: number }) {
      const m = { body, delaySeconds: opts?.delaySeconds };
      pending.push(m);
      sent.push(m);
    },
    async sendBatch(msgs: { body: WebhookQueueMessage }[]) {
      for (const m of msgs) await binding.send(m.body);
    },
  };
  return { pending, sent, binding: binding as unknown as Queue<WebhookQueueMessage> };
}

/** A receiving endpoint that answers with `status` and records every request. */
function fakeEndpoint(status: number | (() => number)) {
  const requests: { url: string; headers: Headers; body: string }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: new Headers(init.headers), body: String(init.body) });
    return new Response("not logged", { status: typeof status === "function" ? status() : status });
  }) as unknown as typeof globalThis.fetch;
  return { requests, fetch, set: (s: number) => (status = s) };
}

function harness() {
  const queue = fakeQueue();
  const env = { DB, WEBHOOK_QUEUE: queue.binding, BOXOX_SIGNING_SECRET: "local-test-signing-secret-0000000000" };
  let clock = Date.parse("2026-10-01T00:00:00Z");
  /** Runs the next queued message through the consumer, with the clock at its delay. */
  async function next(endpoint: ReturnType<typeof fakeEndpoint>) {
    const m = queue.pending.shift();
    if (!m) throw new Error("queue is empty");
    clock += (m.delaySeconds ?? 0) * 1000;
    const acked: string[] = [];
    const batch = {
      queue: "webhook-delivery",
      messages: [{ id: crypto.randomUUID(), body: m.body, ack: () => acked.push("ack"), retry: () => acked.push("retry") }],
    } as unknown as MessageBatch<unknown>;
    await handleWebhookDeliveries(batch, env, { fetch: endpoint.fetch, now: () => clock });
    expect(acked).toEqual(["ack"]);
    return m;
  }
  return { queue, env, next, now: () => clock };
}

const app = new Hono<DevContext>()
  .use("*", async (c, next) => {
    c.set("db", db);
    await next();
  })
  .route("/dev/v1/webhooks", devWebhookRoutes);

async function seedDomain() {
  const domainId = crypto.randomUUID();
  await db.insert(domains).values({ id: domainId, organizationId: ORG, name: `${domainId.slice(0, 8)}.test`, sendingEnabled: true });
  return domainId;
}

async function domainKey(domainId: string, permissions = ["webhooks"]) {
  const created = await createDomainKey(db, ORG, OWNER, {
    name: "app",
    domainId,
    permissions: permissions as "webhooks"[],
  });
  return created.secret;
}

function call(env: object, method: string, path: string, key: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

type WebhookJson = { id: string; url: string; status: string; secret?: string; consecutiveFailures: number };

async function setup(url = "https://hooks.example.com/boxox") {
  const h = harness();
  const domainId = await seedDomain();
  const key = await domainKey(domainId);
  const res = await call(h.env, "POST", "/dev/v1/webhooks", key, { url, events: ["message.delivered"] });
  expect(res.status).toBe(201);
  const hook = (await res.json()) as WebhookJson;
  return { ...h, domainId, key, hook };
}

async function deliveryRows(webhookId: string) {
  return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, webhookId));
}

async function verify(secret: string, req: { headers: Headers; body: string }) {
  const id = req.headers.get("webhook-id")!;
  const ts = Number(req.headers.get("webhook-timestamp"));
  const expected = await signPayload(secret, id, ts, req.body);
  return req.headers.get("webhook-signature")!.split(" ").includes(expected);
}

describe("dev webhooks", () => {
  it("stores signing secrets encrypted, re-seals legacy rows, and never sends unsigned", async () => {
    const s = await setup();
    const [row] = await db.select().from(webhooks).where(eq(webhooks.id, s.hook.id));
    expect(isSealedWebhookSecret(row!.secret)).toBe(true);
    expect(row!.secret).not.toContain(s.hook.secret!.slice("whsec_".length));
    expect(await unsealWebhookSecret(s.env, row!.secret)).toBe(s.hook.secret);
    expect(await unsealWebhookSecret({}, row!.secret)).toBeNull();

    // A row written before sealing existed is readable as it is, and the sweep encrypts it.
    const legacy = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    await db.update(webhooks).set({ secret: legacy }).where(eq(webhooks.id, s.hook.id));
    expect(await resealWebhookSecrets(s.env, db)).toBeGreaterThanOrEqual(1);
    const [sealed] = await db.select().from(webhooks).where(eq(webhooks.id, s.hook.id));
    expect(isSealedWebhookSecret(sealed!.secret)).toBe(true);
    expect(sealed!.secret).not.toContain(legacy.slice("whsec_".length));
    expect(await unsealWebhookSecret(s.env, sealed!.secret)).toBe(legacy);
    expect(await resealWebhookSecrets(s.env, db)).toBe(0);

    // Deliveries sign with the decrypted value.
    await emitWebhookEvent(s.env, s.domainId, "message.delivered", { id: "m-sealed" });
    const ok = fakeEndpoint(200);
    await s.next(ok);
    expect(await verify(legacy, ok.requests[0]!)).toBe(true);
    expect((await deliveryRows(s.hook.id)).map((d) => d.status)).toEqual(["succeeded"]);

    // Without the key the delivery is held back rather than sent without a signature.
    await emitWebhookEvent(s.env, s.domainId, "message.delivered", { id: "m-unsigned" });
    const m = s.queue.pending.shift()!;
    const silent = fakeEndpoint(204);
    const batch = { queue: "webhook-delivery", messages: [{ id: crypto.randomUUID(), body: m.body, ack: () => {}, retry: () => {} }] } as unknown as MessageBatch<unknown>;
    await handleWebhookDeliveries(batch, { DB, WEBHOOK_QUEUE: s.queue.binding }, { fetch: silent.fetch, now: s.now });
    expect(silent.requests).toHaveLength(0);
    const [delivery] = (await deliveryRows(s.hook.id)).filter((d) => d.status === "pending" && d.attempts === 1);
    expect((delivery!.attemptLog as AttemptLogEntry[]).at(-1)?.error).toBe("signing secret unavailable");
  });

  it("signatures match the Standard Webhooks test vectors", async () => {
    // From the Standard Webhooks spec's reference test suite.
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const id = "msg_p5jXN8AQM9LWM0D4loKWxJek";
    const ts = 1614265330;
    const body = '{"test": 2432232314}';
    expect(await signPayload(secret, id, ts, body)).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
    expect(await signPayload(secret, id, ts, '{"test": 2432232315}')).not.toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
    expect(await signatureHeaders([secret], id, ts, body)).toEqual({
      "webhook-id": id,
      "webhook-timestamp": "1614265330",
      "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    });

    // A real delivery is signed the same way with the endpoint's secret.
    const s = await setup();
    expect(s.hook.secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    const listed = (await (await call(s.env, "GET", `/dev/v1/webhooks/${s.hook.id}`, s.key)).json()) as WebhookJson;
    expect(listed.secret).toBeUndefined();
    await emitWebhookEvent(s.env, s.domainId, "message.delivered", { id: "m1" });
    const ok = fakeEndpoint(204);
    await s.next(ok);
    const req = ok.requests[0]!;
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(Number(req.headers.get("webhook-timestamp"))).toBe(Math.floor(s.now() / 1000));
    expect(await verify(s.hook.secret!, req)).toBe(true);
    expect(JSON.parse(req.body)).toMatchObject({ type: "message.delivered", data: { id: "m1" } });

    // After rotation both secrets sign until the overlap ends.
    const rotated = (await (await call(s.env, "POST", `/dev/v1/webhooks/${s.hook.id}/rotate`, s.key, { overlapHours: 24 })).json()) as WebhookJson;
    expect(rotated.secret).not.toBe(s.hook.secret);
    await emitWebhookEvent(s.env, s.domainId, "message.delivered", { id: "m2" });
    await s.next(ok);
    const rotatedReq = ok.requests[1]!;
    expect(rotatedReq.headers.get("webhook-signature")!.split(" ")).toHaveLength(2);
    expect(await verify(rotated.secret!, rotatedReq)).toBe(true);
    expect(await verify(s.hook.secret!, rotatedReq)).toBe(true);
    expect(await verify("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", rotatedReq)).toBe(false);
  });

  it("retries follow the backoff schedule", async () => {
    const s = await setup();
    const failing = fakeEndpoint(503);
    const [deliveryId] = await emitWebhookEvent(s.env, s.domainId, "message.delivered", { id: "m1" });
    expect(deliveryId).toBeDefined();
    // Not subscribed to this type: no delivery.
    expect(await emitWebhookEvent(s.env, s.domainId, "message.opened", { id: "m1" })).toEqual([]);

    const delays: (number | undefined)[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) delays.push((await s.next(failing)).delaySeconds);
    expect(s.queue.pending).toHaveLength(0);

    expect(MAX_ATTEMPTS).toBe(8);
    expect(delays).toEqual([undefined, 5, 300, 1800, 7200, 18000, 36000, 36000]);
    expect(delays.slice(1)).toEqual(RETRY_SCHEDULE_MS.slice(1).map((ms) => ms / 1000));
    expect(failing.requests).toHaveLength(8);
    // Same webhook-id on every attempt, so receivers can dedupe.
    expect(new Set(failing.requests.map((r) => r.headers.get("webhook-id"))).size).toBe(1);

    const [row] = await deliveryRows(s.hook.id);
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(8);
    expect(row!.lastStatusCode).toBe(503);
    expect(row!.nextAttemptAt).toBeNull();
    const attemptLog = row!.attemptLog as AttemptLogEntry[];
    expect(attemptLog).toHaveLength(8);
    expect(attemptLog.every((a) => a.status === 503 && a.error === "HTTP 503")).toBe(true);
    expect(JSON.stringify(attemptLog)).not.toContain("not logged");
  });

  it("a failed delivery can be replayed", async () => {
    const s = await setup();
    const endpoint = fakeEndpoint(500);
    const [deliveryId] = await emitWebhookEvent(s.env, s.domainId, "message.delivered", { id: "m1" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await s.next(endpoint);
    const base = `/dev/v1/webhooks/${s.hook.id}/deliveries/${deliveryId}`;
    const failed = (await (await call(s.env, "GET", base, s.key)).json()) as { status: string; attemptLog: unknown[] };
    expect(failed.status).toBe("failed");
    expect(failed.attemptLog).toHaveLength(8);

    const replay = await call(s.env, "POST", `${base}/replay`, s.key);
    expect(replay.status).toBe(202);
    expect(((await replay.json()) as { status: string }).status).toBe("pending");
    expect(s.queue.pending).toEqual([{ body: { deliveryId }, delaySeconds: undefined }]);
    // A second replay while the first is in flight is refused.
    expect((await call(s.env, "POST", `${base}/replay`, s.key)).status).toBe(409);

    endpoint.set(200);
    await s.next(endpoint);
    const done = (await (await call(s.env, "GET", base, s.key)).json()) as {
      status: string;
      attempts: number;
      deliveredAt: string | null;
      attemptLog: AttemptLogEntry[];
    };
    expect(done.status).toBe("succeeded");
    expect(done.deliveredAt).not.toBeNull();
    expect(done.attempts).toBe(1);
    expect(done.attemptLog).toHaveLength(10);
    expect(done.attemptLog[8]!.replay).toBe(true);
    expect(done.attemptLog[9]!.status).toBe(200);
    const ids = endpoint.requests.map((r) => r.headers.get("webhook-id"));
    expect(ids.at(-1)).toBe(ids[0]);
    expect(endpoint.requests.at(-1)!.body).toBe(endpoint.requests[0]!.body);

    // Another domain's key can't see or replay it.
    const otherKey = await domainKey(await seedDomain());
    expect((await call(s.env, "POST", `${base}/replay`, otherKey)).status).toBe(404);
  });

  it("only https targets are accepted", async () => {
    const h = harness();
    const key = await domainKey(await seedDomain());
    const rejected = [
      "http://hooks.example.com/boxox",
      "ftp://hooks.example.com/boxox",
      "https://user:pw@hooks.example.com/boxox",
      "https://localhost/hook",
      "https://api.localhost/hook",
      "https://printer.local/hook",
      "https://metadata.internal/hook",
      "https://intranet/hook",
      "https://127.0.0.1/hook",
      "https://10.1.2.3/hook",
      "https://172.20.0.1/hook",
      "https://192.168.1.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://[fd00::1]/hook",
      "https://[::ffff:10.0.0.1]/hook",
      "not a url",
    ];
    for (const url of rejected) {
      const res = await call(h.env, "POST", "/dev/v1/webhooks", key, { url });
      expect(res.status, url).toBeGreaterThanOrEqual(400);
      expect(res.status, url).toBeLessThan(500);
      expect(checkTargetUrl(url), url).not.toBeNull();
    }
    const ok = await call(h.env, "POST", "/dev/v1/webhooks", key, { url: "https://hooks.example.com:8443/boxox?x=1" });
    expect(ok.status).toBe(201);
    const hook = (await ok.json()) as WebhookJson;

    const downgrade = await call(h.env, "PATCH", `/dev/v1/webhooks/${hook.id}`, key, { url: "http://hooks.example.com/boxox" });
    expect(downgrade.status).toBe(422);
    expect(((await downgrade.json()) as { error: { code: string } }).error.code).toBe("invalid_url");
    const [stored] = await db.select().from(webhooks).where(eq(webhooks.id, hook.id));
    expect(stored!.url).toBe("https://hooks.example.com:8443/boxox?x=1");

    // A stored http URL (e.g. written before validation) is never fetched.
    await db.update(webhooks).set({ url: "http://hooks.example.com/boxox" }).where(eq(webhooks.id, hook.id));
    await emitWebhookEvent(h.env, stored!.domainId, "message.delivered", {});
    const endpoint = fakeEndpoint(200);
    await h.next(endpoint);
    expect(endpoint.requests).toHaveLength(0);
    const [row] = await deliveryRows(hook.id);
    expect((row!.attemptLog as AttemptLogEntry[])[0]!.error).toBe("Webhook URLs must use https");
  });

  it("an endpoint is disabled after repeated failures", async () => {
    const s = await setup();
    const endpoint = fakeEndpoint(500);
    const fail = async () => {
      await emitWebhookEvent(s.env, s.domainId, "message.delivered", {});
      for (let i = 0; i < MAX_ATTEMPTS; i++) await s.next(endpoint);
    };
    const state = async () => (await db.select().from(webhooks).where(eq(webhooks.id, s.hook.id)))[0]!;

    // A success in between resets the count.
    for (let i = 0; i < AUTO_DISABLE_AFTER - 1; i++) await fail();
    expect((await state()).consecutiveFailures).toBe(AUTO_DISABLE_AFTER - 1);
    endpoint.set(200);
    await emitWebhookEvent(s.env, s.domainId, "message.delivered", {});
    await s.next(endpoint);
    expect((await state()).consecutiveFailures).toBe(0);
    expect((await state()).status).toBe("active");

    endpoint.set(500);
    for (let i = 0; i < AUTO_DISABLE_AFTER - 1; i++) await fail();
    expect((await state()).status).toBe("active");
    await fail();
    const disabled = await state();
    expect(disabled.status).toBe("disabled");
    expect(disabled.disabledAt).not.toBeNull();
    expect(disabled.consecutiveFailures).toBe(AUTO_DISABLE_AFTER);

    // Disabled endpoints get no new deliveries, can't be tested or replayed.
    const requests = endpoint.requests.length;
    expect(await emitWebhookEvent(s.env, s.domainId, "message.delivered", {})).toEqual([]);
    expect(s.queue.pending).toHaveLength(0);
    expect(endpoint.requests).toHaveLength(requests);
    expect((await call(s.env, "POST", `/dev/v1/webhooks/${s.hook.id}/test`, s.key)).status).toBe(409);
    const shown = (await (await call(s.env, "GET", `/dev/v1/webhooks/${s.hook.id}`, s.key)).json()) as WebhookJson;
    expect(shown.status).toBe("disabled");

    // Re-enabling starts a fresh count and deliveries resume.
    const enabled = await call(s.env, "PATCH", `/dev/v1/webhooks/${s.hook.id}`, s.key, { enabled: true });
    expect(((await enabled.json()) as WebhookJson).consecutiveFailures).toBe(0);
    endpoint.set(200);
    const test = await call(s.env, "POST", `/dev/v1/webhooks/${s.hook.id}/test`, s.key);
    expect(test.status).toBe(202);
    await s.next(endpoint);
    expect(JSON.parse(endpoint.requests.at(-1)!.body).type).toBe("webhook.test");
  });

  it("webhooks need the webhooks permission and stay on the key's domain", async () => {
    const s = await setup();
    const sendOnly = await domainKey(s.domainId, ["send"]);
    expect((await call(s.env, "GET", "/dev/v1/webhooks", sendOnly)).status).toBe(403);
    const otherKey = await domainKey(await seedDomain());
    expect((await call(s.env, "GET", `/dev/v1/webhooks/${s.hook.id}`, otherKey)).status).toBe(404);
    expect((await call(s.env, "DELETE", `/dev/v1/webhooks/${s.hook.id}`, otherKey)).status).toBe(404);
    const list = (await (await call(s.env, "GET", "/dev/v1/webhooks", otherKey)).json()) as { data: unknown[] };
    expect(list.data).toEqual([]);
    expect((await call(s.env, "DELETE", `/dev/v1/webhooks/${s.hook.id}`, s.key)).status).toBe(200);
    expect(await db.select().from(webhooks).where(eq(webhooks.id, s.hook.id))).toEqual([]);
  });
});
