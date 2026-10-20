import { Hono } from "hono";
import type { Env } from "../env";
import type { AppContext } from "../middleware";

/**
 * Safe rendering, server side. Mail HTML is sanitized here before it leaves the
 * Worker, then again by DOMPurify in the browser, and finally shown in a
 * script-less sandboxed frame with its own CSP (web: MessageFrame.policy.ts).
 *
 * Links become signed /api/link/<token> URLs. The route follows only URLs we
 * signed, so it is never an open redirect; for flagged mail it shows a warning
 * page with the real destination instead of redirecting. Remote images lose
 * their src and carry a signed /api/image-proxy/<token> in data-boxox-src,
 * which the frame uses only after the reader allows images.
 */

export type SignedUrlEnv = Pick<Env, "AGENT_JWT_SECRET">;

/** "direct": redirect at once. "warn": warning page first. "disabled": no links (Quarantine). */
export type LinkMode = "direct" | "warn" | "disabled";

interface LinkPayload {
  u: string;
  w?: 1;
}

const enc = new TextEncoder();
const MAX_TOKEN = 4096;

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** Derived from AGENT_JWT_SECRET with its own label, like the tracking key. */
export async function urlSigningKey(env: SignedUrlEnv, label: string): Promise<CryptoKey | null> {
  const secret = env.AGENT_JWT_SECRET?.trim();
  if (!secret) return null;
  const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, enc.encode(label));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signToken(key: CryptoKey, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64url(mac)}`;
}

export async function verifyTokenWith<T>(key: CryptoKey | null, token: string): Promise<T | null> {
  const [body, mac, extra] = token.split(".");
  if (!key || !body || !mac || extra !== undefined || token.length > MAX_TOKEN) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", key, fromB64url(mac), enc.encode(body)))) return null;
    return JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
  } catch {
    return null;
  }
}

/** An absolute http(s) URL, or null. Protocol-relative "//host" counts as https. */
export function httpUrl(value: string): URL | null {
  const v = value.trim().replace(/^\/\//, "https://");
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

const LINK_LABEL = "boxox:link:v1";
const IMAGE_LABEL = "boxox:image-proxy:v1";

export async function signLinkToken(key: CryptoKey, url: string, warn: boolean): Promise<string | null> {
  const parsed = httpUrl(url);
  if (!parsed || parsed.href.length > 2048) return null;
  const payload: LinkPayload = warn ? { u: parsed.href, w: 1 } : { u: parsed.href };
  return signToken(key, payload);
}

export async function verifyLinkToken(env: SignedUrlEnv, token: string): Promise<LinkPayload | null> {
  const payload = await verifyTokenWith<LinkPayload>(await urlSigningKey(env, LINK_LABEL), token);
  if (!payload || typeof payload.u !== "string" || !httpUrl(payload.u)) return null;
  return payload;
}

// --- Sanitizer (HTMLRewriter) ---

/** Removed with everything inside them. */
const DROP_TAGS = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "param", "base", "link", "meta",
  "noscript", "noembed", "noframes", "template", "svg", "math", "portal", "input", "button", "select",
  "textarea", "title", "xmp", "plaintext", "listing", "dialog", "video", "audio", "source", "track", "canvas",
]);
/** Removed, keeping their content. */
const UNWRAP_TAGS = new Set(["form", "fieldset", "label", "html", "head", "body"]);
const DROP_ATTRS = new Set([
  "srcdoc", "action", "formaction", "srcset", "lowsrc", "dynsrc", "background", "poster", "ping", "data",
  "codebase", "cite", "longdesc", "xlink:href", "xmlns:xlink", "http-equiv", "autofocus", "contenteditable",
  "target", "rel", "referrerpolicy", "integrity", "nonce", "is",
]);
const DANGEROUS_STYLE = /expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding/i;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i;
const ATTACHMENT_SRC = /^\/api\/orgs\/[^/?#]+\/attachments\/[^/?#]+\?inline=1$/;
const MAX_PASSES = 4;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", colon: ":", tab: "\t", newline: "\n" };

/** Attribute values from HTMLRewriter are raw; decode character references before judging a URL. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[ref.toLowerCase()] ?? m;
  });
}

/** Browsers drop tabs and newlines anywhere in a URL, and surrounding spaces and control characters. */
const cleanUrl = (raw: string) => decodeEntities(raw).replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");

/** setAttribute writes values as given; URLs are already free of quotes and angle brackets. */
const titleOf = (url: URL) => url.href.slice(0, 300).replace(/&/g, "&amp;");

export interface PrepareOptions {
  links: LinkMode;
}

type Keys = { link: CryptoKey | null; image: CryptoKey | null };

/** One pass. Without keys it only strips; with keys it also points links and images at the signed routes. */
async function sanitizePass(html: string, opts: PrepareOptions, keys: Keys | null): Promise<string> {
  const rewriter = new HTMLRewriter()
    .onDocument({
      comments(c) {
        c.remove();
      },
    })
    .on("*", {
      async element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROP_TAGS.has(tag) || tag.includes(":")) {
          el.remove();
          return;
        }
        if (UNWRAP_TAGS.has(tag) || !/^[a-z][a-z0-9-]*$/.test(tag)) {
          el.removeAndKeepContent();
          return;
        }

        for (const [rawName = "", value = ""] of [...el.attributes]) {
          const name = rawName.toLowerCase();
          if (name.startsWith("on") || name.startsWith("data-boxox") || DROP_ATTRS.has(name) || name.includes(":")) {
            el.removeAttribute(rawName);
          } else if (name === "style" && DANGEROUS_STYLE.test(decodeEntities(value))) {
            el.removeAttribute(rawName);
          } else if ((name === "href" && tag !== "a" && tag !== "area") || (name === "src" && tag !== "img")) {
            el.removeAttribute(rawName);
          }
        }

        if (tag === "a" || tag === "area") {
          const raw = el.getAttribute("href");
          if (raw === null) return;
          const href = cleanUrl(raw);
          const target = httpUrl(href);
          if (target && opts.links !== "disabled") {
            if (!keys) return;
            const token = keys.link && (await signLinkToken(keys.link, target.href, opts.links === "warn"));
            if (!token) {
              el.removeAttribute("href");
              return;
            }
            el.setAttribute("href", `/api/link/${token}`);
            el.setAttribute("title", titleOf(target));
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "noopener noreferrer");
          } else if (/^mailto:[^"'<>]*$/i.test(href) && opts.links !== "disabled") {
            if (keys) el.setAttribute("target", "_blank");
          } else if (!/^#[\w.:-]*$/.test(href)) {
            el.removeAttribute("href");
            if (target) el.setAttribute("title", titleOf(target));
          }
        }

        if (tag === "img") {
          const raw = el.getAttribute("src");
          if (raw === null) return;
          const src = cleanUrl(raw);
          if (SAFE_DATA_IMAGE.test(src) || ATTACHMENT_SRC.test(src) || /^cid:[^"'<>\s]*$/i.test(src)) return;
          const remote = httpUrl(src);
          if (remote && !keys) return;
          el.removeAttribute("src");
          const token = remote && keys?.image && (await signImageToken(keys.image, remote.href));
          if (token) el.setAttribute("data-boxox-src", `/api/image-proxy/${token}`);
        }
      },
    });
  return rewriter.transform(new Response(html)).text();
}

/**
 * Sanitizes one message's HTML for the frame. Stripping repeats until the
 * output is stable, so markup that only forms once something was removed
 * (`<scr<script>x</script>ipt>`) is caught too; if it never settles, the
 * message is shown as escaped text. A last pass signs links and images.
 */
export async function prepareMailHtml(env: SignedUrlEnv, html: string, opts: PrepareOptions): Promise<string> {
  let current = html;
  for (let pass = 0; ; pass++) {
    const next = await sanitizePass(current, opts, null);
    if (next === current) break;
    if (pass === MAX_PASSES) return `<pre>${escapeHtml(html)}</pre>`;
    current = next;
  }
  const keys = { link: await urlSigningKey(env, LINK_LABEL), image: await urlSigningKey(env, IMAGE_LABEL) };
  return sanitizePass(current, opts, keys);
}

export async function signImageToken(key: CryptoKey, url: string): Promise<string | null> {
  const parsed = httpUrl(url);
  if (!parsed || parsed.href.length > 2048) return null;
  return signToken(key, { u: parsed.href });
}

export async function verifyImageToken(env: SignedUrlEnv, token: string): Promise<string | null> {
  const payload = await verifyTokenWith<{ u?: unknown }>(await urlSigningKey(env, IMAGE_LABEL), token);
  return typeof payload?.u === "string" && httpUrl(payload.u) ? payload.u : null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// --- Link page ---

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store, private",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;background:#0e1014;color:#e6e8ec;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:560px;padding:32px}h1{font-size:20px}code{display:block;word-break:break-all;background:#1a1d23;padding:12px;border-radius:8px;margin:12px 0}a.go{display:inline-block;background:#e6e8ec;color:#0e1014;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:600}p{color:#9ba1ad;line-height:1.5}</style></head><body><main>${body}</main></body></html>`;
}

/**
 * GET /api/link/:token. A valid token for normal mail redirects with no
 * referrer; one for flagged mail shows where the link really goes. Anything
 * unsigned or altered gets an error page and is never followed.
 */
export const linkRoutes = new Hono<AppContext>().get("/:token", async (c) => {
  const payload = await verifyLinkToken(c.env, c.req.param("token"));
  if (!payload) {
    return new Response(page("Link not valid", "<h1>This link can't be opened</h1><p>Box Ox only opens links from your own mail, and this one wasn't signed by this mailbox.</p>"), {
      status: 400,
      headers: PAGE_HEADERS,
    });
  }
  if (!payload.w) {
    return new Response(null, { status: 302, headers: { location: payload.u, "cache-control": "no-store, private", "referrer-policy": "no-referrer" } });
  }
  const host = new URL(payload.u).hostname;
  return new Response(
    page(
      "Check this link",
      `<h1>Check this link before you open it</h1><p>This message was flagged as suspicious. The link goes to <strong>${escapeHtml(host)}</strong>:</p><code>${escapeHtml(payload.u)}</code><p>Only continue if you trust this site. Never enter a password on a page you reached from a suspicious email.</p><a class="go" href="${escapeHtml(payload.u)}" rel="noopener noreferrer">Continue to ${escapeHtml(host)}</a>`,
    ),
    { status: 200, headers: PAGE_HEADERS },
  );
});
