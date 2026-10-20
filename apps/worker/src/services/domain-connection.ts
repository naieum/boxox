import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppContext } from "../middleware";
import type { Env } from "../env";
import { decryptSecret, encryptSecret, importMasterKey, type EncryptedSecret } from "../crypto";
import { cloudflareOAuthToken } from "./cloudflare-oauth";

export const DOMAIN_CONNECTION_SECONDS = 15 * 60;
export const DOMAIN_CONNECTION_COOKIE = "__Secure-boxox-domain-connection";
export const domainTokenSchema = z.string().trim().min(10).max(512).regex(/^[\x21-\x7e]+$/);
const connectionSchema = z.object({ token: domainTokenSchema, user: z.string(), org: z.string(), account: z.string(), expiresAt: z.number() });

const path = (c: Context<AppContext>) => `/api/orgs/${encodeURIComponent(c.get("orgId"))}/domains`;
async function key(env: Env) {
  if (!env.AGENT_JWT_SECRET) throw new Error("Domain connection encryption is unavailable");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`boxox:domain-connection:v1:${env.AGENT_JWT_SECRET}`)));
  return importMasterKey(btoa(String.fromCharCode(...digest)));
}

/** Credentials live only in a short-lived, encrypted HttpOnly cookie and request memory. */
export async function connectDomainAccount(c: Context<AppContext>, token: string): Promise<number> {
  const expiresAt = Date.now() + DOMAIN_CONNECTION_SECONDS * 1000;
  const record = await encryptSecret(await key(c.env), JSON.stringify({ token, user: c.get("user").id, org: c.get("orgId"), account: c.env.CF_ACCOUNT_ID, expiresAt }));
  setCookie(c, DOMAIN_CONNECTION_COOKIE, btoa(JSON.stringify(record)), {
    httpOnly: true, secure: true, sameSite: "Strict", path: path(c), maxAge: DOMAIN_CONNECTION_SECONDS,
  });
  return expiresAt;
}

export function disconnectDomainAccount(c: Context<AppContext>) {
  deleteCookie(c, DOMAIN_CONNECTION_COOKIE, { httpOnly: true, secure: true, sameSite: "Strict", path: path(c) });
}

export async function domainConnection(c: Context<AppContext>, fetcher: typeof fetch = fetch): Promise<{ env: Env; expiresAt: number | null; oauth?: boolean }> {
  const base = { env: c.env, expiresAt: null };
  if (c.get("user").role === "owner") {
    try {
      const token = await cloudflareOAuthToken(c, fetcher);
      if (token) return { env: { ...c.env, CF_API_TOKEN: token }, expiresAt: null, oauth: true };
    } catch { /* A damaged or revoked connection must fail closed; offer reconnect. */ }
  }
  const cookie = getCookie(c, DOMAIN_CONNECTION_COOKIE);
  if (!cookie || cookie.length > 4000 || c.get("user").role !== "owner") return base;
  try {
    const payload = connectionSchema.parse(JSON.parse(await decryptSecret(await key(c.env), JSON.parse(atob(cookie)) as EncryptedSecret)));
    if (payload.user !== c.get("user").id || payload.org !== c.get("orgId") || payload.account !== c.env.CF_ACCOUNT_ID || payload.expiresAt <= Date.now()) return base;
    return { env: { ...c.env, CF_API_TOKEN: payload.token }, expiresAt: payload.expiresAt };
  } catch { return base; }
}
