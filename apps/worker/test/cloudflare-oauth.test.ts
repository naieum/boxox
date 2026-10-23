import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db";
import { requireOwner, requireSameOrigin, type AppContext } from "../src/middleware";
import { createDomainRoutes } from "../src/routes/domains";
import { completeCloudflareOAuth, cloudflareOAuthScopes } from "../src/services/cloudflare-oauth";
import type { Env } from "../src/env";

const ACCOUNT = "a".repeat(32), ACCESS = "fake-oauth-access-token", REFRESH = "fake-oauth-refresh-token";
const origin = "https://mail.example.test";
const bindings = { ...env, CF_ACCOUNT_ID: ACCOUNT, CF_OAUTH_CLIENT_ID: "boxox-test-client", BOXOX_SIGNING_SECRET: "test-connection-encryption-secret", PUBLIC_URL: origin, CF_API_TOKEN: undefined };
const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;
beforeEach(async () => { vi.restoreAllMocks(); await env.DB.prepare("DELETE FROM cloudflare_connections").run(); });
function client(options: { role?: string; user?: string; invalidRefresh?: boolean; failRefresh?: boolean; expiresIn?: number; omitRefresh?: boolean } = {}) {
  let challenge = "";
  const requests: { url: string; method: string; body: URLSearchParams; headers: Headers }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), body = new URLSearchParams(String(init?.body ?? ""));
    requests.push({ url, body, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    if (url.endsWith("/oauth2/token")) {
      if (body.get("grant_type") === "authorization_code") {
        expect(body.get("redirect_uri")).toBe(origin + "/api/cloudflare/callback");
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.get("code_verifier")!)));
        expect(btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).toBe(challenge);
      } else {
        expect(body.get("refresh_token")).toBe(REFRESH);
        if (options.invalidRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (options.failRefresh) return Response.json({ error: "server_error" }, { status: 503 });
      }
      return Response.json({ access_token: ACCESS, ...(options.omitRefresh ? {} : { refresh_token: REFRESH }), token_type: "Bearer", expires_in: options.expiresIn ?? 3600 });
    }
    if (url.endsWith("/oauth2/revoke")) return new Response(null, { status: 200 });
    if (url.includes("/client/v4/zones?")) return Response.json({ success: true, result: [{ id: "b".repeat(32), name: "example.test", status: "active", account: { id: ACCOUNT } }] });
    throw new Error("Unexpected network request");
  });
  const app = new Hono<AppContext>().use("*", async (c, next) => {
    c.set("db", createDb(c.env)); c.set("user", { id: options.user ?? "owner", email: "owner@example.test", name: "Owner", role: options.role ?? "owner" }); await next();
  }).use("*", requireSameOrigin)
    .get("/api/cloudflare/callback", requireOwner, c => completeCloudflareOAuth(c, fetcher as typeof fetch))
    .route("/api/orgs/:orgId/domains", createDomainRoutes(fetcher as typeof fetch));
  const call = (path: string, method = "GET", cookie?: string | null, extra: Env = bindings) => app.request(origin + path, { method, headers: { origin, "x-boxox-csrf": "1", ...(cookie ? { cookie } : {}) } }, extra);
  async function start() {
    const response = await call("/api/orgs/default/domains/connection/oauth", "POST");
    const url = new URL((await response.json() as { url: string }).url); challenge = url.searchParams.get("code_challenge")!;
    return { response, url, cookie: cookieOf(response) };
  }
  async function connect() {
    const started = await start();
    const response = await call(`/api/cloudflare/callback?code=test-code&state=${started.url.searchParams.get("state")}`, "GET", started.cookie);
    expect(response.headers.get("location")).toBe("/domains?cloudflare=connected");
    return started;
  }
  return { app, call, start, connect, requests };
}

describe("Cloudflare API OAuth", () => {
  it("uses PKCE and exact redirect, encrypts durable credentials, and lets the owner add domains without tokens", async () => {
    const c = client(); const { response, url, cookie } = await c.connect();
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(url.searchParams.get("scope")).toBe(cloudflareOAuthScopes(bindings).join(" "));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(cookie).not.toContain(REFRESH);
    const stored = JSON.stringify(await env.DB.prepare("SELECT * FROM cloudflare_connections").all());
    expect(stored).not.toContain(ACCESS); expect(stored).not.toContain(REFRESH);
    const zones = await c.call("/api/orgs/default/domains/zones");
    const json = await zones.json();
    expect(json).toMatchObject({ configured: true, connection: { oauth: true, temporary: false } });
    expect(JSON.stringify(json)).not.toContain(ACCESS);
    expect(c.requests.filter(r => r.url.includes("api.cloudflare.com")).every(r => r.method === "GET" && r.headers.get("authorization") === `Bearer ${ACCESS}`)).toBe(true);
    expect(await (await client({ user: "other-owner" }).call("/api/orgs/default/domains/zones")).json()).toMatchObject({ configured: false });
    expect(await (await c.call("/api/orgs/other/domains/zones")).json()).toMatchObject({ configured: false });
    expect(await (await c.call("/api/orgs/default/domains/zones", "GET", undefined, { ...bindings, CF_ACCOUNT_ID: "c".repeat(32) })).json()).toMatchObject({ configured: false });
  });

  it("rejects changed, expired, missing, or another owner's state before token exchange; denial makes no changes", async () => {
    const c = client(); const started = await c.start();
    for (const [state, cookie] of [["changed", started.cookie], [started.url.searchParams.get("state"), undefined]]) {
      const r = await c.call(`/api/cloudflare/callback?code=x&state=${state}`, "GET", cookie);
      expect(r.headers.get("location")).toBe("/domains?cloudflare=failed");
    }
    const other = client({ user: "other-owner" });
    expect((await other.call(`/api/cloudflare/callback?code=x&state=${started.url.searchParams.get("state")}`, "GET", started.cookie)).headers.get("location")).toBe("/domains?cloudflare=failed");
    const denied = await c.call(`/api/cloudflare/callback?error=access_denied&state=${started.url.searchParams.get("state")}`, "GET", started.cookie);
    expect(denied.headers.get("location")).toBe("/domains?cloudflare=denied");
    expect(denied.headers.get("set-cookie")).toContain("Max-Age=0");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
    expect((await c.call(`/api/cloudflare/callback?code=x&state=${started.url.searchParams.get("state")}`, "GET", started.cookie)).headers.get("location")).toBe("/domains?cloudflare=failed");
    expect(c.requests).toHaveLength(0); expect(other.requests).toHaveLength(0);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM cloudflare_connections").first<{ n: number }>())?.n).toBe(0);
  });

  it("renews access automatically, serializes rotation, and removes plus revokes a disconnected connection", async () => {
    const c = client({ expiresIn: 120 }); await c.connect();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 90_000);
    const results = await Promise.all([c.call("/api/orgs/default/domains/zones"), c.call("/api/orgs/default/domains/zones")]);
    for (const r of results) expect(await r.json()).toMatchObject({ configured: true });
    expect(c.requests.filter(r => r.body.get("grant_type") === "refresh_token")).toHaveLength(1);
    const r = await c.call("/api/orgs/default/domains/connection", "DELETE"); expect(r.status).toBe(200);
    expect(c.requests.find(r => r.url.endsWith("/oauth2/revoke"))?.body.get("token")).toBe(REFRESH);
    expect(await (await c.call("/api/orgs/default/domains/zones")).json()).toMatchObject({ configured: false });
  });

  it("fails closed after revocation and preserves credentials through temporary provider outages", async () => {
    const c = client({ expiresIn: 120 }); await c.connect();
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
    expect(await (await client({ failRefresh: true }).call("/api/orgs/default/domains/zones")).json()).toMatchObject({ configured: false });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM cloudflare_connections").first<{ n: number }>())?.n).toBe(1);
    expect(await (await client({ invalidRefresh: true }).call("/api/orgs/default/domains/zones")).json()).toMatchObject({ configured: false });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM cloudflare_connections").first<{ n: number }>())?.n).toBe(0);
  });

  it("requires an owner, same-origin POST, and installation configuration; Free requests no sending or queue permissions", async () => {
    expect((await client({ role: "admin" }).call("/api/orgs/default/domains/connection/oauth", "POST")).status).toBe(403);
    const c = client();
    expect((await c.app.request(origin + "/api/orgs/default/domains/connection/oauth", { method: "POST" }, bindings)).status).toBe(403);
    expect((await c.call("/api/orgs/default/domains/connection/oauth", "POST", undefined, { ...bindings, CF_OAUTH_CLIENT_ID: undefined })).status).toBe(503);
    expect(cloudflareOAuthScopes({ ...bindings, BOXOX_EDITION: "free" })).toEqual(["zone.read", "dns.write", "zone-settings.write", "email-routing-rule.write", "offline_access"]);
  });
});
