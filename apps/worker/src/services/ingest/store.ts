import { and, eq, or, sql } from "drizzle-orm";
import { attachments, messages, threads } from "@boxox/db";
import { decideInboundFolder, normalizeSubject } from "@boxox/shared";
import { batch, type Db } from "../../db";
import type { AttachmentFacts } from "../attachments";
import { dedupeKeyFor, dedupeScopeFor, type StoredAttachment } from "../ingest";
import type { InboundRoute } from "./route";
import { threadingResolver } from "../threading";
import type { ThreadResolver } from "./thread";

/** attachmentsMeta keeps the v1 fields; the rest becomes an attachments row. */
export type InboundAttachment = StoredAttachment & AttachmentFacts;

/** What the parse step hands on: everything D1 needs, nothing heavy. */
export interface InboundSummary {
  rawKey: string;
  rawSize: number;
  /** R2 key of the { text, html } body JSON the thread view reads. */
  bodyKey: string;
  /** Set when parsing failed; the message is stored in Quarantine. */
  quarantineReason: string | null;
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  authenticated: boolean;
  snippet: string;
  searchText: string | null;
  hasText: boolean;
  hasHtml: boolean;
  attachments: InboundAttachment[];
  attachmentBytes: number;
}

export type StoreResult =
  | { status: "stored" | "duplicate"; messageId: string; threadId: string; folder: string }
  | { status: "dropped" | "unknown_domain" };

export const attachmentRowId = (messageId: string, index: number) => `att-${messageId}-${index}`;

type Routed = Extract<InboundRoute, { kind: "deliver" | "hold" }>;

function folderFor(route: Routed, mail: InboundSummary) {
  if (mail.quarantineReason) return "quarantine" as const;
  if (route.kind === "hold") return "unrouted" as const;
  return decideInboundFolder({
    senderBlocked: route.senderBlocked,
    authenticated: mail.authenticated,
    via: route.via,
    addressKind: route.addressKind,
  });
}

/**
 * One inbound copy into D1. Ids derive from the raw R2 key, so a retried
 * step finds its own earlier write and stops. The thread insert, message
 * insert and thread totals commit together in one batch; a different raw
 * message with the same Message-ID loses on messages_dedupe_idx, and its
 * would-be thread is deleted in the same batch so no empty thread is left.
 */
export async function storeInbound(
  db: Db,
  route: InboundRoute,
  mail: InboundSummary,
  occurredAt: Date,
  resolveThread: ThreadResolver = threadingResolver,
): Promise<StoreResult> {
  if (route.kind === "drop" || route.kind === "unknown_domain") {
    return { status: route.kind === "drop" ? "dropped" : "unknown_domain" };
  }
  const orgId = route.orgId;
  const addressId = route.kind === "deliver" ? route.addressId : null;
  const dedupeScope = dedupeScopeFor(route.kind === "deliver" ? { addressId: route.addressId } : { heldRecipient: route.recipient });
  const rfcMessageId = dedupeKeyFor({ rfcMessageId: mail.rfcMessageId, emailId: null, rawKey: mail.rawKey });
  const messageId = `msg-${mail.rawKey}`;
  const folder = folderFor(route, mail);

  const [existing] = await db
    .select({ id: messages.id, threadId: messages.threadId })
    .from(messages)
    .where(
      or(
        eq(messages.id, messageId),
        and(eq(messages.organizationId, orgId), eq(messages.dedupeScope, dedupeScope), eq(messages.rfcMessageId, rfcMessageId)),
      ),
    )
    .limit(1);
  // Our own row means an earlier attempt of this step already committed.
  if (existing) return { status: existing.id === messageId ? "stored" : "duplicate", messageId: existing.id, threadId: existing.threadId, folder };

  const participants = [...new Set([mail.fromEmail, ...mail.toEmails, ...mail.ccEmails].filter(Boolean))];
  // Quarantined mail never joins a conversation: its headers weren't parsed.
  const match = mail.quarantineReason
    ? null
    : await resolveThread(db, {
        orgId,
        addressId,
        dedupeScope,
        subject: mail.subject,
        fromEmail: mail.fromEmail,
        participants,
        inReplyTo: mail.inReplyTo,
        references: mail.references,
        occurredAt,
      });
  const joined = match
    ? await db.query.threads.findFirst({ where: and(eq(threads.id, match.threadId), eq(threads.organizationId, orgId)) })
    : undefined;
  const threadId = joined?.id ?? `thr-${mail.rawKey}`;
  const newParticipant = !!joined && !!mail.fromEmail && !joined.participants.includes(mail.fromEmail);

  const created = joined
    ? []
    : [
        db
          .insert(threads)
          .values({
            id: threadId,
            organizationId: orgId,
            addressId,
            domainId: route.domainId,
            originalRecipient: route.kind === "hold" ? route.recipient : null,
            subject: mail.subject,
            subjectNorm: normalizeSubject(mail.subject),
            counterpartyEmail: mail.fromEmail || null,
            counterpartyName: mail.fromName,
            participants,
            folder,
            lastMessageAt: occurredAt,
          })
          .onConflictDoNothing(),
      ];
  const orphan = sql`NOT EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.threadId} = ${threadId})`;
  const inserted = sql`EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.id} = ${messageId})`;

  await batch(db, [
    ...created,
    db
      .insert(messages)
      .values({
        id: messageId,
        threadId,
        organizationId: orgId,
        addressId,
        direction: "inbound",
        fromEmail: mail.fromEmail,
        fromName: mail.fromName,
        authenticated: mail.authenticated,
        newParticipant,
        toEmails: mail.toEmails,
        ccEmails: mail.ccEmails,
        subject: mail.subject,
        snippet: mail.snippet,
        rfcMessageId,
        inReplyTo: mail.inReplyTo,
        references: mail.references,
        r2Key: mail.bodyKey,
        rawMimeKey: mail.rawKey,
        storedBytes: mail.rawSize + mail.attachmentBytes,
        searchText: mail.searchText,
        hasHtml: mail.hasHtml,
        hasText: mail.hasText,
        attachmentsMeta: mail.attachments.map(({ filename, contentType, size, r2Key, truncated }, index) => ({
          id: attachmentRowId(messageId, index),
          filename,
          contentType,
          size,
          r2Key,
          truncated,
        })),
        dedupeScope,
        occurredAt,
      })
      .onConflictDoNothing(),
    // Rows only for a message this batch inserted; a lost dedupe race inserts none.
    ...mail.attachments.map((a, index) =>
      db
        .insert(attachments)
        .select(
          sql`SELECT ${attachmentRowId(messageId, index)}, ${messageId}, ${a.sha256}, ${a.filename}, ${a.declaredType}, ${a.detectedType}, ${a.size}, ${a.risk}, ${a.contentId}, ${a.inline ? 1 : 0}, NULL, ${occurredAt.getTime()} WHERE ${inserted}`,
        )
        .onConflictDoNothing(),
    ),
    ...(joined ? [] : [db.delete(threads).where(and(eq(threads.id, threadId), orphan))]),
    db
      .update(threads)
      .set({
        messageCount: sql`(SELECT count(*) FROM ${messages} WHERE ${messages.threadId} = ${threadId})`,
        lastMessageAt: sql`(SELECT max(${messages.occurredAt}) FROM ${messages} WHERE ${messages.threadId} = ${threadId})`,
        snippet: sql`(SELECT ${messages.snippet} FROM ${messages} WHERE ${messages.threadId} = ${threadId} ORDER BY ${messages.occurredAt} DESC LIMIT 1)`,
        participants: sql`(SELECT json_group_array(value) FROM (SELECT value FROM json_each(${threads.participants}) UNION SELECT value FROM json_each(${JSON.stringify(participants)})))`,
        // Received replies bring sent or archived conversations into Inbox, unless muted.
        folder: sql`CASE WHEN ${folder} = 'inbox' AND ${threads.folder} IN ('archive', 'sent') AND ${threads.muted} = 0 THEN 'inbox' ELSE ${threads.folder} END`,
        unread: true,
        updatedAt: new Date(),
      })
      .where(and(eq(threads.id, threadId), inserted)),
  ]);

  const [row] = await db.select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, messageId)).limit(1);
  if (row) return { status: "stored", messageId, threadId: row.threadId, folder };
  const [dup] = await db
    .select({ id: messages.id, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.organizationId, orgId), eq(messages.dedupeScope, dedupeScope), eq(messages.rfcMessageId, rfcMessageId)))
    .limit(1);
  if (!dup) throw new Error("inbound message was neither stored nor deduplicated");
  return { status: "duplicate", messageId: dup.id, threadId: dup.threadId, folder };
}
