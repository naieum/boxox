import { isFree } from "../services/capabilities";
import { copyApiSentMessage } from "../services/api-sent-copy";
import type { WorkflowStep } from "cloudflare:workers";
import { and, asc, count, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { apiMessages, domains, idempotencyKeys, messageEvents } from "@boxox/db";
import { base64Size, parseAddress } from "@boxox/shared";
import { z } from "zod";
import { batch, createDb, type Db } from "../db";
import type { Env, SendParams } from "../env";
import { log } from "../log";
import { classifySendError, sendErrorMessage, type SendErrorKind } from "../services/outbound/errors";
import { sendCapViolation } from "../services/outbound/cap-error";
import { sendingPause, suppressedRecipients } from "../services/outbound/safety";
import { keyMaySendFrom } from "./auth";
import type { AuthenticatedKey } from "./keys";
import { instrumentHtml, trackingFor, type TrackingEnv } from "./tracking";
import { fanoutMessageEvent, type EventFanoutEnv } from "./event-fanout";

/**
 * /dev/v1/messages: mail the owner's apps send with a domain key. Persist
 * first, like the mailbox: the body goes to R2 and the api_messages row to D1
 * before a SendWorkflow instance exists.
 */

export const MAX_RECIPIENTS = 50;
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const MAX_BATCH = 100;
export const MAX_SCHEDULE_MS = 365 * 24 * 3600 * 1000;
export const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** Accepted by Email Sending besides X-* (docs/spikes/email.md). */
const ALLOWED_HEADERS = new Set(
  ["In-Reply-To", "References", "List-Unsubscribe", "List-Unsubscribe-Post", "List-Id", "Auto-Submitted", "Precedence", "Thread-Topic"].map(
    (h) => h.toLowerCase(),
  ),
);

export class MessageError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 429 | 503,
    readonly code: string,
    message: string,
    readonly param?: string,
  ) {
    super(message);
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.param ? { param: this.param } : {}) };
  }
}

const address = z.string().trim().min(3).max(320);
const addressList = z.union([address, z.array(address).max(MAX_RECIPIENTS)]).transform((v) => (Array.isArray(v) ? v : [v]));

export const sendSchema = z
  .object({
    from: address,
    to: addressList,
    cc: addressList.optional(),
    bcc: addressList.optional(),
    replyTo: address.optional(),
    subject: z.string().max(998),
    html: z.string().optional(),
    text: z.string().optional(),
    headers: z.record(z.string().max(2000)).optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().trim().min(1).max(255),
          content: z.string().min(1),
          contentType: z.string().max(255).optional(),
          contentId: z.string().trim().min(1).max(255).optional(),
        }),
      )
      .max(100)
      .optional(),
    tags: z.record(z.string().max(256)).optional(),
    sendAt: z.string().datetime({ offset: true }).optional(),
    track: z.object({ opens: z.boolean().optional(), clicks: z.boolean().optional() }).optional(),
  })
  .strict();

export type SendInput = z.infer<typeof sendSchema>;

export const batchSchema = z.object({
  mode: z.enum(["all_or_nothing", "partial"]).default("all_or_nothing"),
  messages: z.array(z.unknown()).min(1).max(MAX_BATCH),
});

export const rescheduleSchema = z.object({ sendAt: z.string().datetime({ offset: true }) }).strict();

export function zodError(error: z.ZodError, prefix?: string): MessageError {
  const issue = error.issues[0];
  const path = [...(prefix ? [prefix] : []), ...(issue?.path ?? [])].join(".");
  return new MessageError(400, "bad_request", issue?.message ?? "Invalid request", path || undefined);
}

interface StoredBody {
  text: string;
  html: string | null;
  headers: Record<string, string>;
  attachments: { filename: string; content: string; contentType: string; contentId?: string }[];
}

/** Plain text for clients that won't render HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => `${label} (${href})`)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function recipients(list: string[] | undefined, param: string): string[] {
  return (list ?? []).map((raw) => {
    const { email } = parseAddress(raw);
    if (!EMAIL_RE.test(email)) throw new MessageError(400, "bad_request", `${raw} is not an email address`, param);
    return email;
  });
}

export interface PreparedMessage {
  id: string;
  from: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  tags: Record<string, string>;
  scheduledAt: Date | null;
  trackOpens: boolean;
  trackClicks: boolean;
  templateId?: string | null;
  body: StoredBody;
}

/** Validates one message for `key`; throws MessageError. Nothing is written. */
export function prepareMessage(key: AuthenticatedKey, raw: unknown, now = Date.now()): PreparedMessage {
  const parsed = sendSchema.safeParse(raw);
  if (!parsed.success) throw zodError(parsed.error);
  const input = parsed.data;

  if (!keyMaySendFrom(key, input.from)) {
    throw new MessageError(403, "from_not_allowed", "This key may not send from that address", "from");
  }
  const from = parseAddress(input.from);
  const to = recipients(input.to, "to");
  const cc = recipients(input.cc, "cc");
  const bcc = recipients(input.bcc, "bcc");
  const replyTo = recipients(input.replyTo ? [input.replyTo] : [], "replyTo");
  if (!to.length) throw new MessageError(400, "bad_request", "At least one recipient is required", "to");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new MessageError(422, "too_many_recipients", `At most ${MAX_RECIPIENTS} recipients across to, cc and bcc`, "to");
  }
  if (!input.html && !input.text) throw new MessageError(400, "bad_request", "html or text is required", "html");

  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input.headers ?? {})) {
    const name = rawName.trim();
    const lower = name.toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new MessageError(400, "bad_request", `Invalid header ${rawName}`, `headers.${rawName}`);
    }
    if (!lower.startsWith("x-") && !ALLOWED_HEADERS.has(lower)) {
      throw new MessageError(422, "header_not_allowed", `The ${name} header is not allowed`, `headers.${rawName}`);
    }
    headers[name] = value;
  }

  const attachments = (input.attachments ?? []).map((a, i) => {
    if (!/^[A-Za-z0-9+/\r\n]*={0,2}\s*$/.test(a.content)) {
      throw new MessageError(400, "bad_request", "Attachment content must be base64", `attachments.${i}.content`);
    }
    return {
      filename: a.filename,
      content: a.content.replace(/\s+/g, ""),
      contentType: a.contentType ?? "application/octet-stream",
      ...(a.contentId ? { contentId: a.contentId } : {}),
    };
  });

  const html = input.html ?? null;
  const text = input.text ?? htmlToText(html ?? "");
  const encoder = new TextEncoder();
  const size =
    encoder.encode(text).length +
    (html ? encoder.encode(html).length : 0) +
    encoder.encode(input.subject).length +
    attachments.reduce((n, a) => n + base64Size(a.content), 0);
  if (size > MAX_MESSAGE_BYTES) {
    throw new MessageError(422, "message_too_large", "The message is over the 5 MiB limit", "attachments");
  }

  let scheduledAt: Date | null = null;
  if (input.sendAt) {
    const at = new Date(input.sendAt);
    if (at.getTime() - now > MAX_SCHEDULE_MS) {
      throw new MessageError(422, "send_at_too_far", "sendAt must be within 365 days", "sendAt");
    }
    if (at.getTime() > now) scheduledAt = at;
  }

  return {
    id: crypto.randomUUID(),
    from: from.email,
    fromName: from.name,
    to,
    cc,
    bcc,
    replyTo,
    subject: input.subject,
    tags: input.tags ?? {},
    scheduledAt,
    trackOpens: input.track?.opens ?? false,
    trackClicks: input.track?.clicks ?? false,
    body: { text, html, headers, attachments },
  };
}

/** One workflow instance per (message, schedule), so a reschedule never collides with the old one. */
export function instanceId(messageId: string, scheduledAt: Date | null): string {
  return scheduledAt ? `${messageId}-${scheduledAt.getTime()}` : messageId;
}

/** Rate limit and daily cap for the key, counting `n` new messages. */
export async function checkSendLimits(db: Db, key: AuthenticatedKey, n: number, now = Date.now()): Promise<void> {
  const window = async (ms: number) => {
    const [row] = await db
      .select({ n: count() })
      .from(apiMessages)
      .where(and(eq(apiMessages.apiKeyId, key.id), gte(apiMessages.createdAt, new Date(now - ms))));
    return Number(row?.n ?? 0);
  };
  if (key.rateLimitPerMinute != null && (await window(60_000)) + n > key.rateLimitPerMinute) {
    throw new MessageError(429, "rate_limited", `This key may send ${key.rateLimitPerMinute} messages a minute`);
  }
  if (key.dailySendCap != null && (await window(DAY_MS)) + n > key.dailySendCap) {
    throw new MessageError(429, "daily_cap_exceeded", `This key may send ${key.dailySendCap} messages a day`);
  }
}

async function assertDomainSends(db: Db, key: AuthenticatedKey) {
  const [domain] = await db
    .select({ sendingEnabled: domains.sendingEnabled })
    .from(domains)
    .where(eq(domains.id, key.domainId!))
    .limit(1);
  if (!domain?.sendingEnabled) {
    throw new MessageError(422, "domain_not_sending", "Email Sending is not enabled for this domain", "from");
  }
}

export type QueueEnv = Pick<Env, "DB" | "MAIL_STORE" | "SEND_WORKFLOW" | "BOXOX_EDITION">;

export interface QueuedResult {
  id: string;
  status: "queued" | "scheduled" | "failed";
  scheduledAt: string | null;
}

/**
 * Writes every message (R2 bodies, then one D1 batch, so a batch is stored
 * all or nothing) and then starts one SendWorkflow per message.
 */
export async function queueMessages(env: QueueEnv, key: AuthenticatedKey, prepared: PreparedMessage[]): Promise<QueuedResult[]> {
  if (isFree(env)) throw new MessageError(403, "feature_unavailable", "Sending is unavailable in the Free inbox profile.");
  if (!prepared.length) return [];
  const db = createDb(env);
  await assertDomainSends(db, key);
  await checkSendLimits(db, key, prepared.length);

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const keys = new Map<string, string>();
  for (const m of prepared) {
    const r2Key = `api/${key.domainId}/${day}/${m.id}.json`;
    keys.set(m.id, r2Key);
    await env.MAIL_STORE.put(r2Key, JSON.stringify(m.body), { httpMetadata: { contentType: "application/json" } });
  }

  try {
    await batch(db, [
      ...prepared.map((m) =>
        db.insert(apiMessages).values({
          id: m.id,
          domainId: key.domainId!,
          apiKeyId: key.id,
          fromEmail: m.fromName ? `${m.fromName} <${m.from}>` : m.from,
          toEmails: m.to,
          ccEmails: m.cc,
          bccEmails: m.bcc,
          replyTo: m.replyTo,
          subject: m.subject,
          tags: m.tags,
          templateId: m.templateId ?? null,
          r2Key: keys.get(m.id)!,
          trackOpens: m.trackOpens,
          trackClicks: m.trackClicks,
          status: m.scheduledAt ? "scheduled" : "queued",
          scheduledAt: m.scheduledAt,
          createdAt: now,
          updatedAt: now,
        }),
      ),
      ...prepared
        .filter((m) => m.scheduledAt)
        .map((m) =>
          db.insert(messageEvents).values({
            id: `scheduled:${m.id}:${m.scheduledAt!.getTime()}`,
            apiMessageId: m.id,
            type: "scheduled",
            detail: { scheduledAt: m.scheduledAt!.toISOString() },
            occurredAt: now,
          }),
        ),
    ]);
  } catch (err) {
    const cap = sendCapViolation(err);
    if (!cap) throw err;
    await Promise.all([...keys.values()].map((k) => env.MAIL_STORE.delete(k)));
    throw new MessageError(429, cap === "api_send_daily_cap" ? "daily_cap_exceeded" : "rate_limited", "This key has reached its send cap");
  }

  const results: QueuedResult[] = [];
  for (const m of prepared) {
    const scheduledAt = m.scheduledAt?.toISOString() ?? null;
    try {
      await env.SEND_WORKFLOW.create({
        id: instanceId(m.id, m.scheduledAt),
        params: { kind: "api", messageId: m.id, ...(scheduledAt ? { scheduledAt } : {}) },
      });
      results.push({ id: m.id, status: m.scheduledAt ? "scheduled" : "queued", scheduledAt });
    } catch (err) {
      // Nothing was sent; the stored message shows as failed and can be sent again.
      log.error("api_send_workflow_create_failed", { messageId: m.id, error: err });
      await failMessage(db, m.id, "Could not start sending; the message was saved. Send it again to retry.", {
        reason: "workflow_create_failed",
      });
      results.push({ id: m.id, status: "failed", scheduledAt });
    }
  }
  return results;
}

async function ownMessage(db: Db, key: AuthenticatedKey, id: string) {
  const [row] = await db
    .select()
    .from(apiMessages)
    .where(and(eq(apiMessages.id, id), eq(apiMessages.domainId, key.domainId!)))
    .limit(1);
  // Another domain's message is indistinguishable from a missing one.
  if (!row) throw new MessageError(404, "not_found", "No such message");
  return row;
}

async function terminate(env: QueueEnv, id: string) {
  try {
    await (await env.SEND_WORKFLOW.get(id)).terminate();
  } catch (err) {
    // The instance re-checks the row when it wakes, so a failed terminate is harmless.
    log.warn("api_send_workflow_terminate_failed", { instanceId: id, error: err });
  }
}

export async function rescheduleMessage(env: QueueEnv, key: AuthenticatedKey, id: string, sendAt: string, now = Date.now()) {
  const db = createDb(env);
  const row = await ownMessage(db, key, id);
  const at = new Date(sendAt);
  if (at.getTime() <= now) throw new MessageError(422, "send_at_in_past", "sendAt must be in the future", "sendAt");
  if (at.getTime() - now > MAX_SCHEDULE_MS) throw new MessageError(422, "send_at_too_far", "sendAt must be within 365 days", "sendAt");
  const changed = await db
    .update(apiMessages)
    .set({ scheduledAt: at, updatedAt: new Date(now) })
    .where(and(eq(apiMessages.id, id), eq(apiMessages.status, "scheduled")))
    .returning({ id: apiMessages.id });
  if (!changed.length) throw new MessageError(409, "not_scheduled", `A ${row.status} message cannot be rescheduled`);

  await db
    .insert(messageEvents)
    .values({
      id: `scheduled:${id}:${at.getTime()}`,
      apiMessageId: id,
      type: "scheduled",
      detail: { scheduledAt: at.toISOString(), previous: row.scheduledAt?.toISOString() ?? null },
      occurredAt: new Date(now),
    })
    .onConflictDoNothing();
  await terminate(env, instanceId(id, row.scheduledAt));
  try {
    await env.SEND_WORKFLOW.create({
      id: instanceId(id, at),
      params: { kind: "api", messageId: id, scheduledAt: at.toISOString() },
    });
  } catch (err) {
    log.error("api_send_workflow_create_failed", { messageId: id, error: err });
    await failMessage(db, id, "Could not reschedule; the message was saved. Send it again to retry.", {
      reason: "workflow_create_failed",
    });
    return { id, status: "failed" as const, scheduledAt: at.toISOString() };
  }
  return { id, status: "scheduled" as const, scheduledAt: at.toISOString() };
}

export async function cancelMessage(env: QueueEnv, key: AuthenticatedKey, id: string) {
  const db = createDb(env);
  const row = await ownMessage(db, key, id);
  const now = new Date();
  const changed = await db
    .update(apiMessages)
    .set({ status: "canceled", updatedAt: now })
    .where(and(eq(apiMessages.id, id), eq(apiMessages.status, "scheduled")))
    .returning({ id: apiMessages.id });
  if (!changed.length) throw new MessageError(409, "not_scheduled", `A ${row.status} message cannot be canceled`);
  await db
    .insert(messageEvents)
    .values({ id: `canceled:${id}`, apiMessageId: id, type: "canceled", occurredAt: now })
    .onConflictDoNothing();
  await terminate(env, instanceId(id, row.scheduledAt));
  return { id, status: "canceled" as const };
}

type ApiMessageRow = typeof apiMessages.$inferSelect;

function summary(row: ApiMessageRow) {
  return {
    id: row.id,
    from: row.fromEmail,
    to: row.toEmails,
    cc: row.ccEmails,
    bcc: row.bccEmails,
    replyTo: row.replyTo,
    subject: row.subject,
    tags: row.tags,
    status: row.status,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    sentMessageId: row.sentMessageId,
    error: row.sendError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const LIST_STATUSES = apiMessages.status.enumValues;

export interface ListFilters {
  status?: ApiMessageRow["status"];
  tag?: string;
  recipient?: string;
  cursor?: string;
  limit?: number;
}

function encodeCursor(row: ApiMessageRow) {
  return btoa(`${row.createdAt.getTime()}:${row.id}`).replace(/=+$/, "");
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const [at, id] = atob(cursor).split(":");
    const ms = Number(at);
    if (id && Number.isFinite(ms)) return { at: new Date(ms), id };
  } catch {}
  throw new MessageError(400, "bad_request", "Invalid cursor", "cursor");
}

/** Newest first, keyset-paginated, only the key's own domain. */
export async function listMessages(db: Db, key: AuthenticatedKey, filters: ListFilters) {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const where: SQL[] = [eq(apiMessages.domainId, key.domainId!)];
  if (filters.status) where.push(eq(apiMessages.status, filters.status));
  if (filters.tag) {
    const [name, ...rest] = filters.tag.split(":");
    const path = `$.${JSON.stringify(name)}`;
    where.push(
      rest.length
        ? sql`json_extract(${apiMessages.tags}, ${path}) = ${rest.join(":")}`
        : sql`json_type(${apiMessages.tags}, ${path}) IS NOT NULL`,
    );
  }
  if (filters.recipient) {
    const r = filters.recipient.trim().toLowerCase();
    where.push(
      sql`EXISTS (SELECT 1 FROM json_each(${apiMessages.toEmails}) WHERE value = ${r}
        UNION ALL SELECT 1 FROM json_each(${apiMessages.ccEmails}) WHERE value = ${r}
        UNION ALL SELECT 1 FROM json_each(${apiMessages.bccEmails}) WHERE value = ${r})`,
    );
  }
  if (filters.cursor) {
    const c = decodeCursor(filters.cursor);
    where.push(or(lt(apiMessages.createdAt, c.at), and(eq(apiMessages.createdAt, c.at), lt(apiMessages.id, c.id)))!);
  }
  const rows = await db
    .select()
    .from(apiMessages)
    .where(and(...where))
    .orderBy(desc(apiMessages.createdAt), desc(apiMessages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    data: page.map(summary),
    nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null,
  };
}

/** One message with its status timeline, per-recipient events and rendered body. */
export async function getMessage(env: Pick<Env, "DB" | "MAIL_STORE">, key: AuthenticatedKey, id: string) {
  const db = createDb(env);
  const row = await ownMessage(db, key, id);
  const events = await db
    .select()
    .from(messageEvents)
    .where(eq(messageEvents.apiMessageId, id))
    .orderBy(asc(messageEvents.occurredAt), asc(messageEvents.createdAt));
  const obj = await env.MAIL_STORE.get(row.r2Key);
  const body = obj ? ((await obj.json()) as StoredBody) : null;
  return {
    ...summary(row),
    timeline: [
      { type: "queued", recipient: null, at: row.createdAt.toISOString(), detail: null },
      ...events.map((e) => ({ type: e.type, recipient: e.recipient, at: e.occurredAt.toISOString(), detail: e.detail })),
    ],
    body: body
      ? {
          text: body.text,
          html: body.html,
          headers: body.headers,
          attachments: body.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            contentId: a.contentId ?? null,
            size: base64Size(a.content),
          })),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Idempotency-Key

export async function requestHash(method: string, path: string, body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${method}\n${path}\n${body}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type IdempotencyClaim =
  | { kind: "claimed"; id: string }
  | { kind: "replay"; status: number; body: string }
  | { kind: "conflict"; error: MessageError };

/**
 * Claims (api_key_id, key). The unique index makes the insert the lock: a
 * concurrent duplicate loses it and sees the in_progress row.
 */
export async function claimIdempotencyKey(db: Db, apiKeyId: string, key: string, hash: string, now = Date.now()): Promise<IdempotencyClaim> {
  await db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.apiKeyId, apiKeyId), eq(idempotencyKeys.key, key), lt(idempotencyKeys.expiresAt, new Date(now))));
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(idempotencyKeys)
    .values({ id, apiKeyId, key, requestHash: hash, expiresAt: new Date(now + IDEMPOTENCY_TTL_MS) })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });
  if (inserted.length) return { kind: "claimed", id };

  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.apiKeyId, apiKeyId), eq(idempotencyKeys.key, key)))
    .limit(1);
  if (!existing) {
    return { kind: "conflict", error: new MessageError(409, "idempotency_in_progress", "A request with this Idempotency-Key is in progress") };
  }
  if (existing.requestHash !== hash) {
    return {
      kind: "conflict",
      error: new MessageError(409, "idempotency_key_reused", "This Idempotency-Key was used with a different request"),
    };
  }
  if (existing.status !== "completed" || existing.responseStatus == null) {
    return { kind: "conflict", error: new MessageError(409, "idempotency_in_progress", "A request with this Idempotency-Key is in progress") };
  }
  return { kind: "replay", status: existing.responseStatus, body: existing.responseBody ?? "" };
}

export async function completeIdempotencyKey(db: Db, id: string, status: number, body: string) {
  await db
    .update(idempotencyKeys)
    .set({ status: "completed", responseStatus: status, responseBody: body })
    .where(eq(idempotencyKeys.id, id));
}

/** A request that failed on our side frees its key so the client can retry. */
export async function releaseIdempotencyKey(db: Db, id: string) {
  await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.id, id), eq(idempotencyKeys.status, "in_progress")));
}

// ---------------------------------------------------------------------------
// SendWorkflow steps for API messages

export type ApiSendEnv = Pick<Env, "DB" | "MAIL_STORE" | "EMAIL"> & TrackingEnv & EventFanoutEnv;
export type ApiSendStep = Pick<WorkflowStep, "do" | "sleep" | "sleepUntil">;

export const MAX_SEND_ATTEMPTS = 4;
export const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000];
const AMBIGUOUS_NOTE = "Delivery unknown: the message may have been sent. Check before sending it again.";

type Recipients = { to: string[]; cc: string[]; bcc: string[] };
type Attempt = { kind: "sent"; sentMessageId: string; recorded: boolean } | { kind: SendErrorKind; error: string };

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

async function failMessage(db: Db, id: string, error: string, detail: Record<string, unknown>) {
  const changed = await db
    .update(apiMessages)
    .set({ status: "failed", sendError: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(apiMessages.id, id), inArray(apiMessages.status, ["queued", "scheduled"])))
    .returning({ id: apiMessages.id });
  if (!changed.length) return;
  await db
    .insert(messageEvents)
    .values({ id: `failed:${id}`, apiMessageId: id, type: "failed", detail, occurredAt: new Date() })
    .onConflictDoNothing();
}

async function recordSent(db: Db, id: string, sentMessageId: string, attempt: number) {
  const now = new Date();
  await db.batch([
    db
      .update(apiMessages)
      .set({ status: "sent", sentMessageId, sendError: null, sendAttempts: attempt, updatedAt: now })
      .where(and(eq(apiMessages.id, id), eq(apiMessages.status, "queued"))),
    db
      .insert(messageEvents)
      .values({ id: `sent:${id}`, apiMessageId: id, type: "sent", detail: { sentMessageId }, occurredAt: now })
      .onConflictDoNothing(),
  ]);
}

async function gate(db: Db, params: SendParams): Promise<{ action: "stop"; reason: string } | { action: "send"; recipients: Recipients }> {
  const [row] = await db.select().from(apiMessages).where(eq(apiMessages.id, params.messageId)).limit(1);
  if (!row) return { action: "stop", reason: "missing" };
  if (row.status !== "queued" && row.status !== "scheduled") return { action: "stop", reason: row.status };
  // A rescheduled message belongs to the instance created for its new time.
  const expected = row.scheduledAt?.toISOString();
  if (row.status === "scheduled" && expected !== params.scheduledAt) return { action: "stop", reason: "rescheduled" };

  const pause = await sendingPause(db);
  if (pause) {
    await failMessage(db, row.id, `Sending is paused: ${pause.reason ?? "circuit breaker"}. Send again once it is resumed.`, {
      reason: "sending_paused",
    });
    return { action: "stop", reason: "paused" };
  }

  const from = parseAddress(row.fromEmail).email;
  const blocked = await suppressedRecipients(db, from, [...row.toEmails, ...row.ccEmails, ...row.bccEmails]);
  const keep = (list: string[]) => list.filter((r) => !blocked.has(r.toLowerCase()));
  const recipients = { to: keep(row.toEmails), cc: keep(row.ccEmails), bcc: keep(row.bccEmails) };
  if (blocked.size) {
    const now = new Date();
    await db
      .insert(messageEvents)
      .values(
        [...blocked].map((recipient) => ({
          id: `rejected:${row.id}:${recipient}`,
          apiMessageId: row.id,
          type: "rejected" as const,
          recipient,
          detail: { reason: "suppressed" },
          occurredAt: now,
        })),
      )
      .onConflictDoNothing();
  }
  if (!recipients.to.length && !recipients.cc.length && !recipients.bcc.length) {
    await failMessage(db, row.id, "Every recipient is on the suppression list (an earlier bounce or complaint).", { reason: "suppressed" });
    return { action: "stop", reason: "suppressed" };
  }
  if (row.status === "scheduled") {
    const moved = await db
      .update(apiMessages)
      .set({ status: "queued", updatedAt: new Date() })
      .where(and(eq(apiMessages.id, row.id), eq(apiMessages.status, "scheduled")))
      .returning({ id: apiMessages.id });
    // Lost the race with a cancel.
    if (!moved.length) return { action: "stop", reason: "canceled" };
  }
  return { action: "send", recipients };
}

async function attemptSend(env: ApiSendEnv, db: Db, id: string, recipients: Recipients, attempt: number): Promise<Attempt> {
  const [row] = await db
    .update(apiMessages)
    .set({ sendAttempts: attempt })
    .where(and(eq(apiMessages.id, id), eq(apiMessages.status, "queued"), eq(apiMessages.sendAttempts, attempt - 1)))
    .returning({
      domainId: apiMessages.domainId,
      fromEmail: apiMessages.fromEmail,
      replyTo: apiMessages.replyTo,
      subject: apiMessages.subject,
      r2Key: apiMessages.r2Key,
      trackOpens: apiMessages.trackOpens,
      trackClicks: apiMessages.trackClicks,
    });
  if (!row) return { kind: "ambiguous", error: "An earlier attempt was interrupted after it started." };

  const obj = await env.MAIL_STORE.get(row.r2Key);
  if (!obj) return { kind: "permanent", error: "The message body is missing from storage." };
  const body = (await obj.json()) as StoredBody;
  const from = parseAddress(row.fromEmail);
  const html = body.html ? await instrumentHtml(env, body.html, { messageId: id, ...(await trackingFor(db, row)) }) : null;

  let sentMessageId: string;
  try {
    const sent = await env.EMAIL.send({
      from: from.name ? { name: from.name, email: from.email } : from.email,
      ...(recipients.to.length ? { to: recipients.to } : {}),
      ...(recipients.cc.length ? { cc: recipients.cc } : {}),
      ...(recipients.bcc.length ? { bcc: recipients.bcc } : {}),
      ...(row.replyTo[0] ? { replyTo: row.replyTo[0] } : {}),
      subject: row.subject,
      text: body.text,
      ...(html ? { html } : {}),
      ...(body.attachments.length
        ? {
            attachments: body.attachments.map((a) =>
              a.contentId
                ? { disposition: "inline" as const, contentId: a.contentId, filename: a.filename, type: a.contentType, content: decodeBase64(a.content) }
                : { disposition: "attachment" as const, filename: a.filename, type: a.contentType, content: decodeBase64(a.content) },
            ),
          }
        : {}),
      headers: { ...body.headers, "X-Boxox-Message": id },
    } as EmailMessageBuilder);
    sentMessageId = sent.messageId;
  } catch (err) {
    return { kind: classifySendError(err), error: sendErrorMessage(err) };
  }

  try {
    await recordSent(db, id, sentMessageId, attempt);
    return { kind: "sent", sentMessageId, recorded: true };
  } catch (err) {
    log.error("api_record_sent_failed", { messageId: id, error: err });
    return { kind: "sent", sentMessageId, recorded: false };
  }
}

/** Same contract as the mailbox send: one send() per step, never retried after it may have gone out. */
export async function runApiSend(env: ApiSendEnv, params: SendParams, step: ApiSendStep): Promise<string> {
  const db = createDb(env);
  const id = params.messageId;
  if (params.scheduledAt) await step.sleepUntil("wait for scheduled time", new Date(params.scheduledAt));

  const g = await step.do("check suppression and breaker", () => gate(db, params));
  if (g.action === "stop") {
    await step.do("save mailbox sent copy", () => copyApiSentMessage(env, id));
    // A replay after the send was durably recorded must still finish fanout.
    await step.do("emit terminal message webhooks", async () => {
      await fanoutMessageEvent(env, id, `sent:${id}`);
      await fanoutMessageEvent(env, id, `failed:${id}`);
    });
    return g.reason;
  }

  for (let attempt = 1; ; attempt++) {
    let result: Attempt;
    try {
      result = await step.do(`send attempt ${attempt}`, { retries: { limit: 0, delay: 0 }, timeout: "5 minutes" }, () =>
        attemptSend(env, db, id, g.recipients, attempt),
      );
    } catch (err) {
      result = { kind: "ambiguous", error: sendErrorMessage(err) };
    }
    if (result.kind === "sent") {
      if (!result.recorded) {
        const sentMessageId = result.sentMessageId;
        await step.do("record sent", () => recordSent(db, id, sentMessageId, attempt));
      }
      await step.do("save mailbox sent copy", () => copyApiSentMessage(env, id));
      await step.do("emit message.sent", () => fanoutMessageEvent(env, id, `sent:${id}`));
      return "sent";
    }
    if (result.kind === "retryable" && attempt < MAX_SEND_ATTEMPTS) {
      await step.sleep(`back off after attempt ${attempt}`, RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!);
      continue;
    }
    const error = result.kind === "ambiguous" ? `${AMBIGUOUS_NOTE} (${result.error})` : result.error;
    await step.do("mark failed", () => failMessage(db, id, error, { reason: result.kind, attempts: attempt }));
    await step.do("emit message.failed", () => fanoutMessageEvent(env, id, `failed:${id}`));
    return result.kind === "ambiguous" ? "unknown" : "failed";
  }
}
