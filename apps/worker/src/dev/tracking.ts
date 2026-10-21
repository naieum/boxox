import { eq } from "drizzle-orm";
import { apiMessages, domains, messageEvents } from "@boxox/db";
import type { Db } from "../db";
import type { Env } from "../env";
import { log } from "../log";
import { fanoutMessageEvent, type EventFanoutEnv } from "./event-fanout";

/**
 * Open and click tracking for /dev/v1 mail. Off unless the domain or the
 * message turns it on. Links become signed /t/c/ redirects and opens a 1×1
 * /t/o/ pixel; only URLs we signed are ever followed, so there is no open redirect.
 */

export type TrackingEnv = Pick<Env, "BOXOX_SIGNING_SECRET" | "PUBLIC_URL">;

interface TokenPayload {
  /** api_messages.id */
  m: string;
  /** Click target and its position in the HTML; absent for the open pixel. */
  u?: string;
  l?: number;
}

const enc = new TextEncoder();
const MINUTE_MS = 60_000;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** A key of its own, derived from BOXOX_SIGNING_SECRET so tracking needs no extra secret. */
async function signingKey(env: TrackingEnv): Promise<CryptoKey | null> {
  const secret = env.BOXOX_SIGNING_SECRET?.trim();
  if (!secret) return null;
  const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, enc.encode("boxox:tracking:v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(key: CryptoKey, payload: TokenPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64url(mac)}`;
}

/** The payload of a token we signed, or null for anything else. */
export async function verifyToken(env: TrackingEnv, token: string): Promise<TokenPayload | null> {
  const key = await signingKey(env);
  const [body, mac, extra] = token.split(".");
  if (!key || !body || !mac || extra !== undefined || token.length > 4096) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", key, fromB64url(mac), enc.encode(body)))) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as TokenPayload;
    if (typeof payload.m !== "string") return null;
    if (payload.u !== undefined && !isHttpUrl(payload.u)) return null;
    return payload;
  } catch {
    return null;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export interface TrackOptions {
  messageId: string;
  opens: boolean;
  clicks: boolean;
}

/**
 * Rewrites http(s) links to signed redirects and appends the pixel. Returns
 * the HTML untouched when neither is on, or when PUBLIC_URL or the secret is missing.
 */
export async function instrumentHtml(env: TrackingEnv, html: string, opts: TrackOptions): Promise<string> {
  if (!opts.opens && !opts.clicks) return html;
  const key = await signingKey(env);
  const base = env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!key || !base || !isHttpUrl(base)) {
    log.warn("tracking_unavailable", { messageId: opts.messageId, reason: key ? "public_url" : "secret" });
    return html;
  }

  let out = html;
  if (opts.clicks) {
    const anchors = /<a\b[^>]*>/gi;
    const parts: string[] = [];
    let last = 0;
    let index = 0;
    for (const match of html.matchAll(anchors)) {
      const tag = match[0];
      const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const url = href ? decodeAttr(href[1] ?? href[2] ?? "") : "";
      if (!href || !isHttpUrl(url)) continue;
      const signed = `${base}/t/c/${await sign(key, { m: opts.messageId, u: url, l: index++ })}`;
      parts.push(html.slice(last, match.index), tag.replace(href[0], ` href="${signed}"`));
      last = match.index + tag.length;
    }
    out = parts.join("") + html.slice(last);
  }
  if (opts.opens) {
    const pixel = `<img src="${base}/t/o/${await sign(key, { m: opts.messageId })}" width="1" height="1" alt="" style="border:0;width:1px;height:1px" />`;
    const close = out.search(/<\/body\s*>/i);
    out = close === -1 ? out + pixel : out.slice(0, close) + pixel + out.slice(close);
  }
  return out;
}

/** Message flags or the domain's setting; either one turns tracking on. */
export async function trackingFor(
  db: Db,
  row: { domainId: string; trackOpens: boolean; trackClicks: boolean },
): Promise<{ opens: boolean; clicks: boolean }> {
  if (row.trackOpens && row.trackClicks) return { opens: true, clicks: true };
  const [domain] = await db
    .select({ trackOpens: domains.trackOpens, trackClicks: domains.trackClicks })
    .from(domains)
    .where(eq(domains.id, row.domainId))
    .limit(1);
  return { opens: row.trackOpens || !!domain?.trackOpens, clicks: row.trackClicks || !!domain?.trackClicks };
}

/**
 * One event per message (and link) per minute, so a client reloading the
 * pixel can't flood the table. The detail never holds the query string.
 */
export async function recordTrackingEvent(db: Db, payload: TokenPayload, userAgent: string | undefined, now = Date.now(), env?: EventFanoutEnv) {
  const [row] = await db.select({ id: apiMessages.id }).from(apiMessages).where(eq(apiMessages.id, payload.m)).limit(1);
  if (!row) return false;
  const bucket = Math.floor(now / MINUTE_MS);
  const click = payload.u !== undefined;
  const target = click ? new URL(payload.u!) : null;
  const eventId = click ? `clicked:${row.id}:${payload.l ?? 0}:${bucket}` : `opened:${row.id}:${bucket}`;
  await db
    .insert(messageEvents)
    .values({
      id: eventId,
      apiMessageId: row.id,
      type: click ? "clicked" : "opened",
      detail: {
        ...(target ? { link: payload.l ?? 0, url: `${target.origin}${target.pathname}` } : {}),
        ...(userAgent ? { userAgent: userAgent.slice(0, 256) } : {}),
      },
      occurredAt: new Date(now),
    })
    .onConflictDoNothing();
  if (env) await fanoutMessageEvent(env, row.id, eventId);
  return true;
}
