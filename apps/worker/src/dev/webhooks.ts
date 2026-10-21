import { and, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { webhookDeliveries, webhooks } from "@boxox/db";
import { decryptSecret, encryptSecret, importMasterKey, type EncryptedSecret } from "../crypto";
import type { Db } from "../db";
import { createDb } from "../db";
import type { Env } from "../env";
import { log } from "../log";
import { notifyListeners } from "./listeners";
import type { AuthenticatedKey } from "./keys";
import { MessageError, zodError } from "./messages";

/**
 * Standard Webhooks (https://www.standardwebhooks.com): every request carries
 * webhook-id, webhook-timestamp and webhook-signature, where the signature is
 * base64 HMAC-SHA256 over `id.timestamp.body` keyed by the base64 part of a
 * `whsec_` secret.
 */

export const SECRET_PREFIX = "whsec_";
export const WEBHOOK_EVENTS = [
  "message.sent",
  "message.delivered",
  "message.deferred",
  "message.bounced",
  "message.complained",
  "message.failed",
  "message.opened",
  "message.clicked",
  "message.received",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number] | "webhook.test";

/** Delay before each attempt: immediately, then 5 s → 10 h; 8 attempts in all. */
export const RETRY_SCHEDULE_MS = [0, 5_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 5 * 3600_000, 10 * 3600_000, 10 * 3600_000];
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;
/** Deliveries in a row that exhaust every attempt before the endpoint is disabled. */
export const AUTO_DISABLE_AFTER = 5;
export const DEFAULT_ROTATION_OVERLAP_HOURS = 24;
export const DELIVERY_TIMEOUT_MS = 15_000;

export type WebhookQueueMessage = { deliveryId: string };
/** What sealing a signing secret needs. Absent only in a dev install without agents. */
export type WebhookSecretEnv = Partial<Pick<Env, "BOXOX_SIGNING_SECRET">>;
export type WebhookEnv = Pick<Env, "DB" | "WEBHOOK_QUEUE"> & Partial<Pick<Env, "MAILBOX_HUB">> & WebhookSecretEnv;
type WebhookRow = typeof webhooks.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;
export interface AttemptLogEntry {
  at: string;
  status: number | null;
  error?: string;
  durationMs: number;
  replay?: boolean;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function generateWebhookSecret(): string {
  return SECRET_PREFIX + toB64(crypto.getRandomValues(new Uint8Array(24)));
}

// ---------------------------------------------------------------------------
// Secrets at rest
//
// A signing secret has to be readable to sign, so it cannot be hashed like an
// API key; but stored in plain text, anyone who can read D1 (a leaked account
// token, a backup) could forge events to every endpoint. Rows are therefore
// envelope-encrypted under a key derived from BOXOX_SIGNING_SECRET, with its own
// label like the link and tracking keys. Rows written before sealing existed
// still read (they start with `whsec_`); the hourly sweep re-seals them.

const SEALED_PREFIX = "enc1:";
const SEAL_LABEL = "boxox:webhook-secret:v1:";

async function sealingKey(env: WebhookSecretEnv): Promise<CryptoKey | null> {
  const secret = env.BOXOX_SIGNING_SECRET?.trim();
  if (!secret) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SEAL_LABEL + secret));
  return importMasterKey(toB64(new Uint8Array(digest)));
}

export function isSealedWebhookSecret(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX);
}

/** The database form of a signing secret. Fails closed: never falls back to plain text. */
export async function sealWebhookSecret(env: WebhookSecretEnv, secret: string): Promise<string> {
  const key = await sealingKey(env);
  if (!key) throw new MessageError(503, "webhooks_unconfigured", "Webhook secrets cannot be stored until BOXOX_SIGNING_SECRET is set");
  const record = await encryptSecret(key, secret);
  return SEALED_PREFIX + toB64(new TextEncoder().encode(JSON.stringify(record)));
}

/** The signing secret behind a stored value, or null when it cannot be read. */
export async function unsealWebhookSecret(env: WebhookSecretEnv, stored: string): Promise<string | null> {
  if (!isSealedWebhookSecret(stored)) return stored.startsWith(SECRET_PREFIX) ? stored : null;
  const key = await sealingKey(env);
  if (!key) return null;
  try {
    const record = JSON.parse(new TextDecoder().decode(fromB64(stored.slice(SEALED_PREFIX.length)))) as EncryptedSecret;
    return await decryptSecret(key, record);
  } catch {
    return null;
  }
}

/**
 * Re-encrypts secrets stored before sealing existed. Bounded per run and
 * idempotent, so the hourly sweep can call it until nothing is left.
 */
export async function resealWebhookSecrets(env: WebhookSecretEnv, db: Db, limit = 100): Promise<number> {
  if (!(await sealingKey(env))) return 0;
  const rows = await db
    .select({ id: webhooks.id, secret: webhooks.secret, previousSecret: webhooks.previousSecret })
    .from(webhooks)
    .where(or(sql`${webhooks.secret} NOT LIKE ${`${SEALED_PREFIX}%`}`, sql`${webhooks.previousSecret} NOT LIKE ${`${SEALED_PREFIX}%`}`))
    .limit(limit);
  let sealed = 0;
  for (const row of rows) {
    const set: Partial<typeof webhooks.$inferInsert> = {};
    if (!isSealedWebhookSecret(row.secret)) set.secret = await sealWebhookSecret(env, row.secret);
    if (row.previousSecret && !isSealedWebhookSecret(row.previousSecret)) set.previousSecret = await sealWebhookSecret(env, row.previousSecret);
    if (!Object.keys(set).length) continue;
    await db.update(webhooks).set(set).where(eq(webhooks.id, row.id));
    sealed++;
  }
  return sealed;
}

/** `v1,<base64 HMAC-SHA256(id.timestamp.body)>`. */
export async function signPayload(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const key = await crypto.subtle.importKey("raw", fromB64(raw) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${toB64(new Uint8Array(mac))}`;
}

/** During a rotation overlap both the new and the previous secret sign, space-separated. */
export async function signatureHeaders(secrets: string[], id: string, timestamp: number, body: string): Promise<Record<string, string>> {
  const sigs = await Promise.all(secrets.map((s) => signPayload(s, id, timestamp, body)));
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": sigs.join(" "),
  };
}

async function activeSecrets(
  env: WebhookSecretEnv,
  hook: Pick<WebhookRow, "secret" | "previousSecret" | "previousSecretExpiresAt">,
  now: number,
): Promise<string[]> {
  const out: string[] = [];
  const current = await unsealWebhookSecret(env, hook.secret);
  if (current) out.push(current);
  if (hook.previousSecret && hook.previousSecretExpiresAt && hook.previousSecretExpiresAt.getTime() > now) {
    const previous = await unsealWebhookSecret(env, hook.previousSecret);
    if (previous) out.push(previous);
  }
  return out;
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

function privateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function privateIPv6(host: string): boolean {
  if (!host.startsWith("[")) return false;
  const h = host.slice(1, -1).toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  return mapped ? privateIPv4(mapped[1]!) : h.startsWith("::ffff:");
}

/** HTTPS only, no credentials, and no obvious internal hosts or private addresses. */
export function checkTargetUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "The URL is not valid";
  }
  if (url.protocol !== "https:") return "Webhook URLs must use https";
  if (url.username || url.password) return "Webhook URLs may not contain credentials";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") && !host.startsWith("[")) return "Webhook URLs need a public hostname";
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return "Webhook URLs may not point at internal hosts";
  if (privateIPv4(host) || privateIPv6(host)) return "Webhook URLs may not point at private addresses";
  return null;
}

const urlField = z.string().trim().max(2000);
const eventsField = z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length);

export const createWebhookSchema = z.object({ url: urlField, events: eventsField.optional() }).strict();
export const updateWebhookSchema = z
  .object({ url: urlField.optional(), events: eventsField.optional(), enabled: z.boolean().optional() })
  .strict();
export const rotateSchema = z
  .object({ overlapHours: z.number().int().min(0).max(168).optional() })
  .strict();

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw zodError(parsed.error);
  return parsed.data;
}

function requireHttps(url: string) {
  const problem = checkTargetUrl(url);
  if (problem) throw new MessageError(422, "invalid_url", problem, "url");
}

/** What the API shows; the secret only ever appears in create and rotate responses. */
function view(row: WebhookRow) {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    status: row.status,
    consecutiveFailures: row.consecutiveFailures,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    previousSecretExpiresAt: row.previousSecretExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function deliveryView(row: DeliveryRow, full = false) {
  return {
    id: row.id,
    webhookId: row.webhookId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    lastStatusCode: row.lastStatusCode,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(full ? { attemptLog: row.attemptLog as AttemptLogEntry[], payload: JSON.parse(row.payload) as unknown } : {}),
  };
}

async function ownWebhook(db: Db, key: AuthenticatedKey, id: string): Promise<WebhookRow> {
  const [row] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.domainId, key.domainId!)))
    .limit(1);
  if (!row) throw new MessageError(404, "not_found", "No such webhook");
  return row;
}

export async function createWebhook(env: WebhookSecretEnv, db: Db, key: AuthenticatedKey, raw: unknown) {
  const input = parse(createWebhookSchema, raw);
  requireHttps(input.url);
  const secret = generateWebhookSecret();
  const [row] = await db
    .insert(webhooks)
    .values({
      id: crypto.randomUUID(),
      domainId: key.domainId!,
      url: input.url,
      events: input.events ?? [],
      secret: await sealWebhookSecret(env, secret),
      createdBy: `key:${key.id}`,
    })
    .returning();
  return { ...view(row!), secret };
}

export async function listWebhooks(db: Db, key: AuthenticatedKey) {
  const rows = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.domainId, key.domainId!))
    .orderBy(desc(webhooks.createdAt));
  return { data: rows.map(view) };
}

export async function getWebhook(db: Db, key: AuthenticatedKey, id: string) {
  return view(await ownWebhook(db, key, id));
}

/** Re-enabling clears the failure count so the endpoint gets a fresh run. */
export async function updateWebhook(db: Db, key: AuthenticatedKey, id: string, raw: unknown) {
  const input = parse(updateWebhookSchema, raw);
  const current = await ownWebhook(db, key, id);
  if (input.url !== undefined) requireHttps(input.url);
  const now = new Date();
  const set: Partial<typeof webhooks.$inferInsert> = { updatedAt: now };
  if (input.url !== undefined) set.url = input.url;
  if (input.events !== undefined) set.events = input.events;
  if (input.enabled === true && current.status === "disabled") {
    Object.assign(set, { status: "active", disabledAt: null, consecutiveFailures: 0 });
  } else if (input.enabled === false && current.status === "active") {
    Object.assign(set, { status: "disabled", disabledAt: now });
  }
  const [row] = await db.update(webhooks).set(set).where(eq(webhooks.id, current.id)).returning();
  return view(row!);
}

export async function deleteWebhook(db: Db, key: AuthenticatedKey, id: string) {
  const row = await ownWebhook(db, key, id);
  await db.delete(webhooks).where(eq(webhooks.id, row.id));
  return { id: row.id, deleted: true };
}

/** New secret now; the old one keeps signing alongside it until the overlap ends. */
export async function rotateWebhookSecret(env: WebhookSecretEnv, db: Db, key: AuthenticatedKey, id: string, raw: unknown, now = Date.now()) {
  const input = parse(rotateSchema, raw);
  const current = await ownWebhook(db, key, id);
  const overlapMs = (input.overlapHours ?? DEFAULT_ROTATION_OVERLAP_HOURS) * 3600_000;
  const secret = generateWebhookSecret();
  // The outgoing secret is re-sealed on its way to previous_secret, so a row
  // from before sealing existed stops being plain text here too.
  const outgoing = overlapMs ? await unsealWebhookSecret(env, current.secret) : null;
  const [row] = await db
    .update(webhooks)
    .set({
      secret: await sealWebhookSecret(env, secret),
      previousSecret: outgoing ? await sealWebhookSecret(env, outgoing) : null,
      previousSecretExpiresAt: outgoing ? new Date(now + overlapMs) : null,
      updatedAt: new Date(now),
    })
    .where(eq(webhooks.id, current.id))
    .returning();
  return { ...view(row!), secret };
}

function encodeCursor(row: DeliveryRow) {
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

export const DELIVERY_STATUSES = webhookDeliveries.status.enumValues;

export async function listDeliveries(
  db: Db,
  key: AuthenticatedKey,
  webhookId: string,
  filters: { status?: DeliveryRow["status"]; cursor?: string; limit?: number },
) {
  const hook = await ownWebhook(db, key, webhookId);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const where: SQL[] = [eq(webhookDeliveries.webhookId, hook.id)];
  if (filters.status) where.push(eq(webhookDeliveries.status, filters.status));
  if (filters.cursor) {
    const c = decodeCursor(filters.cursor);
    where.push(or(lt(webhookDeliveries.createdAt, c.at), and(eq(webhookDeliveries.createdAt, c.at), lt(webhookDeliveries.id, c.id)))!);
  }
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(and(...where))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { data: page.map((r) => deliveryView(r)), nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null };
}

async function ownDelivery(db: Db, key: AuthenticatedKey, webhookId: string, deliveryId: string) {
  const hook = await ownWebhook(db, key, webhookId);
  const [row] = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, hook.id)))
    .limit(1);
  if (!row) throw new MessageError(404, "not_found", "No such delivery");
  return { hook, row };
}

export async function getDelivery(db: Db, key: AuthenticatedKey, webhookId: string, deliveryId: string) {
  return deliveryView((await ownDelivery(db, key, webhookId, deliveryId)).row, true);
}

/**
 * Sends a finished delivery again with a fresh retry schedule. The webhook-id
 * stays the same so receivers can dedupe; the attempt log keeps its history.
 */
export async function replayDelivery(env: WebhookEnv, key: AuthenticatedKey, webhookId: string, deliveryId: string) {
  const db = createDb(env);
  const { hook, row } = await ownDelivery(db, key, webhookId, deliveryId);
  if (hook.status !== "active") throw new MessageError(409, "webhook_disabled", "Enable the webhook before replaying");
  if (row.status === "pending") throw new MessageError(409, "delivery_pending", "This delivery is still being attempted");
  const now = new Date();
  const marker: AttemptLogEntry = { at: now.toISOString(), status: null, durationMs: 0, replay: true };
  const [updated] = await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      attemptLog: sql`json_insert(${webhookDeliveries.attemptLog}, '$[#]', json(${JSON.stringify(marker)}))`,
    })
    .where(and(eq(webhookDeliveries.id, row.id), eq(webhookDeliveries.status, row.status)))
    .returning();
  if (!updated) throw new MessageError(409, "delivery_pending", "This delivery is already being replayed");
  await env.WEBHOOK_QUEUE.send({ deliveryId: row.id });
  return deliveryView(updated);
}

function matches(hook: Pick<WebhookRow, "events">, type: string): boolean {
  return type === "webhook.test" || !hook.events.length || hook.events.includes(type);
}

/**
 * Fans one event out to every active endpoint on the domain that wants it.
 * `eventId` makes emission idempotent: the same event never gets a second
 * delivery row on one endpoint.
 */
export async function emitWebhookEvent(
  env: WebhookEnv,
  domainId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
  opts: { eventId?: string; webhookId?: string; now?: number } = {},
): Promise<string[]> {
  const db = createDb(env);
  const eventId = opts.eventId ?? `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date(opts.now ?? Date.now());
  const payload = JSON.stringify({ type, timestamp: now.toISOString(), data });
  await notifyListeners(env, domainId, { id: eventId, payload });
  const where: SQL[] = [eq(webhooks.domainId, domainId), eq(webhooks.status, "active")];
  if (opts.webhookId) where.push(eq(webhooks.id, opts.webhookId));
  const hooks = (await db.select().from(webhooks).where(and(...where))).filter((h) => matches(h, type));
  if (!hooks.length) return [];
  const rows = await db
    .insert(webhookDeliveries)
    .values(hooks.map((h) => ({ id: crypto.randomUUID(), webhookId: h.id, eventId, eventType: type, payload, nextAttemptAt: now })))
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });
  // An upstream retry can arrive after D1 committed but enqueue failed. Requeue
  // the same untouched delivery rows; successful/attempted deliveries keep their
  // existing retry schedule. HTTP receivers deduplicate the stable webhook-id.
  const pending = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.eventId, eventId), inArray(webhookDeliveries.webhookId, hooks.map((h) => h.id)),
      eq(webhookDeliveries.status, "pending"), eq(webhookDeliveries.attempts, 0), isNotNull(webhookDeliveries.nextAttemptAt)));
  if (pending.length) {
    await env.WEBHOOK_QUEUE.sendBatch(pending.map((r) => ({ body: { deliveryId: r.id } })));
    // NULL means already enqueued and awaiting the first attempt. Do not
    // overwrite a retry time if a consumer has already advanced the delivery.
    await db.update(webhookDeliveries).set({ nextAttemptAt: null }).where(and(
      inArray(webhookDeliveries.id, pending.map((r) => r.id)), eq(webhookDeliveries.status, "pending"), eq(webhookDeliveries.attempts, 0),
    ));
  }
  return rows.map((r) => r.id);
}

export async function sendTestEvent(env: WebhookEnv, key: AuthenticatedKey, webhookId: string) {
  const hook = await ownWebhook(createDb(env), key, webhookId);
  if (hook.status !== "active") throw new MessageError(409, "webhook_disabled", "Enable the webhook before testing it");
  const [deliveryId] = await emitWebhookEvent(env, hook.domainId, "webhook.test", { webhookId: hook.id }, { webhookId: hook.id });
  return { deliveryId };
}

export type DeliveryOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "succeeded"; status: number }
  | { kind: "retry"; delayMs: number; status: number | null }
  | { kind: "failed"; status: number | null; disabled: boolean };

export interface DeliverDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * One attempt at one delivery. Only the status code and a short error reach
 * the attempt log, never the response body. Redirects are not followed.
 */
export async function attemptDelivery(env: WebhookSecretEnv, db: Db, deliveryId: string, deps: DeliverDeps = {}): Promise<DeliveryOutcome> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const [row] = await db
    .select({ delivery: webhookDeliveries, hook: webhooks })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  if (!row) return { kind: "skipped", reason: "missing" };
  const { delivery, hook } = row;
  if (delivery.status !== "pending") return { kind: "skipped", reason: delivery.status };

  const started = now();
  let status: number | null = null;
  let error: string | undefined;
  const problem = hook.status !== "active" ? "endpoint disabled" : checkTargetUrl(hook.url);
  const secrets = problem ? [] : await activeSecrets(env, hook, started);
  if (problem) {
    error = problem;
  } else if (!secrets.length) {
    // Never send unsigned. Treated like a transient failure so it retries once the secret is readable.
    error = "signing secret unavailable";
  } else {
    const headers = await signatureHeaders(secrets, delivery.eventId, Math.floor(started / 1000), delivery.payload);
    try {
      const res = await doFetch(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "BoxOx-Webhooks/1", ...headers },
        body: delivery.payload,
        redirect: "manual",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      status = res.status;
      await res.body?.cancel();
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (err) {
      error = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "connection failed";
    }
  }

  const finished = now();
  const entry: AttemptLogEntry = { at: new Date(started).toISOString(), status, durationMs: finished - started, ...(error ? { error } : {}) };
  const attempts = delivery.attempts + 1;
  const appendLog = sql`json_insert(${webhookDeliveries.attemptLog}, '$[#]', json(${JSON.stringify(entry)}))`;
  const base = { attempts, attemptLog: appendLog, lastStatusCode: status };
  const pending = and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, "pending"));

  if (!error) {
    await db.update(webhookDeliveries).set({ ...base, status: "succeeded", deliveredAt: new Date(finished), nextAttemptAt: null }).where(pending);
    await db.update(webhooks).set({ consecutiveFailures: 0 }).where(eq(webhooks.id, hook.id));
    return { kind: "succeeded", status: status! };
  }

  const delayMs = hook.status === "active" ? RETRY_SCHEDULE_MS[attempts] : undefined;
  if (delayMs !== undefined) {
    await db.update(webhookDeliveries).set({ ...base, nextAttemptAt: new Date(finished + delayMs) }).where(pending);
    return { kind: "retry", delayMs, status };
  }

  await db.update(webhookDeliveries).set({ ...base, status: "failed", nextAttemptAt: null }).where(pending);
  if (hook.status !== "active") return { kind: "failed", status, disabled: true };
  const [counted] = await db
    .update(webhooks)
    .set({ consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1` })
    .where(eq(webhooks.id, hook.id))
    .returning({ failures: webhooks.consecutiveFailures });
  const disabled = (counted?.failures ?? 0) >= AUTO_DISABLE_AFTER;
  if (disabled) {
    await db
      .update(webhooks)
      .set({ status: "disabled", disabledAt: new Date(finished), updatedAt: new Date(finished) })
      .where(and(eq(webhooks.id, hook.id), eq(webhooks.status, "active")));
    log.warn("webhook_auto_disabled", { webhookId: hook.id, failures: counted!.failures });
  }
  return { kind: "failed", status, disabled };
}
