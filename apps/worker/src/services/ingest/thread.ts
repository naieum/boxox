import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { messages, threads } from "@boxox/db";
import { normalizeSubject } from "@boxox/shared";
import type { Db } from "../../db";
import { parseReferences } from "../ingest";

export interface ThreadQuery {
  orgId: string;
  /** Null for held mail; it threads only with other mail held for the same recipient. */
  addressId: string | null;
  dedupeScope: string;
  subject: string;
  fromEmail: string;
  participants: string[];
  inReplyTo: string | null;
  references: string | null;
  occurredAt: Date;
}

/**
 * The threading hook: the existing conversation a new inbound message joins,
 * or null to start one. Ingest owns the writes; a resolver only reads, so a
 * retried step can call it again safely.
 */
export type ThreadResolver = (db: Db, q: ThreadQuery) => Promise<{ threadId: string } | null>;

const FALLBACK_WINDOW_MS = 30 * 24 * 3600 * 1000;

/**
 * v1's rules, superseded by services/threading.ts: the nearest ancestor from
 * In-Reply-To and References, matched inside one mailbox only (forged
 * References must not steer mail into another mailbox), then the normalized
 * subject with the same counterparty within 30 days.
 */
export const defaultThreadResolver: ThreadResolver = async (db, q) => {
  const ancestry = [q.inReplyTo, ...parseReferences(q.references).reverse()]
    .filter((id): id is string => !!id)
    .slice(0, 20);
  const mailbox = q.addressId
    ? eq(messages.addressId, q.addressId)
    : and(isNull(messages.addressId), eq(messages.dedupeScope, q.dedupeScope));
  if (ancestry.length) {
    const rows = await db
      .select({ threadId: messages.threadId, rfcMessageId: messages.rfcMessageId })
      .from(messages)
      .where(and(eq(messages.organizationId, q.orgId), mailbox, inArray(messages.rfcMessageId, [...new Set(ancestry)])));
    const byId = new Map(rows.map((r) => [r.rfcMessageId, r.threadId]));
    for (const id of ancestry) {
      const hit = byId.get(id);
      if (hit) return { threadId: hit };
    }
  }

  const subjectNorm = normalizeSubject(q.subject);
  if (!subjectNorm || !q.addressId) return null;
  const match = await db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.addressId, q.addressId),
        eq(threads.subjectNorm, subjectNorm),
        eq(threads.counterpartyEmail, q.fromEmail),
        gt(threads.lastMessageAt, new Date(q.occurredAt.getTime() - FALLBACK_WINDOW_MS)),
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    .limit(1);
  return match[0] ? { threadId: match[0].id } : null;
};
