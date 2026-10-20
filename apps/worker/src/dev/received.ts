import { and, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { addresses, apiKeys, attachments, domains, messages, threads } from "@boxox/db";
import type { Db } from "../db";
import { createDb } from "../db";
import type { Env } from "../env";
import { attachmentKey } from "../services/attachments";
import type { AuthenticatedKey } from "./keys";
import { MessageError } from "./messages";
import { emitWebhookEvent, type WebhookEnv } from "./webhooks";

/**
 * The receiving API: inbound mail to the key's domain's app-inbox addresses
 * (delivery mode webhook or both). Ingest stores it like any other mail; this
 * only reads it. The raw .eml goes out through a short-lived signed URL, so a
 * download link can be handed to another process without the API key.
 */

export type RawUrlEnv = Pick<Env, "AGENT_JWT_SECRET" | "PUBLIC_URL">;

export const DEFAULT_RAW_TTL_S = 15 * 60;
export const MAX_RAW_TTL_S = 3600;

interface RawToken {
  /** messages.id */
  m: string;
  /** api_keys.id that asked for the link */
  k: string;
  /** Expiry, epoch seconds. */
  e: number;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** Derived from AGENT_JWT_SECRET with its own label, like the tracking key. */
async function signingKey(env: RawUrlEnv): Promise<CryptoKey | null> {
  const secret = env.AGENT_JWT_SECRET?.trim();
  if (!secret) return null;
  const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, enc.encode("boxox:received-raw:v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signRawToken(env: RawUrlEnv, payload: RawToken): Promise<string | null> {
  const key = await signingKey(env);
  if (!key) return null;
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64url(mac)}`;
}

/** The payload of an unexpired token we signed, or null. */
export async function verifyRawToken(env: RawUrlEnv, token: string, now = Date.now()): Promise<RawToken | null> {
  const key = await signingKey(env);
  const [body, mac, extra] = token.split(".");
  if (!key || !body || !mac || extra !== undefined || token.length > 1024) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", key, fromB64url(mac), enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as RawToken;
    if (typeof p.m !== "string" || typeof p.k !== "string" || typeof p.e !== "number") return null;
    return p.e * 1000 > now ? p : null;
  } catch {
    return null;
  }
}

const isAppInbox = inArray(addresses.deliveryMode, ["webhook", "both"]);

/** Everything a domain key may see: its domain, app inboxes, allowedRecipients, never quarantine. */
function scope(key: AuthenticatedKey): SQL[] {
  const where: SQL[] = [
    eq(addresses.domainId, key.domainId!),
    eq(messages.direction, "inbound"),
    isAppInbox,
    ne(threads.folder, "quarantine"),
    ne(messages.scanStatus, "pending"),
  ];
  if (key.allowedRecipients.length) {
    const suffix = `@${key.domainName}`;
    const locals = key.allowedRecipients.filter((a) => a.endsWith(suffix)).map((a) => a.slice(0, -suffix.length));
    where.push(locals.length ? inArray(sql`lower(${addresses.localPart})`, locals) : sql`0`);
  }
  return where;
}

const columns = {
  id: messages.id,
  localPart: addresses.localPart,
  fromEmail: messages.fromEmail,
  fromName: messages.fromName,
  toEmails: messages.toEmails,
  ccEmails: messages.ccEmails,
  subject: messages.subject,
  snippet: messages.snippet,
  rfcMessageId: messages.rfcMessageId,
  inReplyTo: messages.inReplyTo,
  references: messages.references,
  authenticated: messages.authenticated,
  folder: threads.folder,
  r2Key: messages.r2Key,
  rawMimeKey: messages.rawMimeKey,
  occurredAt: messages.occurredAt,
};

function receivedQuery(db: Db) {
  return db
    .select(columns)
    .from(messages)
    .innerJoin(addresses, eq(addresses.id, messages.addressId))
    .innerJoin(threads, eq(threads.id, messages.threadId));
}

type ReceivedRow = Awaited<ReturnType<typeof receivedQuery>>[number];

function summary(row: ReceivedRow, domainName: string | null) {
  return {
    id: row.id,
    object: "received_email",
    to: `${row.localPart.toLowerCase()}@${domainName}`,
    from: row.fromName ? { email: row.fromEmail, name: row.fromName } : { email: row.fromEmail },
    toEmails: row.toEmails,
    ccEmails: row.ccEmails,
    subject: row.subject,
    snippet: row.snippet,
    spam: row.folder === "spam",
    receivedAt: row.occurredAt.toISOString(),
  };
}

async function ownReceived(db: Db, key: AuthenticatedKey, id: string): Promise<ReceivedRow> {
  const [row] = await receivedQuery(db)
    .where(and(eq(messages.id, id), ...scope(key)))
    .limit(1);
  if (!row) throw new MessageError(404, "not_found", "No such received email");
  return row;
}

function encodeCursor(row: ReceivedRow) {
  return btoa(`${row.occurredAt.getTime()}:${row.id}`).replace(/=+$/, "");
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const [at, id] = atob(cursor).split(":");
    const ms = Number(at);
    if (id && Number.isFinite(ms)) return { at: new Date(ms), id };
  } catch {}
  throw new MessageError(400, "bad_request", "Invalid cursor", "cursor");
}

export interface ReceivedFilters {
  to?: string;
  cursor?: string;
  limit?: number;
}

/** Newest first, keyset-paginated. */
export async function listReceived(db: Db, key: AuthenticatedKey, filters: ReceivedFilters) {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const where = scope(key);
  if (filters.to) {
    const to = filters.to.trim().toLowerCase();
    const at = to.lastIndexOf("@");
    if (at < 1 || to.slice(at + 1) !== key.domainName) {
      throw new MessageError(400, "bad_request", "to must be an address on this key's domain", "to");
    }
    where.push(eq(sql`lower(${addresses.localPart})`, to.slice(0, at)));
  }
  if (filters.cursor) {
    const c = decodeCursor(filters.cursor);
    where.push(or(lt(messages.occurredAt, c.at), and(eq(messages.occurredAt, c.at), lt(messages.id, c.id)))!);
  }
  const rows = await receivedQuery(db)
    .where(and(...where))
    .orderBy(desc(messages.occurredAt), desc(messages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    data: page.map((r) => summary(r, key.domainName)),
    nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null,
  };
}

/** Parsed fields, authentication result, bodies and attachment metadata. */
export async function getReceived(env: Pick<Env, "DB" | "MAIL_STORE">, key: AuthenticatedKey, id: string) {
  const db = createDb(env);
  const row = await ownReceived(db, key, id);
  const obj = await env.MAIL_STORE.get(row.r2Key);
  const body = obj ? ((await obj.json()) as { text?: string | null; html?: string | null }) : null;
  const atts = await db
    .select({
      id: attachments.id,
      filename: attachments.filename,
      declaredType: attachments.declaredType,
      detectedType: attachments.detectedType,
      size: attachments.size,
      risk: attachments.risk,
      contentId: attachments.contentId,
      inline: attachments.inline,
    })
    .from(attachments)
    .where(eq(attachments.messageId, row.id))
    .orderBy(attachments.id);
  return {
    ...summary(row, key.domainName),
    messageId: row.rfcMessageId,
    inReplyTo: row.inReplyTo,
    references: row.references,
    authentication: { authenticated: row.authenticated },
    text: body?.text ?? null,
    html: body?.html ?? null,
    attachments: atts,
    hasRaw: !!row.rawMimeKey,
  };
}

/** One attachment of a received email, with the same safe headers as the inbox. */
export async function receivedAttachment(db: Db, key: AuthenticatedKey, messageId: string, attachmentId: string) {
  const row = await ownReceived(db, key, messageId);
  const [att] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.messageId, row.id)))
    .limit(1);
  if (!att) throw new MessageError(404, "not_found", "No such attachment");
  return { ...att, r2Key: attachmentKey(att.sha256) };
}

/** A signed URL for the original .eml, valid for `ttlSeconds`. */
export async function rawDownloadUrl(env: RawUrlEnv & Pick<Env, "DB">, key: AuthenticatedKey, id: string, ttlSeconds = DEFAULT_RAW_TTL_S, now = Date.now()) {
  const row = await ownReceived(createDb(env), key, id);
  if (!row.rawMimeKey) throw new MessageError(404, "not_found", "The original message is no longer stored");
  const base = env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  const expires = Math.floor(now / 1000) + Math.min(Math.max(Math.floor(ttlSeconds), 60), MAX_RAW_TTL_S);
  const token = await signRawToken(env, { m: row.id, k: key.id, e: expires });
  if (!token || !base) throw new MessageError(409, "not_configured", "Raw downloads need PUBLIC_URL and AGENT_JWT_SECRET on this install");
  return {
    url: `${base}/dev/v1/received/raw/${token}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

/**
 * Resolves a signed raw link. The key that signed it must still be live and
 * hold read_received, so revoking a key also kills its outstanding links.
 */
export async function resolveRawToken(env: RawUrlEnv & Pick<Env, "DB">, token: string, now = Date.now()) {
  const payload = await verifyRawToken(env, token, now);
  if (!payload) return null;
  const db = createDb(env);
  const [key] = await db
    .select({ id: apiKeys.id, permissions: apiKeys.permissions, expiresAt: apiKeys.expiresAt, domainId: apiKeys.domainId })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, payload.k), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!key || !key.permissions.includes("read_received")) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= now) return null;
  const [row] = await db
    .select({ id: messages.id, rawMimeKey: messages.rawMimeKey })
    .from(messages)
    .innerJoin(addresses, eq(addresses.id, messages.addressId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(and(eq(messages.id, payload.m), eq(addresses.domainId, key.domainId ?? ""), isAppInbox, ne(threads.folder, "quarantine"), ne(messages.scanStatus, "pending")))
    .limit(1);
  return row?.rawMimeKey ? { id: row.id, rawMimeKey: row.rawMimeKey } : null;
}

/**
 * `message.received` for a stored inbound message on an app inbox. The event
 * id is derived from the message id, so a replayed ingest step never sends it twice.
 */
export async function emitReceivedEvent(env: WebhookEnv, messageId: string): Promise<string[]> {
  const db = createDb(env);
  const [row] = await receivedQuery(db)
    .where(and(eq(messages.id, messageId), eq(messages.direction, "inbound"), isAppInbox, ne(threads.folder, "quarantine"), ne(messages.scanStatus, "pending")))
    .limit(1);
  if (!row) return [];
  const [domain] = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .innerJoin(addresses, eq(addresses.domainId, domains.id))
    .innerJoin(messages, eq(messages.addressId, addresses.id))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!domain) return [];
  const data = summary(row, domain.name.toLowerCase());
  return emitWebhookEvent(env, domain.id, "message.received", data, { eventId: `received_${messageId}` });
}
