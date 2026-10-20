import { describe, expect, it } from "vitest";
import {
  CF_API_BASE,
  CloudflareApiError,
  CloudflareClient,
  cloudflareClient,
  DELIVERY_EVENTS,
  mergeLifecycleRules,
  mergeSpf,
  TokenNotConfiguredError,
} from "../src/services/cloudflare";
import catchAllPut from "./fixtures/cf/routing-catch-all-put-worker.json";
import eventSubCreate from "./fixtures/cf/event-subscription-create.json";
import eventSubList from "./fixtures/cf/event-subscriptions-list.json";
import routingEnable from "./fixtures/cf/routing-enable.json";
import routingSettings from "./fixtures/cf/routing-settings.json";
import subaddressPatch from "./fixtures/cf/routing-subaddress-patch.json";
import sendingLimits from "./fixtures/cf/sending-limits.json";
import sendingSubdomains from "./fixtures/cf/sending-subdomains-list.json";

// Real ids from the email spike (docs/spikes/email.md).
const ACCOUNT = "00000000000000000000000000000001";
const ZONE_ID = "fa4e000000000000000000000000002a";
const QUEUE_ID = "fa4e0000000000000000000000000025";
const TOKEN = "fake-cf-token-for-tests";

it("calls supplied fetch without a client receiver, as required by Workers native fetch", async () => {
  const fetcher = async function(this: unknown) {
    expect(this).toBeUndefined();
    return Response.json({ success: true, result: [{ id: ZONE_ID, name: "boxox.dev", status: "active", account: { id: ACCOUNT } }] });
  } as typeof fetch;
  const client = new CloudflareClient({ accountId: ACCOUNT, token: TOKEN, fetch: fetcher });
  expect(await client.listZones()).toMatchObject([{ name: "boxox.dev" }]);
});

const ok = (result: unknown) => ({ status: 200, response: { success: true, errors: [], messages: [], result } });

// The wizard token's DNS reads were 403 for the spike's OAuth token, so these
// mirror the "Before" records in the spike's onboarding log.
const zone = { id: ZONE_ID, name: "boxox.dev", status: "active" };
const resendMx = {
  id: "fa4e0000000000000000000000000100",
  name: "boxox.dev",
  type: "MX",
  content: "inbound-smtp.us-east-1.amazonaws.com",
  priority: 10,
  ttl: 1,
};
const foreignSpf = routingEnable.response.result.errors[0]!.existing;

type Route = { status: number; response: unknown };
interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

function fakeCf(routes: Record<string, Route | Route[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(CF_API_BASE)).toBe(true);
    const path = url.slice(CF_API_BASE.length);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    });
    const key = `${method} ${path.split("?")[0]}`;
    const q = queues.get(key);
    if (!q?.length) throw new Error(`unexpected Cloudflare call ${key}`);
    const r = q.length > 1 ? q.shift()! : q[0]!;
    return new Response(JSON.stringify(r.response), { status: r.status });
  }) as typeof fetch;
  return { fetcher, calls };
}

const fromFixture = (f: { request: { method: string; path: string }; status: number; response: unknown }) => ({
  [`${f.request.method} ${f.request.path}`]: { status: f.status, response: f.response },
});

const client = (fetcher: typeof fetch) => cloudflareClient({ CF_API_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT }, fetcher);

describe("Cloudflare setup client", () => {
  it("onboards a zone for sending and routing", async () => {
    const { fetcher, calls } = fakeCf({
      "GET /zones": ok([zone]),
      [`GET /zones/${ZONE_ID}/dns_records`]: [ok([resendMx]), ok([foreignSpf])],
      [`DELETE /zones/${ZONE_ID}/dns_records/${resendMx.id}`]: ok({ id: resendMx.id }),
      [`PATCH /zones/${ZONE_ID}/dns_records/${foreignSpf.id}`]: ok({ ...foreignSpf, content: "patched" }),
      ...fromFixture(routingEnable),
      ...fromFixture(routingSettings),
      [`GET /zones/${ZONE_ID}/email/sending/subdomains`]: ok([]),
      [`POST /zones/${ZONE_ID}/email/sending/subdomains`]: ok(sendingSubdomains.response.result[0]),
    });

    const res = await client(fetcher).onboardZone("boxox.dev", { routing: true, confirmMxReplacement: true });

    expect(res.status).toBe("onboarded");
    if (res.status !== "onboarded") return;
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls[0]!.path).toContain("name=boxox.dev");
    expect(res.removedMx.map((r) => r.id)).toEqual([resendMx.id]);
    // The spike's exact fix: `v=spf1 -all` → this, after which routing went `ready`.
    expect(res.replacedSpf).toEqual({
      id: foreignSpf.id,
      from: '"v=spf1 -all"',
      to: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
    });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' });
    // Enable reported misconfigured/locked, so the client re-read the status.
    expect(res.routing?.status).toBe("ready");
    expect(res.sending).toMatchObject({ name: "boxox.dev", return_path_domain: "cf-bounce.boxox.dev" });
    expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/email/sending/subdomains"))!.body).toEqual({
      name: "boxox.dev",
    });
    const order = calls.map((c) => `${c.method} ${c.path.split("?")[0]!.replace(`/zones/${ZONE_ID}`, "")}`);
    expect(order.indexOf(`DELETE /dns_records/${resendMx.id}`)).toBeLessThan(order.indexOf("POST /email/routing/enable"));
    expect(order.indexOf(`PATCH /dns_records/${foreignSpf.id}`)).toBeLessThan(order.indexOf("POST /email/routing/enable"));
  });

  it("onboards a sending-only zone without touching MX", async () => {
    const { fetcher, calls } = fakeCf({
      "GET /zones": ok([zone]),
      ...fromFixture(sendingSubdomains),
    });
    const res = await client(fetcher).onboardZone("boxox.dev", { routing: false });
    expect(res).toMatchObject({ status: "onboarded", routing: null, removedMx: [] });
    expect(calls.some((c) => c.path.includes("dns_records") || c.path.includes("routing"))).toBe(false);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("warns before replacing existing MX records", async () => {
    const { fetcher, calls } = fakeCf({
      "GET /zones": ok([zone]),
      [`GET /zones/${ZONE_ID}/dns_records`]: [ok([resendMx]), ok([foreignSpf])],
    });
    const res = await client(fetcher).onboardZone("boxox.dev", { routing: true });

    expect(res.status).toBe("needs-confirmation");
    if (res.status !== "needs-confirmation") return;
    expect(res.plan.foreignMx.map((r) => r.content)).toEqual(["inbound-smtp.us-east-1.amazonaws.com"]);
    expect(res.plan.foreignSpf?.id).toBe(foreignSpf.id);
    expect(res.plan.warning).toContain("replaces the MX records of boxox.dev");
    expect(res.plan.warning).toContain("inbound-smtp.us-east-1.amazonaws.com");
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    const google = fakeCf({
      [`GET /zones/${ZONE_ID}/dns_records`]: [
        ok([{ ...resendMx, content: "smtp.google.com", priority: 1 }]),
        ok([]),
      ],
    });
    const plan = await client(google.fetcher).planMxReplacement(zone);
    expect(plan.warning).toContain("Google Workspace or Microsoft 365");

    const cfOnly = fakeCf({
      [`GET /zones/${ZONE_ID}/dns_records`]: [
        ok([{ ...resendMx, content: "route1.mx.cloudflare.net." }]),
        ok([{ ...foreignSpf, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' }]),
      ],
    });
    expect(await client(cfOnly.fetcher).planMxReplacement(zone)).toEqual({
      foreignMx: [],
      foreignSpf: null,
      warning: null,
    });
  });

  it("creates a catch-all rule to this Worker", async () => {
    const { fetcher, calls } = fakeCf({ ...fromFixture(catchAllPut), ...fromFixture(subaddressPatch) });
    const cf = client(fetcher);

    const rule = await cf.setCatchAllToWorker(ZONE_ID, "boxox");
    expect(calls[0]).toMatchObject({ method: "PUT", path: `/zones/${ZONE_ID}/email/routing/rules/catch_all` });
    expect(calls[0]!.body).toMatchObject({
      enabled: true,
      matchers: catchAllPut.request.body.matchers,
      actions: [{ type: "worker", value: ["boxox"] }],
    });
    expect(rule).toMatchObject({ enabled: true, priority: 2147483647 });
    expect(rule.actions[0]!.type).toBe("worker");

    const settings = await cf.setSubaddressing(ZONE_ID, true);
    expect(calls[1]!.body).toEqual(subaddressPatch.request.body);
    expect(settings.support_subaddress).toBe(true);
  });

  it("subscribes delivery events to the queue", async () => {
    const { fetcher, calls } = fakeCf({
      [`GET /accounts/${ACCOUNT}/queues`]: ok([{ queue_id: QUEUE_ID, queue_name: "cf-email-events" }]),
      [`GET /accounts/${ACCOUNT}/event_subscriptions/subscriptions`]: ok([]),
      ...fromFixture(eventSubCreate),
    });
    const cf = client(fetcher);
    const queue = await cf.findQueue("cf-email-events");
    const sub = await cf.subscribeDeliveryEvents({ zoneId: ZONE_ID, domain: "boxox.dev", queueId: queue.queue_id });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe(eventSubCreate.request.path);
    const sent = post.body as typeof eventSubCreate.request.body;
    expect(sent.source).toEqual(eventSubCreate.request.body.source);
    expect(sent.destination).toEqual({ type: "queues.queue", queue_id: QUEUE_ID });
    expect(sent.events).toEqual(eventSubCreate.request.body.events);
    expect(sent.events).toEqual([...DELIVERY_EVENTS]);
    expect(sent.enabled).toBe(true);
    expect(sub.id).toBe("fa4e0000000000000000000000000027");

    // A second run finds the existing subscription instead of duplicating it.
    const again = fakeCf(fromFixture(eventSubList));
    const existing = await client(again.fetcher).subscribeDeliveryEvents({
      zoneId: ZONE_ID,
      domain: "boxox.dev",
      queueId: QUEUE_ID,
    });
    expect(existing.id).toBe(sub.id);
    expect(again.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("applies AI Gateway settings: ZDR on, body logging off, spend limit", async () => {
    // Shape from the AI spike's POST /ai-gateway/gateways (docs/spikes/ai.md).
    const existing = {
      id: "default",
      account_id: ACCOUNT,
      created_at: "2026-10-18T00:00:00Z",
      modified_at: "2026-10-18T00:00:00Z",
      collect_logs: true,
      zdr: false,
      cache_ttl: 0,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      cache_invalidate_on_update: false,
      authentication: false,
      workers_ai_billing_mode: "postpaid",
      spend_limits: {
        enabled: false,
        rules: [{ id: "owner-monthly", limitType: "cost", limit: 20, window: 2592000, technique: "fixed" }],
      },
    };
    const path = `/accounts/${ACCOUNT}/ai-gateway/gateways/default`;
    const { fetcher, calls } = fakeCf({
      [`GET ${path}`]: ok(existing),
      [`PUT ${path}`]: ok({ ...existing, collect_logs: false, zdr: true }),
    });
    await client(fetcher).applyGatewaySettings("default", { dailySpendLimitUsd: 0.5 });

    const put = calls.find((c) => c.method === "PUT")!;
    const body = put.body as Record<string, any>;
    expect(body.zdr).toBe(true);
    expect(body.collect_logs).toBe(false);
    expect(body).not.toHaveProperty("collect_log_payload");
    expect(body).not.toHaveProperty("created_at");
    expect(body.authentication).toBe(true);
    expect(body.byok_only).toBe(false);
    expect(body.cache_ttl).toBe(0);
    expect(body.spend_limits.enabled).toBe(true);
    expect(body.spend_limits.rules).toEqual([
      existing.spend_limits.rules[0],
      { id: "boxox-daily", limitType: "cost", limit: 0.5, window: 86400, technique: "fixed" },
    ]);

    // No gateway yet: create it with the same settings.
    const fresh = fakeCf({
      [`GET ${path}`]: { status: 404, response: { success: false, errors: [{ code: 7001, message: "Not Found" }] } },
      [`POST /accounts/${ACCOUNT}/ai-gateway/gateways`]: ok({ id: "default" }),
    });
    await client(fresh.fetcher).applyGatewaySettings("default", { dailySpendLimitUsd: 1 });
    const post = fresh.calls.find((c) => c.method === "POST")!.body as Record<string, any>;
    expect(post).toMatchObject({ id: "default", zdr: true, collect_logs: false });
    expect(post.spend_limits.rules).toEqual([
      { id: "boxox-daily", limitType: "cost", limit: 1, window: 86400, technique: "fixed" },
    ]);
  });

  it("reports a clear error when no token is configured", async () => {
    const { fetcher, calls } = fakeCf({});
    const cf = new CloudflareClient({ accountId: ACCOUNT, fetch: fetcher });
    expect(cf.configured).toBe(false);
    const attempts: (() => Promise<unknown>)[] = [
      () => cf.findZone("boxox.dev"),
      () => cf.listDnsRecords(ZONE_ID),
      () => cf.planMxReplacement(zone),
      () => cf.onboardZone("boxox.dev", { routing: true, confirmMxReplacement: true }),
      () => cf.getRoutingSettings(ZONE_ID),
      () => cf.enableRouting(ZONE_ID),
      () => cf.setCatchAllToWorker(ZONE_ID, "boxox"),
      () => cf.setSubaddressing(ZONE_ID, true),
      () => cf.enableSending(ZONE_ID, "boxox.dev"),
      () => cf.getSendingLimits(),
      () => cf.findQueue("cf-email-events"),
      () => cf.subscribeDeliveryEvents({ zoneId: ZONE_ID, domain: "boxox.dev", queueId: QUEUE_ID }),
      () => cf.applyRetentionLifecycle("boxox-mail", [{ prefix: "raw/", days: 90 }]),
      () => cf.getCreditBalance(),
      () => cf.applyGatewaySettings("default", { dailySpendLimitUsd: 1 }),
    ];
    for (const attempt of attempts) {
      const p = attempt();
      await expect(p).rejects.toBeInstanceOf(TokenNotConfiguredError);
      await expect(p).rejects.toThrow(/token not configured.*CF_API_TOKEN/);
    }
    expect(calls).toHaveLength(0);

    // The token alone isn't enough for account-scoped calls.
    const noAccount = cloudflareClient({ CF_API_TOKEN: TOKEN }, fetcher);
    await expect(noAccount.getSendingLimits()).rejects.toThrow(/CF_ACCOUNT_ID/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces Cloudflare error codes", async () => {
    const { fetcher } = fakeCf({
      [`POST /zones/${ZONE_ID}/email/routing/enable`]: {
        status: 400,
        response: { success: false, errors: [{ code: 2008, message: "Non-Cloudflare MX records exist" }], result: null },
      },
    });
    const err = await client(fetcher)
      .enableRouting(ZONE_ID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareApiError);
    expect((err as CloudflareApiError).code).toBe(2008);
    expect((err as CloudflareApiError).message).toContain("Non-Cloudflare MX records exist");
  });

  it("reads the sending quota", async () => {
    const { fetcher } = fakeCf(fromFixture(sendingLimits));
    expect((await client(fetcher).getSendingLimits()).quota).toEqual({ value: 1000, unit: "day" });
  });

  it("merges R2 lifecycle rules and keeps a multipart-abort rule", async () => {
    const lifecyclePath = `/accounts/${ACCOUNT}/r2/buckets/boxox-mail/lifecycle`;
    const defaultAbort = {
      id: "Default Multipart Abort Rule",
      enabled: true,
      conditions: { prefix: "" },
      abortMultipartUploadsTransition: { condition: { type: "Age" as const, maxAge: 604800 } },
    };
    const { fetcher, calls } = fakeCf({
      [`GET ${lifecyclePath}`]: ok({ rules: [defaultAbort] }),
      [`PUT ${lifecyclePath}`]: ok({}),
    });
    await client(fetcher).applyRetentionLifecycle("boxox-mail", [{ prefix: "raw/", days: 90 }]);
    const put = calls.find((c) => c.method === "PUT")!.body as { rules: unknown[] };
    expect(put.rules).toEqual([
      defaultAbort,
      {
        id: "boxox-expire-raw",
        enabled: true,
        conditions: { prefix: "raw/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 7776000 } },
      },
    ]);

    const merged = mergeLifecycleRules([], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.abortMultipartUploadsTransition).toBeDefined();
  });

  it("keeps the domain's other SPF senders", () => {
    expect(mergeSpf('"v=spf1 include:_spf.google.com -all"')).toBe(
      '"v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all"',
    );
  });
});
