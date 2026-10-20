import type { components } from "./schema.js";

/**
 * Standard Webhooks verification: `webhook-signature` holds space-separated
 * `v1,<base64 HMAC-SHA256(id.timestamp.body)>` entries (two during a secret
 * rotation). Uses Web Crypto, so it runs in Node 20+, Workers and Deno.
 */

export type WebhookEvent = components["schemas"]["WebhookEvent"];
export type WebhookEventType = components["schemas"]["WebhookEventType"];
export type ReceivedEmailEvent = WebhookEvent & { type: "message.received"; data: components["schemas"]["ReceivedEmail"] };

export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;
const SECRET_PREFIX = "whsec_";

export class WebhookVerificationError extends Error {
  readonly name = "WebhookVerificationError";
}

type HeadersLike = Headers | Record<string, string | string[] | undefined>;

export interface VerifyOptions {
  /** Reject timestamps further than this from now, either way. Default 300. */
  toleranceSeconds?: number;
  /** Current time in ms, for tests. */
  now?: number;
}

function header(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(" ") : v;
  }
  return undefined;
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function secretBytes(secret: string): Uint8Array {
  try {
    return fromB64(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret);
  } catch {
    throw new WebhookVerificationError("The webhook secret is not valid base64");
  }
}

function bodyBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

async function hmac(secret: string, id: string, timestamp: string, body: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secretBytes(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, signed as BufferSource));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** `v1,<base64>`: the value Box Ox puts in webhook-signature. Handy for tests. */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string | Uint8Array | ArrayBuffer): Promise<string> {
  return `v1,${toB64(await hmac(secret, id, String(timestamp), bodyBytes(body)))}`;
}

/**
 * Checks the signature and timestamp on a delivery and returns the parsed
 * event. Pass the raw body exactly as received, before any JSON parsing.
 * `secret` may be a list, for your side of a rotation. Throws
 * WebhookVerificationError on any failure.
 */
export async function verifyWebhook(
  body: string | Uint8Array | ArrayBuffer,
  headers: HeadersLike,
  secret: string | string[],
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signature = header(headers, "webhook-signature");
  if (!id || !timestamp || !signature) throw new WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature");
  if (!/^\d{1,15}$/.test(timestamp)) throw new WebhookVerificationError("Invalid webhook-timestamp");

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowS = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowS - Number(timestamp)) > tolerance) throw new WebhookVerificationError("Timestamp outside the tolerance window");

  const presented: Uint8Array[] = [];
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    try {
      presented.push(fromB64(value));
    } catch {}
  }
  if (!presented.length) throw new WebhookVerificationError("No v1 signature");

  const bytes = bodyBytes(body);
  const secrets = Array.isArray(secret) ? secret : [secret];
  if (!secrets.length) throw new WebhookVerificationError("No webhook secret given");
  for (const s of secrets) {
    const expected = await hmac(s, id, timestamp, bytes);
    if (presented.some((p) => timingSafeEqual(p, expected))) {
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as WebhookEvent;
      } catch {
        throw new WebhookVerificationError("The body is not JSON");
      }
    }
  }
  throw new WebhookVerificationError("No signature matched");
}

/** verifyWebhook for a fetch Request (Workers, Hono, Next.js route handlers). */
export async function verifyWebhookRequest(request: Request, secret: string | string[], options?: VerifyOptions): Promise<WebhookEvent> {
  return verifyWebhook(new Uint8Array(await request.arrayBuffer()), request.headers, secret, options);
}
