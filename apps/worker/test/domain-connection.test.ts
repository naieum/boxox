import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db";
import { requireSameOrigin, type AppContext } from "../src/middleware";
import { createDomainRoutes } from "../src/routes/domains";
import { DOMAIN_CONNECTION_SECONDS } from "../src/services/domain-connection";

const ACCOUNT = "a".repeat(32), ZONE = "b".repeat(32), TOKEN = "fake-domain-connection-token";
const origin = "https://mail.example.test";
const testEnv = { ...env, CF_API_TOKEN: undefined, CF_ACCOUNT_ID: ACCOUNT, BOXOX_SIGNING_SECRET: "test-domain-session-secret" };
const zone = { id: ZONE, name: "example.test", status: "active", account: { id: ACCOUNT } };
afterEach(() => vi.restoreAllMocks());
function client(role = "owner", user = "owner@example.test") {
  const requests: { path: string; method: string; authorization: string | null }[] = [];
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    const result = url.pathname === "/client/v4/zones" ? [zone]
      : url.pathname.endsWith("/dns_records") ? [{ id: "mx", type: "MX", name: zone.name, content: "aspmx.l.google.com", priority: 10 }]
      : url.pathname.endsWith("/email/routing") ? { enabled: false } : undefined;
    if (result === undefined) throw new Error("Unexpected Cloudflare request");
    return Response.json({ success: true, result });
  }) as typeof fetch;
  const app = new Hono<AppContext>().use("*", async (c, next) => {
    c.set("db", createDb(c.env)); c.set("user", { id: user, email: user, name: "Test user", role }); await next();
  }).use("*", requireSameOrigin).route("/api/orgs/:orgId/domains", createDomainRoutes(fetcher));
  const call = (method: string, path: string, options: { token?: string; body?: unknown; cookie?: string; org?: string; sameOrigin?: boolean; bindings?: typeof testEnv } = {}) => app.request(`${origin}/api/orgs/${options.org ?? "default"}/domains${path}`, {
    method,
    headers: { "content-type": "application/json", ...(options.sameOrigin === false ? {} : { origin, "x-boxox-csrf": "1" }), ...(options.cookie ? { cookie: options.cookie } : {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : options.token === undefined ? undefined : JSON.stringify({ token: options.token }),
  }, options.bindings ?? testEnv);
  return { call, requests };
}
const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;

describe("temporary domain connection", () => {
  it("checks access without writes and keeps the credential encrypted, private, and out of responses", async () => {
    const c = client(); const response = await c.call("POST", "/connection", { token: TOKEN });
    expect(response.status).toBe(200); const cookie = cookieOf(response);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(response.headers.get("set-cookie")).toMatch(/Secure/);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
    expect(response.headers.get("set-cookie")).toContain("Path=/api/orgs/default/domains");
    expect(response.headers.get("set-cookie")).toContain(`Max-Age=${DOMAIN_CONNECTION_SECONDS}`);
    expect(cookie).not.toContain(TOKEN); expect(await response.text()).not.toContain(TOKEN);
    const zones = await c.call("GET", "/zones", { cookie });
    expect(zones.headers.get("cache-control")).toBe("no-store, private");
    expect(await zones.json()).toMatchObject({ configured: true, connection: { temporary: true }, zones: [{ name: zone.name }] });
    const preview = await c.call("GET", `/zones/${zone.name}/preview`, { cookie });
    expect(await preview.json()).toMatchObject({ needsConfirmation: true, mx: [{ content: "aspmx.l.google.com" }] });
    // Even with temporary credentials, foreign MX replacement requires explicit confirmation.
    const onboard = await c.call("POST", "/onboard", { cookie, body: { domain: zone.name, receive: true } });
    expect(onboard.status).toBe(409);
    expect(await onboard.json()).toMatchObject({ error: { code: "mx_confirmation_required" } });
    expect(c.requests.every(r => r.method === "GET" && r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(await (await c.call("GET", "/zones")).json()).toEqual({ configured: false, zones: [] });
    expect(testEnv.CF_API_TOKEN).toBeUndefined();
  });

  it("binds the connection to the owner, organization, account, and expiry", async () => {
    const c = client(); const cookie = cookieOf(await c.call("POST", "/connection", { token: TOKEN }));
    for (const response of [
      await client("owner", "someone@example.test").call("GET", "/zones", { cookie }),
      await client("admin").call("GET", "/zones", { cookie }),
      await c.call("GET", "/zones", { cookie, org: "other" }),
      await c.call("GET", "/zones", { cookie, bindings: { ...testEnv, CF_ACCOUNT_ID: "c".repeat(32) } }),
      await c.call("GET", "/zones", { cookie: cookie.replace(/=./, "=x") }),
    ]) expect(await response.json()).toEqual({ configured: false, zones: [] });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + (DOMAIN_CONNECTION_SECONDS + 1) * 1000);
    expect(await (await c.call("GET", "/zones", { cookie })).json()).toEqual({ configured: false, zones: [] });
  });

  it("rejects unauthorized or cross-site connection changes and clears the browser cookie on disconnect", async () => {
    expect((await client("member").call("POST", "/connection", { token: TOKEN })).status).toBe(403);
    expect((await client("admin").call("POST", "/connection", { token: TOKEN })).status).toBe(403);
    expect((await client().call("POST", "/connection", { token: TOKEN, sameOrigin: false })).status).toBe(403);
    expect((await client().call("DELETE", "/connection", { sameOrigin: false })).status).toBe(403);
    const c = client(); const cookie = cookieOf(await c.call("POST", "/connection", { token: TOKEN }));
    const disconnected = await c.call("DELETE", "/connection", { cookie });
    expect(disconnected.status).toBe(200); expect(disconnected.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(disconnected.headers.get("set-cookie")).toContain("Path=/api/orgs/default/domains");
    expect((await c.call("POST", "/connection", { token: "x\ninvalid" })).status).toBe(400);
  });
});
