import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";
import { domains } from "@boxox/db";
import { createDb } from "../src/db";
import type { AppContext } from "../src/middleware";
import { createPublicDomainHealthRoutes } from "../src/routes/health";
import dnsStatus from "./fixtures/cf/sending-dns-status.json";

const db = createDb(env);
beforeEach(async () => { await db.delete(domains); await env.KV.delete("public-domain-health"); });
function app(fetcher: typeof fetch) {
  return new Hono<AppContext>().use("*", async (c, next) => { c.set("db", db); await next(); })
    .route("/health/domains", createPublicDomainHealthRoutes(fetcher));
}

it("public domain health exposes only DNS/configuration status and caches bounded DNS checks", async () => {
  await db.insert(domains).values({ id: "public-health", name: "boxox.dev", organizationId: "default", status: "ready", sendingEnabled: true, receivingEnabled: true, health: { privateDetail: "do not expose" } });
  await db.insert(domains).values({ id: "other-org", name: "private.test", organizationId: "other" });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const name = url.searchParams.get("name");
    const type = url.searchParams.get("type");
    const Answer = dnsStatus.response.result.records.filter(r => r.name === name && r.type === type)
      .map(r => ({ type: type === "MX" ? 15 : 16, data: r.type === "MX" ? `${r.priority} ${r.content}` : r.content }));
    if (name === "boxox.dev" && type === "MX") Answer.push({ type: 15, data: "24 route1.mx.cloudflare.net." });
    return Response.json({ Status: 0, Answer });
  }) as unknown as typeof fetch;
  for (let i = 0; i < 2; i++) {
    const result = await app(fetcher).request("/health/domains", {}, env);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ "boxox.dev": "healthy" });
  }
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("DNS errors report degraded status instead of a false healthy result", async () => {
  await db.insert(domains).values({ id: "bad-health", name: "bad.test", organizationId: "default", status: "ready", sendingEnabled: true, receivingEnabled: true });
  const result = await app((async () => { throw new Error("resolver unavailable"); }) as typeof fetch).request("/health/domains", {}, env);
  expect(await result.json()).toEqual({ "bad.test": "degraded" });
});
