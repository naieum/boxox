import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { bool, json, stamp, ts } from "./columns";

/**
 * The v1 mail tables on D1, plus labels, overrides, drafts, attachments and
 * share links. Hierarchy: owner → domains → addresses → grants. The catch-all
 * delivers *@domain to the Worker, so routing is entirely ours: an address is
 * a routing rule + mailbox + grants, and its kind is mutable.
 *
 * organization_id is a v1 leftover: a single-tenant install has one value.
 * Keyword search is the threads_fts FTS5 table, kept in sync with messages by
 * triggers in the threads_fts migration (Drizzle can't declare virtual tables).
 */

export const domains = sqliteTable(
  "domains",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("unknown"),
    region: text("region"),
    /** Inactive domains follow the hold policy on inbound, so mail is never lost. */
    active: bool("active").notNull().default(true),
    /** What happens to mail for unknown local-parts: hold | catch_all | drop. */
    unknownMailPolicy: text("unknown_mail_policy", {
      enum: ["hold", "catch_all", "drop"],
    })
      .notNull()
      .default("hold"),
    /**
     * Destination mailbox when unknownMailPolicy = catch_all. FK is declared
     * below via a standalone reference (not inline) because `addresses` is
     * defined after this table and would otherwise be a TDZ cycle. ON DELETE
     * SET NULL: losing the catch-all target degrades routing to `hold`
     * (routeLocalPart), never a dangling id and never a dropped message.
     */
    catchAllAddressId: text("catch_all_address_id").references(
      (): AnySQLiteColumn => addresses.id,
      { onDelete: "set null" },
    ),
    lastSyncedAt: ts("last_synced_at"),
    /** Onboarded to Email Sending / Email Routing by the setup wizard. */
    sendingEnabled: bool("sending_enabled").notNull().default(false),
    receivingEnabled: bool("receiving_enabled").notNull().default(false),
    /** Developer API open/click tracking; off unless the owner turns it on. */
    trackOpens: bool("track_opens").notNull().default(false),
    trackClicks: bool("track_clicks").notNull().default(false),
    /** Last DNS health check: { spf, dkim, dmarc, mx, checkedRecords… }. */
    health: json<Record<string, unknown>>("health"),
    healthCheckedAt: ts("health_checked_at"),
    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [
    uniqueIndex("domains_org_name_idx").on(t.organizationId, t.name),
    index("domains_org_idx").on(t.organizationId),
  ],
);

export const ADDRESS_KINDS = ["personal", "role", "agent", "disposable"] as const;
export const ADDRESS_STATUSES = ["active", "paused", "archived"] as const;

export const addresses = sqliteTable(
  "addresses",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    localPart: text("local_part").notNull(),
    /** Mutable: personal | role | agent | disposable. */
    kind: text("kind", { enum: ADDRESS_KINDS }).notNull().default("role"),
    displayName: text("display_name"),
    /** paused/archived addresses stop receiving (fall through to catch-all/drop). */
    status: text("status", { enum: ADDRESS_STATUSES }).notNull().default("active"),
    /** Disposable addresses can expire. */
    expiresAt: ts("expires_at"),
    /** "App inbox" addresses also (or only) deliver to developer webhooks. */
    deliveryMode: text("delivery_mode", { enum: ["inbox", "webhook", "both"] })
      .notNull()
      .default("inbox"),
    /** Per-address AI opt-out (e.g. legal@), regardless of the global switch. */
    aiOptOut: bool("ai_opt_out").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [
    uniqueIndex("addresses_domain_local_idx").on(t.domainId, t.localPart),
    index("addresses_org_idx").on(t.organizationId),
  ],
);

export const GRANT_PRINCIPALS = ["user", "agent"] as const;

export const addressGrants = sqliteTable(
  "address_grants",
  {
    id: text("id").primaryKey(),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    principalType: text("principal_type", { enum: GRANT_PRINCIPALS }).notNull(),
    /** Agent id for agent grants; null for people, who match on inviteEmail. */
    principalId: text("principal_id"),
    /** Person attached by email before they have an account. */
    inviteEmail: text("invite_email"),
    /** Subset of read | send | send_new | webhook | classify. */
    permissions: json<string[]>("permissions").notNull().default(["read"]),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [
    index("address_grants_address_idx").on(t.addressId),
    index("address_grants_principal_idx").on(t.principalType, t.principalId),
    index("address_grants_invite_idx").on(t.inviteEmail),
  ],
);

export const THREAD_FOLDERS = ["inbox", "sent", "archive", "trash", "unrouted", "spam", "quarantine"] as const;

/** Org-wide sender blocklist — inbound from these emails always lands in spam. */
export const blockedSenders = sqliteTable(
  "blocked_senders",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    /** Stored lowercased. */
    email: text("email").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [
    uniqueIndex("blocked_senders_org_email_idx").on(t.organizationId, t.email),
    index("blocked_senders_org_idx").on(t.organizationId),
  ],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    /** Null for unrouted mail (no mailbox owns it yet). */
    addressId: text("address_id").references(() => addresses.id, {
      onDelete: "cascade",
    }),
    /** Set for unrouted mail so it can be claimed per-domain. */
    domainId: text("domain_id").references(() => domains.id, { onDelete: "cascade" }),
    /** The recipient as sent, e.g. mikew@trycream.app, for unrouted mail. */
    originalRecipient: text("original_recipient"),
    subject: text("subject").notNull().default(""),
    /** Normalized subject (re:/fwd: stripped, lowercased) for fallback threading. */
    subjectNorm: text("subject_norm").notNull().default(""),
    /** Primary counterparty for fallback threading + list display. */
    counterpartyEmail: text("counterparty_email"),
    counterpartyName: text("counterparty_name"),
    /** Lowercased addresses of everyone in the conversation, for participant-set threading. */
    participants: json<string[]>("participants").notNull().default([]),
    folder: text("folder", { enum: THREAD_FOLDERS }).notNull().default("inbox"),
    starred: bool("starred").notNull().default(false),
    unread: bool("unread").notNull().default(true),
    /** Muted threads keep later replies out of the inbox. */
    muted: bool("muted").notNull().default(false),
    /** Set while snoozed; the snooze workflow returns the thread to the inbox. */
    snoozedUntil: ts("snoozed_until"),
    /** From the AI classifier: 0 (low) – 3 (high), and one category. */
    priority: integer("priority"),
    category: text("category"),
    /** On-demand summary, cached until messageCount changes. */
    summary: text("summary"),
    summaryMessageCount: integer("summary_message_count"),
    messageCount: integer("message_count").notNull().default(0),
    snippet: text("snippet").notNull().default(""),
    lastMessageAt: stamp("last_message_at"),
    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [
    index("threads_org_folder_idx").on(t.organizationId, t.folder, t.lastMessageAt),
    index("threads_address_idx").on(t.addressId, t.lastMessageAt),
    index("threads_subject_norm_idx").on(t.addressId, t.subjectNorm),
    /**
     * Serves the nightly retention purge, which scans
     * `WHERE folder='trash' AND updated_at <= cutoff ORDER BY updated_at`.
     *
     * None of the three indexes above can help it: they all lead with
     * organization_id or address_id, and the purge is deliberately org-wide.
     * Without this the cron sequential-scans every thread in the system and
     * sorts the result — fine at 66 rows, quadratically less fine later.
     * Partial on folder='trash' so it stays tiny (only trashed threads are in it).
     */
    index("threads_trash_purge_idx")
      .on(t.updatedAt)
      .where(sql`${t.folder} = 'trash'`),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    /** Null while the message sits in unrouted. */
    addressId: text("address_id").references(() => addresses.id, {
      onDelete: "cascade",
    }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    /**
     * Inbound sender authentication (DMARC pass, or aligned SPF+DKIM) from the
     * Authentication-Results header. Outbound messages are `true` (we sent them).
     * SECURITY: reply-only agent send counts a counterparty as "known" only when
     * an authenticated inbound message (or prior outbound) established it —
     * otherwise a spoofed From on inbound mail could unlock arbitrary outbound.
     */
    authenticated: bool("authenticated").notNull().default(false),
    /**
     * The sender wasn't in the thread before this message. References can be
     * forged, so the UI marks them rather than trusting the join.
     */
    newParticipant: bool("new_participant").notNull().default(false),
    toEmails: json<string[]>("to_emails").notNull().default([]),
    ccEmails: json<string[]>("cc_emails").notNull().default([]),
    bccEmails: json<string[]>("bcc_emails").notNull().default([]),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    /** RFC 5322 Message-ID / In-Reply-To for threading. */
    rfcMessageId: text("rfc_message_id"),
    inReplyTo: text("in_reply_to"),
    /**
     * Raw RFC 5322 `References` header — the full ancestry chain, oldest first.
     *
     * In-Reply-To alone names only the immediate parent, so a reply whose parent
     * we never received (a participant added late, a message that bounced, a
     * forwarded branch) has nothing to match and starts a new thread. References
     * carries every ancestor, so any one of them can re-attach the reply to the
     * conversation it belongs to. Mail clients populate both; using only the
     * first is why threads fragment.
     */
    references: text("references"),
    /** Full payload (headers + bodies) lives in R2, never in D1. */
    r2Key: text("r2_key").notNull(),
    /**
     * R2 key of the original RFC822 source. It is the only artifact that makes
     * a message verifiable (DKIM) and byte-exact exportable.
     */
    rawMimeKey: text("raw_mime_key"),
    /**
     * Bytes this message put into R2: original MIME + stored attachments.
     *
     * Recorded at write time rather than measured later, because summing R2
     * object sizes for a quota check would mean listing the bucket on every
     * request. SUM(stored_bytes) is the install's storage footprint.
     */
    storedBytes: integer("stored_bytes").notNull().default(0),
    /**
     * Flattened, bounded projection of everything a user searches by: subject,
     * participants, and the leading body text.
     *
     * Bodies live in R2 and are far too large (and too slow) to search there, so
     * search needs a copy in D1. It is deliberately TRUNCATED rather than
     * complete — the aim is a mailbox that finds things, not a full-text archive
     * duplicated in the database. Nullable so it can be backfilled
     * lazily; a null simply means "not yet indexed", never "no match".
     */
    searchText: text("search_text"),
    hasHtml: bool("has_html").notNull().default(false),
    hasText: bool("has_text").notNull().default(false),
    /** [{ filename, contentType, size, r2Key }] — metadata only. */
    attachmentsMeta: json<unknown[]>("attachments_meta").notNull().default([]),
    /** messageId returned by the send_email binding for outbound sends. */
    sentMessageId: text("sent_message_id"),
    /**
     * Outbound delivery state: queued | sent | failed. Null for inbound.
     *
     * The row is written BEFORE the send binding is called, so a failed send
     * never destroys the message. A `queued` or `failed` row holds everything
     * needed to retry.
     */
    sendStatus: text("send_status", { enum: ["queued", "scheduled", "sent", "failed", "canceled"] }),
    /** Scheduled send: SendWorkflow sleeps until this instant. */
    scheduledAt: ts("scheduled_at"),
    /** Latest delivery event from the cf-email-events queue. Null for inbound. */
    deliveryStatus: text("delivery_status", {
      enum: ["delivered", "deferred", "bounced", "complained", "failed", "rejected"],
    }),
    /** Spam pipeline state: AI errors leave mail "unscanned" for a later rescan. */
    scanStatus: text("scan_status", { enum: ["pending", "scanned", "unscanned"] })
      .notNull()
      .default("pending"),
    /** The stored verdict (every signal and score), shown in the "why" panel. */
    spamVerdict: json<Record<string, unknown>>("spam_verdict"),
    /** Provider attempts made. Bounds automatic retry. */
    sendAttempts: integer("send_attempts").notNull().default(0),
    /** Last provider error, for display and diagnosis. Never contains secrets. */
    sendError: text("send_error"),
    /**
     * Delivery-scope half of the inbound idempotency key. One inbound email can
     * legitimately produce several message rows (one per routed mailbox, one per
     * held recipient), so the natural key is (scope, rfcMessageId) rather than
     * rfcMessageId alone.
     *
     * Routed copies scope to the address id; held/unrouted copies have no
     * address yet, so they scope to `held:<original recipient>`. A plain
     * `address_id` unique index could not cover the held path at all — SQLite
     * treats NULLs as distinct, so every retry of a held message would insert
     * again. Always non-empty; see dedupeScopeFor() in the worker.
     */
    dedupeScope: text("dedupe_scope").notNull(),
    occurredAt: stamp("occurred_at"),
    createdAt: stamp("created_at"),
  },
  (t) => [
    index("messages_thread_idx").on(t.threadId, t.occurredAt),
    index("messages_org_idx").on(t.organizationId, t.occurredAt),
    index("messages_rfc_id_idx").on(t.rfcMessageId),
    /** Address-scoped reply threading — see resolveThread(). */
    index("messages_org_addr_rfc_idx").on(t.organizationId, t.addressId, t.rfcMessageId),
    index("messages_sent_message_id_idx").on(t.sentMessageId),
    /**
     * THE inbound idempotency constraint. ingest's dedupe was a SELECT-then-
     * INSERT, which two concurrent queue deliveries both pass; this makes the
     * insert itself authoritative via ON CONFLICT DO NOTHING.
     */
    uniqueIndex("messages_dedupe_idx").on(t.organizationId, t.dedupeScope, t.rfcMessageId),
  ],
);

export const operationalEvents = sqliteTable(
  "operational_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    kind: text("kind").notNull(),
    level: text("level", { enum: ["info", "warn", "error"] }).notNull().default("info"),
    /** Diagnostic detail. MUST never contain bodies, keys, or secrets. */
    detail: json<Record<string, unknown>>("detail"),
    createdAt: stamp("created_at"),
  },
  (t) => [index("operational_events_org_idx").on(t.organizationId, t.createdAt)],
);

/** Gmail-style labels: many per thread, alongside the folders. */
export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    color: text("color"),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [uniqueIndex("labels_name_idx").on(sql`lower(${t.name})`)],
);

export const threadLabels = sqliteTable(
  "thread_labels",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
    createdAt: stamp("created_at"),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.labelId] }), index("thread_labels_label_idx").on(t.labelId)],
);

/**
 * The user's split and merge decisions. Threading consults these before its
 * own rules, so a split message never re-joins and merged threads stay merged
 * when later replies arrive.
 */
export const threadOverrides = sqliteTable(
  "thread_overrides",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["split", "merge"] }).notNull(),
    /** split: the message moved out. */
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    /** merge: the thread folded into targetThreadId. Not an FK; it no longer exists. */
    sourceThreadId: text("source_thread_id"),
    targetThreadId: text("target_thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [
    index("thread_overrides_message_idx").on(t.messageId),
    index("thread_overrides_source_idx").on(t.sourceThreadId),
    index("thread_overrides_target_idx").on(t.targetThreadId),
    check(
      "thread_overrides_kind_check",
      sql`(${t.kind} = 'split' AND ${t.messageId} IS NOT NULL) OR (${t.kind} = 'merge' AND ${t.sourceThreadId} IS NOT NULL)`,
    ),
  ],
);

export const ATTACHMENT_RISKS = ["safe", "previewable", "dangerous"] as const;

/**
 * Bytes live once in R2 at att/<sha256>; one row per message that carries
 * them. An object is deletable only when no row references its hash.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    /** Cleaned of path separators, control and bidi-override characters. */
    filename: text("filename").notNull(),
    declaredType: text("declared_type"),
    /** From magic bytes; the only type ever served. */
    detectedType: text("detected_type").notNull(),
    size: integer("size").notNull(),
    risk: text("risk", { enum: ATTACHMENT_RISKS }).notNull(),
    /** Content-ID for inline cid: images. */
    contentId: text("content_id"),
    inline: bool("inline").notNull().default(false),
    /** toMarkdown output in R2, for search, agents and spam signals. */
    textR2Key: text("text_r2_key"),
    createdAt: stamp("created_at"),
  },
  (t) => [index("attachments_message_idx").on(t.messageId), index("attachments_sha256_idx").on(t.sha256)],
);

/** Autosaved drafts: at most one per thread, plus any number of standalone ones. */
export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, { onDelete: "cascade" }),
    /** The message being replied to or forwarded. */
    replyToMessageId: text("reply_to_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    mode: text("mode", { enum: ["new", "reply", "reply_all", "forward", "forward_eml"] })
      .notNull()
      .default("new"),
    toEmails: json<string[]>("to_emails").notNull().default([]),
    ccEmails: json<string[]>("cc_emails").notNull().default([]),
    bccEmails: json<string[]>("bcc_emails").notNull().default([]),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    /** [{ filename, contentType, size, r2Key }]; uploads live under drafts/ in R2. */
    attachmentsMeta: json<unknown[]>("attachments_meta").notNull().default([]),
    scheduledAt: ts("scheduled_at"),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [
    uniqueIndex("drafts_thread_idx").on(t.threadId).where(sql`${t.threadId} IS NOT NULL`),
    index("drafts_address_idx").on(t.addressId, t.updatedAt),
  ],
);

/**
 * Expiring, revocable download links for files too large to attach. Only the
 * SHA-256 of the 128-bit token is stored.
 */
export const shareLinks = sqliteTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    downloadCount: integer("download_count").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [index("share_links_expires_idx").on(t.expiresAt)],
);
