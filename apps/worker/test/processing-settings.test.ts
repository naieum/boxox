import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { addresses, aiSettings, appSettings, domains } from "@boxox/db";
import { createDb } from "../src/db";
import type { AppContext } from "../src/middleware";
import { createSettingsRoutes } from "../src/routes/settings";
import { createSetupRoutes } from "../src/routes/setup";
import { loadClassifierConfig } from "../src/services/spam/classifier";
import { seedMailbox } from "./helpers/seed";

const db = createDb(env);
const ACCOUNT = "test-account";
const noToken = { ...env, CF_API_TOKEN: undefined, CF_ACCOUNT_ID: undefined };
const withToken = { ...env, CF_API_TOKEN: "synthetic-test-token", CF_ACCOUNT_ID: ACCOUNT };
const noNetwork = vi.fn(async () => { throw new Error("No Cloudflare call expected"); }) as unknown as typeof fetch;

function app(role: string | null = "owner", fetcher: typeof fetch = noNetwork) {
  return new Hono<AppContext>().use("*", async (c, next) => {
    c.set("db", db);
    if (role) c.set("user", { id: "test@owner.test", email: "test@owner.test", name: "Test", role });
    await next();
  }).route("/api/settings", createSettingsRoutes({ fetch: fetcher })).route("/api/setup", createSetupRoutes({ fetch: fetcher }));
}

async function call(method: string, body?: unknown, opts: { path?: string; role?: string | null; fetcher?: typeof fetch; token?: boolean } = {}) {
  const res = await app(opts.role === undefined ? "owner" : opts.role, opts.fetcher).request(opts.path ?? "/api/settings/processing", {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  }, opts.token ? withToken : noToken);
  return { status: res.status, body: await res.json() as Record<string, any> };
}

beforeEach(async () => {
  await db.delete(aiSettings);
  await db.delete(appSettings);
  await db.delete(domains);
  vi.clearAllMocks();
  await db.insert(appSettings).values({ id: 1, setupCompletedAt: new Date() });
  await db.insert(aiSettings).values({ id: 1, localFilters: true, reputationLookups: false, ai: true, provider: "cloudflare", models: { classify: "@cf/openai/gpt-oss-20b" } });
});

describe("post-setup processing controls", () => {
  it("can stop AI after setup without a token while the setup wizard stays locked", async () => {
    const off = await call("PATCH", { ai: false });
    expect(off.status).toBe(200);
    expect(off.body.processing).toMatchObject({ ai: false, provider: null, localFilters: true });
    expect((await loadClassifierConfig(db, null)).consent.enabled).toBe(false);
    const wizard = await call("PUT", { localFilters: true, reputationLookups: true, ai: true, provider: "openai" }, { path: "/api/setup/processing" });
    expect(wizard.status).toBe(409);
    expect(wizard.body.error.code).toBe("setup_completed");
    expect((await db.query.aiSettings.findFirst())?.ai).toBe(false);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("requires the owner for reads and writes, including address exceptions", async () => {
    const box = await seedMailbox(db, { orgId: "default", domain: "settings.test" });
    for (const role of [null, "member", "admin"]) {
      for (const [method, path, body] of [["GET", "/api/settings/processing", undefined], ["PATCH", "/api/settings/processing", { ai: false }], ["PATCH", `/api/settings/processing/addresses/${box.addressId}`, { aiDisabled: true }]] as const) {
        expect((await call(method, body, { path, role })).status).toBe(role === null ? 401 : 403);
      }
    }
    expect((await db.query.aiSettings.findFirst())?.ai).toBe(true);
    expect((await db.query.addresses.findFirst())?.aiOptOut).toBe(false);
  });

  it("updates rules and the app budget without re-enabling AI or requiring a removed setup token", async () => {
    const result = await call("PATCH", { ownerRules: ["Crypto pitches are spam"], dailyBudgetMicros: 250_000, onlyWhenUncertain: false, reputationLookups: true });
    expect(result.status).toBe(200);
    expect(result.body.processing).toMatchObject({ ai: true, provider: "cloudflare", ownerRules: ["Crypto pitches are spam"], dailyBudgetMicros: 250_000, onlyWhenUncertain: false, reputationLookups: true });
    expect(result.body.warnings.join(" ")).toMatch(/backstop is unchanged/);
    expect(noNetwork).not.toHaveBeenCalled();
    expect((await db.query.aiSettings.findFirst())?.models.classify).toBe("@cf/openai/gpt-oss-20b");
    expect((await call("PATCH", { dailyBudgetMicros: -1 })).status).toBe(400);
    expect((await call("PATCH", { ownerRules: Array.from({ length: 21 }, () => "a") })).status).toBe(400);
  });

  it("will not enable AI or change providers without gateway verification and credits", async () => {
    const before = await db.query.aiSettings.findFirst();
    const switched = await call("PATCH", { provider: "openai" });
    expect(switched.status).toBe(412);
    expect((await db.query.aiSettings.findFirst())?.provider).toBe(before?.provider);
    await call("PATCH", { ai: false });
    expect((await call("PATCH", { ai: true, provider: "cloudflare" })).status).toBe(412);
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { balance: 0 } })) as unknown as typeof fetch;
    const broke = await call("PATCH", { ai: true, provider: "openai" }, { fetcher, token: true });
    expect(broke.status).toBe(409);
    expect(broke.body.error.code).toBe("no_ai_credits");
    expect((await db.query.aiSettings.findFirst())?.ai).toBe(false);
  });

  it.each([true, false])("prepares authenticated unified billing before enabling a provider (gateway exists: %s)", async (exists) => {
    const writes: any[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (!exists && path.endsWith("gateways/default") && (!init?.method || init.method === "GET")) return Response.json({ success: false, errors: [{ code: 404, message: "Gateway not found" }] }, { status: 404 });
      const write = init?.method === "PUT" || init?.method === "POST";
      const result = path.endsWith("credit-balance") ? { balance: 25 } : write ? JSON.parse(String(init.body)) : { id: "default", collect_logs: true, cache_ttl: 3600, authentication: false, byok_only: true, zdr: false };
      if (write) {
        expect((await db.query.aiSettings.findFirst())?.provider).toBe("cloudflare");
        writes.push(result);
      }
      return Response.json({ success: true, result });
    }) as unknown as typeof fetch;
    const result = await call("PATCH", { provider: "openai", dailyBudgetMicros: 500_000 }, { fetcher, token: true });
    expect(result.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ authentication: true, byok_only: false, collect_logs: false, cache_ttl: 0, zdr: true });
    expect(writes[0].spend_limits.rules.at(-1).limit).toBe(0.5);
    expect((await db.query.aiSettings.findFirst())?.provider).toBe("openai");
    expect(result.body.groups.find((g: any) => g.id === "ai").summary).toMatch(/not a provider guarantee/);
  });

  it("persists address exceptions and immediately exposes them to classifier consent", async () => {
    const box = await seedMailbox(db, { orgId: "default", domain: "exception.test", localPart: "legal" });
    const foreign = await seedMailbox(db, { orgId: "other", domain: "other.test" });
    const patched = await call("PATCH", { aiDisabled: true }, { path: `/api/settings/processing/addresses/${box.addressId}` });
    expect(patched.status).toBe(200);
    expect((await loadClassifierConfig(db, box.addressId)).consent.disabledAddresses).toEqual(["legal@exception.test"]);
    const result = await call("GET");
    expect(result.body.addresses).toEqual([{ id: box.addressId, email: "legal@exception.test", aiDisabled: true }]);
    expect((await call("PATCH", { aiDisabled: true }, { path: `/api/settings/processing/addresses/${foreign.addressId}` })).status).toBe(404);
    expect(noNetwork).not.toHaveBeenCalled();
  });
});
