import { Hono } from "hono";
import type { AppContext } from "../middleware";
import { detectType } from "../services/attachments";
import { httpUrl, verifyImageToken } from "./link";

/**
 * GET /api/image-proxy/:token. Remote images in mail load through here once the
 * reader allows them, as Gmail does: the sender sees the Worker, never the
 * reader's IP, cookies, referrer or browser headers. Only URLs we signed are
 * fetched; size, time and redirects are bounded, and only raster images
 * (by magic bytes, never the upstream type) are served back.
 */

export const IMAGE_PROXY_MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const PROXY_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon"]);

/** The only headers the upstream sees. */
const UPSTREAM_HEADERS = {
  accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
  "user-agent": "Mozilla/5.0 (compatible; BoxOx-ImageProxy/1.0)",
};

const IPV4_PRIVATE = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^2(2[4-9]|[3-5]\d)\./];

/** Public hosts on the default ports only: no loopback, private ranges, IPv6 literals or internal names. */
export function proxyableUrl(url: URL): boolean {
  if (url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || host === "localhost" || !host.includes(".")) return false;
  if (/\.(localhost|local|internal|home|lan|corp)$/.test(host)) return false;
  if (/^\d+(\.\d+){3}$/.test(host) && IPV4_PRIVATE.some((r) => r.test(host))) return false;
  return true;
}

function fail(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

async function readLimited(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export const imageProxyRoutes = new Hono<AppContext>().get("/:token", async (c) => {
  const signed = await verifyImageToken(c.env, c.req.param("token"));
  if (!signed) return fail(403, "Not a signed image URL");

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = new URL(signed);
  let upstream: Response | null = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!proxyableUrl(url)) return fail(400, "Image host not allowed");
      // A fresh request: nothing from the reader's request (cookies, referrer, IP, Access JWT) is forwarded.
      const res = await fetch(new Request(url.href, { method: "GET", headers: UPSTREAM_HEADERS, redirect: "manual", signal }));
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) {
        upstream = res;
        break;
      }
      await res.body?.cancel();
      const next = httpUrl(new URL(location, url).href);
      if (!next) return fail(502, "Bad redirect");
      url = next;
    }
  } catch {
    return fail(504, "Image fetch failed");
  }
  if (!upstream) return fail(502, "Too many redirects");
  if (!upstream.ok || !upstream.body) return fail(502, "Image unavailable");
  const declared = Number(upstream.headers.get("content-length") ?? 0);
  if (declared > IMAGE_PROXY_MAX_BYTES) {
    await upstream.body.cancel();
    return fail(413, "Image too large");
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readLimited(upstream.body, IMAGE_PROXY_MAX_BYTES);
  } catch {
    return fail(504, "Image fetch failed");
  }
  if (!bytes) return fail(413, "Image too large");
  const type = detectType(bytes);
  if (!PROXY_TYPES.has(type)) return fail(415, "Not an image");

  // Upstream headers (Set-Cookie, caching, CORS, links) are never copied.
  return new Response(bytes, {
    headers: {
      "content-type": type,
      "content-length": String(bytes.byteLength),
      "content-disposition": 'inline; filename="image"',
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
});
