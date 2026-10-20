import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { aiSettings, appSettings, domains } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import type { Env } from "../src/env";
import type { AppContext } from "../src/middleware";
import { createSetupRoutes, SETUP_ORG_ID } from "../src/routes/setup";
import { createDomainRoutes } from "../src/routes/domains";
import { CF_API_BASE } from "../src/services/cloudflare";
import eventSubList from "./fixtures/cf/event-subscriptions-list.json";
import routingEnable from "./fixtures/cf/routing-enable.json";
import routingSettings from "./fixtures/cf/routing-settings.json";
import catchAllPut from "./fixtures/cf/routing-catch-all-put-worker.json";
import subaddressPatch from "./fixtures/cf/routing-subaddress-patch.json";
import sendingSubdomains from "./fixtures/cf/sending-subdomains-list.json";


// Real ids from the email spike (docs/spikes/email.md).
const ACCOUNT = "00000000000000000000000000000001";
const ZONE_ID = "fa4e000000000000000000000000002a";
const QUEUE_ID = "fa4e0000000000000000000000000025";
const ZONE = { id: ZONE_ID, name: "boxox.dev", status: "active" };

let DB: D1Database;
let db: Db;

beforeAll(() => {
  DB = env.DB;
  db = createDb({ DB });
});

beforeEach(async () => {
  for (const table of ["audit_events", "ai_settings", "app_settings", "domains"]) {
    await DB.prepare(`DELETE FROM ${table}`).run();
  }
});

type Handler = (req: { method: string; path: string; query: URLSearchParams; body: unknown }) => unknown;
interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

const ok = (result: unknown) => ({ success: true, errors: [], messages: [], result });

/** A fake Cloudflare API: `"METHOD /path"` → result, or a handler for query-dependent answers. */
function fakeCf(routes: Record<string, Handler | { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(String(input).startsWith(CF_API_BASE)).toBe(true);
    const path = url.pathname.slice(new URL(CF_API_BASE).pathname.length);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, query: url.search, body });
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`unexpected Cloudflare call ${method} ${path}`);
    if (typeof route === "function") {
      return Response.json(ok(route({ method, path, query: url.searchParams, body })));
    }
    return Response.json(route.body, { status: route.status });
  }) as typeof fetch;
  return { fetcher, calls };
}

function buildApp(fetcher: typeof fetch = fakeCf({}).fetcher) {
  return new Hono<AppContext>()
    .use("*", async (c, next) => {
      c.set("db", db);
      c.set("user", { id: "owner@boxox.dev", email: "owner@boxox.dev", name: "Owner", role: "member" });
      await next();
    })
    .route("/api/setup", createSetupRoutes({ fetch: fetcher }));
}

const sent: unknown[] = [];
const bindings = {
  DB: undefined as unknown as D1Database,
  CF_API_TOKEN: "fake-cf-token-for-tests",
  CF_ACCOUNT_ID: ACCOUNT,
  EMAIL: {
    async send(msg: unknown) {
      sent.push(msg);
      return { messageId: "<fake@boxox.dev>" };
    },
  },
} as unknown as Env;

async function call(app: ReturnType<typeof buildApp>, method: string, path: string, body?: unknown) {
  const res = await app.request(
    path,
    {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    bindings,
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

// Pre-existing mail on Google Workspace with a DMARC policy: what the wizard must surface.
const googleMx = [
  { id: "mx1", name: "boxox.dev", type: "MX", content: "aspmx.l.google.com", priority: 1, ttl: 1 },
  { id: "mx2", name: "boxox.dev", type: "MX", content: "alt1.aspmx.l.google.com", priority: 5, ttl: 1 },
];
const apexSpf = { id: "spf1", name: "boxox.dev", type: "TXT", content: '"v=spf1 include:_spf.google.com ~all"', ttl: 1 };
const dmarc = { id: "dm1", name: "_dmarc.boxox.dev", type: "TXT", content: '"v=DMARC1; p=quarantine; rua=mailto:dmarc@boxox.dev"', ttl: 1 };

function zoneRoutes(): Record<string, Handler> {
  return {
    "GET /zones": ({ query }) => (query.get("name") === "boxox.dev" || !query.get("name") ? [ZONE] : []),
    [`GET /zones/${ZONE_ID}/dns_records`]: ({ query }) => {
      const all = [...googleMx, apexSpf, dmarc];
      return all.filter((r) => r.type === query.get("type") && r.name === query.get("name"));
    },
    [`GET /zones/${ZONE_ID}/email/routing`]: () => ({ ...routingSettings.response.result, enabled: false }),
  };
}

describe("setup wizard API", () => {
  it("setup cannot finish until each processing group has an explicit choice", async () => {
    const app = buildApp();

    const fresh = await call(app, "POST", "/api/setup/complete");
    expect(fresh.status).toBe(409);
    expect(fresh.json.error.code).toBe("processing_choice_required");
    expect(fresh.json.missing).toEqual(["localFilters", "reputationLookups", "ai"]);

    // A partial answer is refused outright, not filled in with defaults.
    const partial = await call(app, "PUT", "/api/setup/processing", { localFilters: true, reputationLookups: true });
    expect(partial.status).toBe(400);
    expect(await db.query.aiSettings.findFirst()).toBeUndefined();

    // A row with one group still undecided (null) blocks finishing too.
    await db.insert(aiSettings).values({ id: 1, localFilters: true, reputationLookups: false, ai: null });
    const oneMissing = await call(app, "POST", "/api/setup/complete");
    expect(oneMissing.status).toBe(409);
    expect(oneMissing.json.missing).toEqual(["ai"]);
    expect((await db.query.appSettings.findFirst())?.setupCompletedAt ?? null).toBeNull();

    // Choosing "off" is a choice.
    const chosen = await call(app, "PUT", "/api/setup/processing", {
      localFilters: true,
      reputationLookups: false,
      ai: false,
    });
    expect(chosen.status).toBe(200);
    expect(chosen.json.processing).toEqual({ localFilters: true, reputationLookups: false, ai: false, provider: null });

    const done = await call(app, "POST", "/api/setup/complete");
    expect(done.status).toBe(200);
    expect(done.json.completed).toBe(true);
    expect(done.json.advice).toMatch(/remove the Cloudflare API token/);
    const row = await db.query.appSettings.findFirst({ where: eq(appSettings.id, 1) });
    expect(row?.setupCompletedAt).toBeInstanceOf(Date);

    // Finished setup can't be changed through the wizard any more.
    const after = await call(app, "PUT", "/api/setup/processing", { localFilters: true, reputationLookups: true, ai: false });
    expect(after.status).toBe(409);
    expect(after.json.error.code).toBe("setup_completed");
    expect((await db.query.aiSettings.findFirst())?.reputationLookups).toBe(false);
  });

  it("AI group defaults to off and nothing is pre-ticked", async () => {
    const app = buildApp();

    const state = await call(app, "GET", "/api/setup");
    expect(state.status).toBe(200);
    expect(state.json.processing).toEqual({ localFilters: null, reputationLookups: null, ai: null, provider: null });
    expect(state.json.missingChoices).toEqual(["localFilters", "reputationLookups", "ai"]);

    const consent = await call(app, "GET", "/api/setup/consent");
    expect(consent.json.current).toEqual(state.json.processing);
    expect(consent.json.groups.map((g: { id: string }) => g.id)).toEqual(["localFilters", "reputationLookups", "ai"]);
    for (const group of consent.json.groups) {
      for (const key of ["default", "defaultValue", "checked", "enabled", "value", "selected"]) {
        expect(group).not.toHaveProperty(key);
      }
    }
    for (const provider of consent.json.providers) {
      for (const key of ["default", "selected", "recommended", "checked"]) {
        expect(provider).not.toHaveProperty(key);
      }
    }

    // AI on without a provider, or a missing ai field, never turns AI on.
    const noProvider = await call(app, "PUT", "/api/setup/processing", { localFilters: true, reputationLookups: true, ai: true });
    expect(noProvider.status).toBe(400);
    const missingAi = await call(app, "PUT", "/api/setup/processing", { localFilters: true, reputationLookups: true, provider: "openai" });
    expect(missingAi.status).toBe(400);
    expect(await db.query.aiSettings.findFirst()).toBeUndefined();

    // Turning the other groups on leaves AI off when the owner says off.
    const res = await call(app, "PUT", "/api/setup/processing", {
      localFilters: true,
      reputationLookups: true,
      ai: false,
      provider: "openai",
    });
    expect(res.status).toBe(200);
    const row = await db.query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) });
    expect(row?.ai).toBe(false);
    expect(row?.provider).toBeNull();
    expect(row?.models).toEqual({});
  });

  it("consent screen names the provider company and models", async () => {
    const consent = await call(buildApp(), "GET", "/api/setup/consent");
    expect(consent.status).toBe(200);

    const ai = consent.json.groups.find((g: { id: string }) => g.id === "ai");
    expect(ai.title).toBe("AI (reads your incoming emails)");
    expect(ai.summary).toContain("An AI model will read the content of your incoming emails");
    expect(ai.summary).toContain("AI Gateway");
    expect(consent.json.privacy).toEqual({ zeroDataRetention: true, bodyLogging: false, via: "Your Cloudflare account's AI Gateway" });

    const byId = Object.fromEntries(
      consent.json.providers.map((p: { id: string }) => [p.id, p]),
    ) as Record<string, { company: string; models: { model: string; use: string }[]; leavesCloudflare: boolean; termsUrl: string; estimatedMonthlyUsd: number; dataNote: string }>;
    expect(byId.openai!.company).toBe("OpenAI");
    expect(byId.openai!.models.map((m) => m.model)).toEqual(["openai/gpt-6-luna", "openai/gpt-6-luna", "openai/text-embedding-3-small"]);
    expect(byId.anthropic!.company).toBe("Anthropic");
    expect(byId.anthropic!.models.map((m) => m.model)).toContain("anthropic/claude-haiku-5.5");
    expect(byId.anthropic!.dataNote).toMatch(/no embedding model/);
    expect(byId.cloudflare!.company).toBe("Cloudflare");
    expect(byId.cloudflare!.models.map((m) => m.model)).toContain("@cf/openai/gpt-oss-20b");
    expect(byId.cloudflare!.leavesCloudflare).toBe(false);
    for (const p of Object.values(byId)) {
      expect(p.termsUrl).toMatch(/^https:\/\//);
      expect(p.models.every((m) => m.use.length > 0)).toBe(true);
    }
    expect(byId.openai!.leavesCloudflare).toBe(true);
    // ~2k in / 100 out per email, 100 a day, on gpt-6-luna plus embeddings.
    expect(byId.openai!.estimatedMonthlyUsd).toBeGreaterThan(0.5);
    expect(byId.openai!.estimatedMonthlyUsd).toBeLessThan(2);

    // Picking a third-party provider with no credits is refused and leaves AI undecided.
    const broke = fakeCf({ [`GET /accounts/${ACCOUNT}/ai-gateway/billing/credit-balance`]: () => ({ balance: 0, has_default_payment_method: false }) });
    const refused = await call(buildApp(broke.fetcher), "PUT", "/api/setup/processing", {
      localFilters: true,
      reputationLookups: true,
      ai: true,
      provider: "anthropic",
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("no_ai_credits");
    expect(refused.json.error.message).toContain("Anthropic");
    expect(await db.query.aiSettings.findFirst()).toBeUndefined();

    // With credits: the gateway privacy settings go on before AI does, and the chosen company's models are stored.
    const gatewayPath = `/accounts/${ACCOUNT}/ai-gateway/gateways/default`;
    const funded = fakeCf({
      [`GET /accounts/${ACCOUNT}/ai-gateway/billing/credit-balance`]: () => ({ balance: 10, has_default_payment_method: true }),
      [`GET ${gatewayPath}`]: () => ({ id: "default", collect_logs: true, zdr: false }),
      [`PUT ${gatewayPath}`]: ({ body }) => body,
    });
    const accepted = await call(buildApp(funded.fetcher), "PUT", "/api/setup/processing", {
      localFilters: true,
      reputationLookups: false,
      ai: true,
      provider: "anthropic",
    });
    expect(accepted.status).toBe(200);
    const put = funded.calls.find((c) => c.method === "PUT")!.body as { collect_logs: boolean; zdr: boolean; spend_limits: { rules: { limit: number }[] } };
    expect(put.collect_logs).toBe(false);
    expect(put.zdr).toBe(true);
    expect(put.spend_limits.rules.at(-1)!.limit).toBe(1);
    const row = await db.query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) });
    expect(row).toMatchObject({ ai: true, provider: "anthropic" });
    expect(row?.models.classify).toBe("anthropic/claude-haiku-5.5");
    expect(row?.models.embed).toBeUndefined();
    expect(row?.aiChangedAt).toBeInstanceOf(Date);
  });

  it("shows existing MX and DMARC records before switching", async () => {
    const cf = fakeCf(zoneRoutes());
    const app = buildApp(cf.fetcher);

    const preview = await call(app, "GET", "/api/setup/zones/boxox.dev/preview");
    expect(preview.status).toBe(200);
    expect(preview.json.mx.map((r: { content: string }) => r.content)).toEqual(["aspmx.l.google.com", "alt1.aspmx.l.google.com"]);
    expect(preview.json.dmarc).toEqual([
      { name: "_dmarc.boxox.dev", type: "TXT", content: dmarc.content, priority: null },
    ]);
    expect(preview.json.mxWarning).toContain("aspmx.l.google.com");
    expect(preview.json.mxWarning).toContain("Google Workspace");
    expect(preview.json.dmarcWarning).toContain("p=quarantine");
    expect(preview.json.foreignSpf.content).toBe(apexSpf.content);
    expect(preview.json.needsConfirmation).toBe(true);

    // Asking to receive without confirming changes nothing and returns the same records.
    const unconfirmed = await call(app, "POST", "/api/setup/domains", { domain: "boxox.dev", receive: true });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.json.error.code).toBe("mx_confirmation_required");
    expect(unconfirmed.json.preview.mx).toHaveLength(2);
    expect(unconfirmed.json.preview.dmarc[0].content).toBe(dmarc.content);
    expect(cf.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(await db.query.domains.findFirst()).toBeUndefined();

    // Confirmed: MX removed, SPF merged, routing on, catch-all to this Worker, subaddressing, events subscribed.
    const onboard = fakeCf({
      ...zoneRoutes(),
      [`DELETE /zones/${ZONE_ID}/dns_records/mx1`]: () => ({ id: "mx1" }),
      [`DELETE /zones/${ZONE_ID}/dns_records/mx2`]: () => ({ id: "mx2" }),
      [`PATCH /zones/${ZONE_ID}/dns_records/spf1`]: ({ body }) => ({ ...apexSpf, ...(body as object) }),
      [`POST /zones/${ZONE_ID}/email/routing/enable`]: () => routingEnable.response.result,
      [`GET /zones/${ZONE_ID}/email/routing`]: () => routingSettings.response.result,
      [`GET /zones/${ZONE_ID}/email/sending/subdomains`]: () => sendingSubdomains.response.result,
      [`PUT /zones/${ZONE_ID}/email/routing/rules/catch_all`]: ({ body }) => ({ ...catchAllPut.response.result, ...(body as object) }),
      [`PATCH /zones/${ZONE_ID}/email/routing`]: () => subaddressPatch.response.result,
      [`GET /accounts/${ACCOUNT}/queues`]: () => [{ queue_id: QUEUE_ID, queue_name: "cf-email-events" }],
      [`GET /accounts/${ACCOUNT}/event_subscriptions/subscriptions`]: () => eventSubList.response.result,
    });
    const confirmed = await call(buildApp(onboard.fetcher), "POST", "/api/setup/domains", {
      domain: "boxox.dev",
      receive: true,
      confirmMxReplacement: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.removedMx.map((r: { content: string }) => r.content)).toEqual(["aspmx.l.google.com", "alt1.aspmx.l.google.com"]);
    expect(confirmed.json.replacedSpf.to).toBe('"v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all"');
    const catchAll = onboard.calls.find((c) => c.method === "PUT" && c.path.endsWith("/catch_all"))!;
    expect(catchAll.body).toMatchObject({ actions: [{ type: "worker", value: ["boxox"] }] });
    expect(onboard.calls.some((c) => c.method === "PATCH" && c.path.endsWith("/email/routing"))).toBe(true);
    expect(confirmed.json.subscriptionId).toBe(eventSubList.response.result[0]!.id);

    const row = await db.query.domains.findFirst({ where: eq(domains.name, "boxox.dev") });
    expect(row).toMatchObject({ organizationId: SETUP_ORG_ID, sendingEnabled: true, receivingEnabled: true });

    // The test send goes from the onboarded domain only.
    const app2 = buildApp(onboard.fetcher);
    const refused = await call(app2, "POST", "/api/setup/test-send", { from: "you@other.test", to: "me@gmail.com" });
    expect(refused.status).toBe(409);
    sent.length = 0;
    const test = await call(app2, "POST", "/api/setup/test-send", { from: "you@boxox.dev", to: "me@gmail.com" });
    expect(test.status).toBe(200);
    expect(test.json.messageId).toBe("<fake@boxox.dev>");
    expect(sent).toEqual([expect.objectContaining({ from: "you@boxox.dev", to: "me@gmail.com" })]);
  });
});


describe("later domain onboarding", () => {
  function adminApp(fetcher: typeof fetch, role = "owner") {
    return new Hono<AppContext>().use("*", async (c, next) => {
      c.set("db", db);
      c.set("user", { id: "owner@example.test", email: "owner@example.test", name: "Owner", role });
      await next();
    }).route("/api/orgs/:orgId/domains", createDomainRoutes(fetcher));
  }
  it("adds a sending-only domain after setup without changing existing MX/SPF or organization", async () => {
    await db.insert(appSettings).values({ id: 1, setupCompletedAt: new Date() });
    const cf = fakeCf({ ...zoneRoutes(),
      [`GET /zones/${ZONE_ID}/email/sending/subdomains`]: () => sendingSubdomains.response.result,
      [`GET /accounts/${ACCOUNT}/queues`]: () => [{ queue_id: QUEUE_ID, queue_name: "cf-email-events" }],
      [`GET /accounts/${ACCOUNT}/event_subscriptions/subscriptions`]: () => eventSubList.response.result,
    });
    const app = adminApp(cf.fetcher);
    for (let i = 0; i < 2; i++) {
      const res = await call(app, "POST", "/api/orgs/later-org/domains/onboard", { domain: "boxox.dev", receive: false });
      expect(res.status).toBe(200);
      expect(res.json.domain).toMatchObject({ name: "boxox.dev", receivingEnabled: false, sendingEnabled: true });
    }
    expect(cf.calls.filter(c => c.method !== "GET")).toEqual([]);
    expect(await db.select().from(domains)).toHaveLength(1);
    expect((await db.query.domains.findFirst())?.organizationId).toBe("later-org");
    const locked = await call(buildApp(cf.fetcher), "POST", "/api/setup/domains", { domain: "boxox.dev", receive: false });
    expect(locked.status).toBe(409);
  });
  it("refuses unconfirmed provider replacement after setup and allows preview", async () => {
    await db.insert(appSettings).values({ id: 1, setupCompletedAt: new Date() });
    const cf = fakeCf(zoneRoutes());
    const app = adminApp(cf.fetcher);
    expect((await call(app, "GET", "/api/orgs/later-org/domains/zones/boxox.dev/preview")).json.needsConfirmation).toBe(true);
    const res = await call(app, "POST", "/api/orgs/later-org/domains/onboard", { domain: "boxox.dev", receive: true });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("mx_confirmation_required");
    expect(cf.calls.every(c => c.method === "GET")).toBe(true);
    expect(await db.query.domains.findFirst()).toBeUndefined();
  });
  it("blocks members before DNS reads or mutations", async () => {
    const cf = fakeCf({});
    const app = adminApp(cf.fetcher, "member");
    expect((await call(app, "POST", "/api/orgs/later-org/domains/onboard", { domain: "boxox.dev", receive: false })).status).toBe(403);
    expect((await call(app, "GET", "/api/orgs/later-org/domains/zones/boxox.dev/preview")).status).toBe(403);
    expect(cf.calls).toEqual([]);
  });
});
