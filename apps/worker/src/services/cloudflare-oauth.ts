import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppContext } from "../middleware";
import type { Env } from "../env";
import { decryptSecret, encryptSecret, importMasterKey, type EncryptedSecret } from "../crypto";
import { isFree } from "./capabilities";
import { cloudflareClient } from "./cloudflare";
import { log } from "../log";

const STATE_COOKIE = "__Secure-boxox-cloudflare-oauth";
const CALLBACK = "/api/cloudflare/callback";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const REVOKE_ENDPOINT = "https://dash.cloudflare.com/oauth2/revoke";
const bytes = (value: string) => new TextEncoder().encode(value);
const base64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const identity = z.object({ account: z.string(), org: z.string(), user: z.string(), client: z.string() });
const stateSchema = identity.extend({ state: z.string(), verifier: z.string(), expiresAt: z.number() });
const credentialsSchema = identity.extend({ accessToken: z.string().min(1).max(8192), refreshToken: z.string().min(1).max(8192), expiresAt: z.number() });
const tokenSchema = z.object({ access_token: z.string().min(1).max(8192), refresh_token: z.string().min(1).max(8192).optional(), expires_in: z.number().positive().max(365 * 86400), token_type: z.string() });
type Credentials = z.infer<typeof credentialsSchema>;

function origin(env: Env) {
  const url = new URL(env.PUBLIC_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Cloudflare OAuth requires an HTTPS public origin");
  return url.origin;
}
export function cloudflareOAuthConfigured(env: Env) {
  try { return !!(env.CF_OAUTH_CLIENT_ID && env.CF_ACCOUNT_ID && env.AGENT_JWT_SECRET && origin(env)); } catch { return false; }
}
export function cloudflareOAuthScopes(env: Env) {
  return ["zone.read", "dns.write", "email-routing-rule.write", ...(isFree(env) ? [] : ["email-sending.write", "queues.write"]), "offline_access"];
}
async function key(env: Env) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(`boxox:cloudflare-oauth:v1:${env.AGENT_JWT_SECRET}`)));
  return importMasterKey(btoa(String.fromCharCode(...digest)));
}
async function seal(env: Env, value: unknown) { return JSON.stringify(await encryptSecret(await key(env), JSON.stringify(value))); }
async function unseal(env: Env, value: string) { return JSON.parse(await decryptSecret(await key(env), JSON.parse(value) as EncryptedSecret)); }
function binding(c: Context<AppContext>, org = c.get("orgId")) {
  return { account: c.env.CF_ACCOUNT_ID!, org, user: c.get("user").id, client: c.env.CF_OAUTH_CLIENT_ID! };
}
const matches = (value: z.infer<typeof identity>, expected: z.infer<typeof identity>) =>
  value.account === expected.account && value.org === expected.org && value.user === expected.user && value.client === expected.client;
function clearState(c: Context<AppContext>) { deleteCookie(c, STATE_COOKIE, { secure: true, httpOnly: true, sameSite: "Lax", path: CALLBACK }); }

/** Owner + same-origin POST only. The callback uses an exact registered URI and PKCE. */
export async function startCloudflareOAuth(c: Context<AppContext>) {
  if (!cloudflareOAuthConfigured(c.env)) return c.json({ error: { code: "oauth_not_configured", message: "Run the Box Ox installer to enable Connect with Cloudflare." } }, 503);
  const state = random(), verifier = random();
  setCookie(c, STATE_COOKIE, base64url(bytes(await seal(c.env, { ...binding(c), state, verifier, expiresAt: Date.now() + 10 * 60_000 }))), {
    secure: true, httpOnly: true, sameSite: "Lax", path: CALLBACK, maxAge: 600,
  });
  const url = new URL("https://dash.cloudflare.com/oauth2/auth");
  url.search = new URLSearchParams({ client_id: c.env.CF_OAUTH_CLIENT_ID!, redirect_uri: origin(c.env) + CALLBACK, response_type: "code", scope: cloudflareOAuthScopes(c.env).join(" "), state, code_challenge: base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(verifier)))), code_challenge_method: "S256" }).toString();
  return c.json({ url: url.href });
}

async function exchange(env: Env, body: URLSearchParams, fetcher: typeof fetch) {
  body.set("client_id", env.CF_OAUTH_CLIENT_ID!);
  const response = await fetcher(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(10_000) });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error("Cloudflare authorization failed") as Error & { invalidGrant?: boolean; status?: number };
    error.invalidGrant = value.error === "invalid_grant";
    error.status = response.status;
    throw error;
  }
  const parsed = tokenSchema.parse(value);
  if (parsed.token_type.toLowerCase() !== "bearer") throw new Error("Unexpected Cloudflare token type");
  return parsed;
}

/** Authentication runs before this handler; state additionally binds the owner and account. */
export async function completeCloudflareOAuth(c: Context<AppContext>, fetcher: typeof fetch = fetch) {
  c.header("cache-control", "no-store, private");
  c.header("referrer-policy", "no-referrer");
  const result = (status: string) => c.redirect(`/domains?cloudflare=${status}`);
  const cookie = getCookie(c, STATE_COOKIE);
  clearState(c);
  if (!cloudflareOAuthConfigured(c.env) || !cookie || cookie.length > 4000) {
    log.warn("cloudflare_oauth_failed", { stage: "state_cookie", configured: cloudflareOAuthConfigured(c.env), cookiePresent: !!cookie });
    return result("failed");
  }
  let stage = "state";
  try {
    const encoded = cookie.replace(/-/g, "+").replace(/_/g, "/");
    const state = stateSchema.parse(await unseal(c.env, new TextDecoder().decode(Uint8Array.from(atob(encoded), x => x.charCodeAt(0)))));
    if (!matches(state, binding(c, state.org)) || state.expiresAt <= Date.now() || state.state !== c.req.query("state")) {
      log.warn("cloudflare_oauth_failed", { stage: "state_binding" });
      return result("failed");
    }
    if (c.req.query("error")) return result("denied");
    const code = c.req.query("code");
    if (!code || code.length > 8192) return result("failed");
    stage = "token_exchange";
    const token = await exchange(c.env, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: origin(c.env) + CALLBACK, code_verifier: state.verifier }), fetcher);
    if (!token.refresh_token) { log.warn("cloudflare_oauth_failed", { stage: "refresh_token_missing" }); return result("failed"); }
    // Check API access before saving; all zone operations remain account-filtered.
    stage = "zone_access";
    await cloudflareClient({ ...c.env, CF_API_TOKEN: token.access_token }, fetcher).listZones();
    const credentials: Credentials = { ...binding(c, state.org), accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 };
    stage = "save_connection";
    await c.env.DB.prepare("INSERT INTO cloudflare_connections (account_id, organization_id, user_id, credentials) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, organization_id, user_id) DO UPDATE SET credentials=excluded.credentials, refresh_lock=NULL, refresh_lock_until=0")
      .bind(state.account, state.org, state.user, await seal(c.env, credentials)).run();
    return result("connected");
  } catch (error) {
    // Do not log request URLs, codes, token responses, cookies, or exception text.
    log.warn("cloudflare_oauth_failed", { stage, status: (error as { status?: number }).status ?? 0, kind: error instanceof z.ZodError ? "invalid_response" : "request_failed" });
    return result("failed");
  }
}

/** A D1 lease serializes refresh-token rotation across Worker isolates. */
export async function cloudflareOAuthToken(c: Context<AppContext>, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!cloudflareOAuthConfigured(c.env) || c.get("user").role !== "owner") return null;
  const id = binding(c);
  const args = [id.account, id.org, id.user];
  const where = "account_id=? AND organization_id=? AND user_id=?";
  const row = await c.env.DB.prepare(`SELECT credentials FROM cloudflare_connections WHERE ${where}`).bind(...args).first<{ credentials: string }>();
  if (!row) return null;
  const credentials = credentialsSchema.parse(await unseal(c.env, row.credentials));
  if (!matches(credentials, id)) return null;
  if (credentials.expiresAt > Date.now() + 60_000) return credentials.accessToken;
  const lock = random();
  const acquired = await c.env.DB.prepare(`UPDATE cloudflare_connections SET refresh_lock=?, refresh_lock_until=? WHERE ${where} AND credentials=? AND refresh_lock_until<?`).bind(lock, Date.now() + 30_000, ...args, row.credentials, Date.now()).run();
  if (!acquired.meta.changes) return credentials.expiresAt > Date.now() ? credentials.accessToken : null;
  try {
    const token = await exchange(c.env, new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken }), fetcher);
    const next: Credentials = { ...id, accessToken: token.access_token, refreshToken: token.refresh_token ?? credentials.refreshToken, expiresAt: Date.now() + token.expires_in * 1000 };
    const saved = await c.env.DB.prepare(`UPDATE cloudflare_connections SET credentials=?, refresh_lock=NULL, refresh_lock_until=0 WHERE ${where} AND refresh_lock=?`).bind(await seal(c.env, next), ...args, lock).run();
    return saved.meta.changes ? next.accessToken : null;
  } catch (error) {
    if ((error as { invalidGrant?: boolean }).invalidGrant) await c.env.DB.prepare(`DELETE FROM cloudflare_connections WHERE ${where} AND refresh_lock=?`).bind(...args, lock).run();
    else await c.env.DB.prepare(`UPDATE cloudflare_connections SET refresh_lock=NULL, refresh_lock_until=0 WHERE ${where} AND refresh_lock=?`).bind(...args, lock).run();
    return credentials.expiresAt > Date.now() ? credentials.accessToken : null;
  }
}

export async function disconnectCloudflareOAuth(c: Context<AppContext>, fetcher: typeof fetch = fetch) {
  if (!c.env.CF_ACCOUNT_ID || !c.env.CF_OAUTH_CLIENT_ID) return;
  const id = binding(c);
  const row = await c.env.DB.prepare("DELETE FROM cloudflare_connections WHERE account_id=? AND organization_id=? AND user_id=? RETURNING credentials").bind(id.account, id.org, id.user).first<{ credentials: string }>();
  if (!row) return;
  // Local removal always succeeds, even if Cloudflare is unavailable. The owner can
  // also revoke the application in Cloudflare's Authorized Applications page.
  try {
    const value = credentialsSchema.parse(await unseal(c.env, row.credentials));
    if (!matches(value, id)) return;
    await fetcher(REVOKE_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id.client, token: value.refreshToken, token_type_hint: "refresh_token" }).toString(), signal: AbortSignal.timeout(10_000) });
  } catch { /* Credentials have already been removed from this installation. */ }
}
