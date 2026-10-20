import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { bool, json, stamp, ts } from "./columns";
import { domains, messages } from "./mail";

/**
 * Developer API (/dev/v1). Everything here is scoped to exactly one domain, so
 * a leaked key reaches only that domain.
 */

export const API_KEY_KINDS = ["management", "domain"] as const;
export const DOMAIN_KEY_PERMISSIONS = ["send", "read_log", "read_received", "templates", "webhooks"] as const;

/**
 * Two kinds of key, and no key that can act on every domain:
 *  - management (bxm_): created by the owner in the UI only. Mints domain keys
 *    for the domains in api_key_domains, nothing else. No domain_id, no parent.
 *  - domain (bxk_): exactly one domain_id; parent_key_id names the management
 *    key that created it (null when the owner created it in the UI).
 * The CHECK enforces the shape; the threads_fts migration adds triggers that
 * make a parent a management key holding the child's domain.
 *
 * Secrets are 256-bit and stored as SHA-256 only. During rotation the previous
 * hash keeps working until previous_secret_expires_at.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: API_KEY_KINDS }).notNull(),
    name: text("name").notNull(),
    domainId: text("domain_id").references(() => domains.id, { onDelete: "cascade" }),
    parentKeyId: text("parent_key_id").references((): AnySQLiteColumn => apiKeys.id, {
      onDelete: "set null",
    }),
    secretHash: text("secret_hash").notNull().unique(),
    previousSecretHash: text("previous_secret_hash").unique(),
    previousSecretExpiresAt: ts("previous_secret_expires_at"),
    /** "bxm_" or "bxk_"; with last4, all that is shown after creation. */
    prefix: text("prefix").notNull(),
    last4: text("last4").notNull(),
    /** Domain keys: subset of DOMAIN_KEY_PERMISSIONS. Management keys: [] (see api_key_domains). */
    permissions: json<string[]>("permissions").notNull().default([]),
    /** Optional narrowing inside the domain. Empty means no extra restriction. */
    allowedFrom: json<string[]>("allowed_from").notNull().default([]),
    allowedRecipients: json<string[]>("allowed_recipients").notNull().default([]),
    ipAllowlist: json<string[]>("ip_allowlist").notNull().default([]),
    rateLimitPerMinute: integer("rate_limit_per_minute"),
    dailySendCap: integer("daily_send_cap"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    lastUsedAt: ts("last_used_at"),
    lastUsedIp: text("last_used_ip"),
    /** "owner:<email>" or "key:<management key id>". */
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [
    index("api_keys_domain_idx").on(t.domainId),
    index("api_keys_parent_idx").on(t.parentKeyId),
    check(
      "api_keys_kind_check",
      sql`(${t.kind} = 'domain' AND ${t.domainId} IS NOT NULL) OR (${t.kind} = 'management' AND ${t.domainId} IS NULL AND ${t.parentKeyId} IS NULL)`,
    ),
  ],
);

/**
 * The domains a management key may mint keys for, with the ceilings its
 * children are held to.
 */
export const apiKeyDomains = sqliteTable(
  "api_key_domains",
  {
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** The most a child key on this domain may be given. */
    grantablePermissions: json<string[]>("grantable_permissions").notNull().default([]),
    /** Total daily send budget across this key's children on this domain. */
    dailySendBudget: integer("daily_send_budget"),
    createdAt: stamp("created_at"),
  },
  (t) => [primaryKey({ columns: [t.apiKeyId, t.domainId] }), index("api_key_domains_domain_idx").on(t.domainId)],
);

/**
 * Idempotency-Key, kept 24 h. The unique (api_key_id, key) plus the
 * in_progress state means a concurrent duplicate loses the insert and gets 409.
 */
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** SHA-256 of method + path + body; a different body under the same key is 409. */
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: ["in_progress", "completed"] }).notNull().default("in_progress"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    createdAt: stamp("created_at"),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("idempotency_keys_key_idx").on(t.apiKeyId, t.key),
    index("idempotency_keys_expires_idx").on(t.expiresAt),
  ],
);

/** Versioned templates; each save is a new row with version + 1. */
export const templates = sqliteTable(
  "templates",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** Stable handle the API refers to. */
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    subject: text("subject").notNull().default(""),
    html: text("html"),
    text: text("text"),
    /** [{ name, type, fallback?, raw? }]; only raw variables may render unescaped. */
    variables: json<unknown[]>("variables").notNull().default([]),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [uniqueIndex("templates_domain_name_version_idx").on(t.domainId, t.name, t.version)],
);

/**
 * Standard Webhooks endpoints. The signing secret has to be readable to sign,
 * so it is stored as-is; it never appears in logs or API responses after
 * creation.
 */
export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** Event types delivered; empty means all. */
    events: json<string[]>("events").notNull().default([]),
    secret: text("secret").notNull(),
    previousSecret: text("previous_secret"),
    previousSecretExpiresAt: ts("previous_secret_expires_at"),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    /** Consecutive failed deliveries; crossing the threshold auto-disables. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledAt: ts("disabled_at"),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [index("webhooks_domain_idx").on(t.domainId)],
);

/** One row per (endpoint, event); the queue retries it with backoff and can replay it. */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    /** Standard Webhooks webhook-id; stable across retries and replays. */
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull(),
    status: text("status", { enum: ["pending", "succeeded", "failed"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    /** [{ at, status, error?, durationMs }] — never response bodies or secrets. */
    attemptLog: json<unknown[]>("attempt_log").notNull().default([]),
    lastStatusCode: integer("last_status_code"),
    deliveredAt: ts("delivered_at"),
    createdAt: stamp("created_at"),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_event_idx").on(t.webhookId, t.eventId),
    index("webhook_deliveries_pending_idx").on(t.status, t.nextAttemptAt),
  ],
);

/** Recipients that hard-bounced or complained, checked before every send. */
export const suppressions = sqliteTable(
  "suppressions",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** Stored lowercased. */
    email: text("email").notNull(),
    reason: text("reason", { enum: ["bounce", "complaint", "manual"] }).notNull(),
    detail: text("detail"),
    createdAt: stamp("created_at"),
  },
  (t) => [uniqueIndex("suppressions_domain_email_idx").on(t.domainId, t.email)],
);

/**
 * Mail sent through /dev/v1/messages. Kept apart from mailbox messages so app
 * traffic never fills the owner's inbox; bodies live in R2 like everything else.
 */
export const apiMessages = sqliteTable(
  "api_messages",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    fromEmail: text("from_email").notNull(),
    toEmails: json<string[]>("to_emails").notNull().default([]),
    ccEmails: json<string[]>("cc_emails").notNull().default([]),
    bccEmails: json<string[]>("bcc_emails").notNull().default([]),
    replyTo: json<string[]>("reply_to").notNull().default([]),
    subject: text("subject").notNull().default(""),
    tags: json<Record<string, string>>("tags").notNull().default({}),
    templateId: text("template_id").references(() => templates.id, { onDelete: "set null" }),
    /** Rendered message (headers, html, text, attachment refs). */
    /** Durable marker so mailbox retention never recreates a deleted sent copy. */
    mailboxCopiedAt: ts("mailbox_copied_at"),
    r2Key: text("r2_key").notNull(),
    trackOpens: bool("track_opens").notNull().default(false),
    trackClicks: bool("track_clicks").notNull().default(false),
    status: text("status", {
      enum: ["queued", "scheduled", "sent", "delivered", "deferred", "bounced", "complained", "failed", "canceled"],
    })
      .notNull()
      .default("queued"),
    scheduledAt: ts("scheduled_at"),
    sentMessageId: text("sent_message_id"),
    sendAttempts: integer("send_attempts").notNull().default(0),
    sendError: text("send_error"),
    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [
    index("api_messages_domain_created_idx").on(t.domainId, t.createdAt),
    index("api_messages_key_created_idx").on(t.apiKeyId, t.createdAt),
    index("api_messages_domain_status_idx").on(t.domainId, t.status),
    index("api_messages_sent_message_id_idx").on(t.sentMessageId),
  ],
);

export const MESSAGE_EVENT_TYPES = [
  "scheduled",
  "sent",
  "delivered",
  "deferred",
  "bounced",
  "complained",
  "failed",
  "rejected",
  "opened",
  "clicked",
  "canceled",
] as const;

/** Status timeline for an outbound mailbox message or an API message. */
export const messageEvents = sqliteTable(
  "message_events",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    apiMessageId: text("api_message_id").references(() => apiMessages.id, { onDelete: "cascade" }),
    type: text("type", { enum: MESSAGE_EVENT_TYPES }).notNull(),
    recipient: text("recipient"),
    /** Event payload minus anything sensitive (no bodies, no full URLs with tokens). */
    detail: json<Record<string, unknown>>("detail"),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [
    index("message_events_message_idx").on(t.messageId, t.occurredAt),
    index("message_events_api_message_idx").on(t.apiMessageId, t.occurredAt),
    check(
      "message_events_target_check",
      sql`(${t.messageId} IS NULL) <> (${t.apiMessageId} IS NULL)`,
    ),
  ],
);
