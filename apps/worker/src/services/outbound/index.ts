import { and, eq, gt, lt, sql } from "drizzle-orm";
import { messages } from "@boxox/db";
import type { Db } from "../../db";

/**
 * Outbound delivery, separated from the route so the same code path serves both
 * the interactive send and SendWorkflow (phase 6).
 *
 * The message row is always written BEFORE this runs, so a failed send never
 * destroys the composed message — the one failure mode a mail product cannot
 * have.
 */

/** Queued sends older than this are closed out rather than replayed. */
export const RETRY_WINDOW_MS = 12 * 3600 * 1000;
/** Attempts before a message is left `failed` for a human to look at. */
export const MAX_SEND_ATTEMPTS = 5;

export interface OutboundPayload {
  messageId: string;
  organizationId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string | null;
  attachments: { filename: string; content: string; contentType?: string }[];
  inReplyTo: string | null;
  references: string | null;
  attempts: number;
}

export type DeliveryOutcome =
  | { ok: true; sentMessageId: string }
  | { ok: false; error: string; retryable: boolean };

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

/**
 * Deliver one queued message through the send_email binding and record the
 * outcome on its row.
 *
 * Every binding error is terminal for now: until Phase 0 confirms how send()
 * behaves on timeout, an error may mean the mail went out anyway, and a retry
 * would deliver a second copy. A visibly-failed message the owner can resend
 * deliberately is better than duplicate mail.
 */
export async function deliverQueuedMessage(
  db: Db,
  email: SendEmail,
  payload: OutboundPayload,
): Promise<DeliveryOutcome> {
  const attempts = payload.attempts + 1;
  try {
    const sent = await email.send({
      from: payload.from,
      to: payload.to,
      ...(payload.cc.length ? { cc: payload.cc } : {}),
      subject: payload.subject,
      text: payload.text,
      ...(payload.html ? { html: payload.html } : {}),
      attachments: payload.attachments.map((a) => ({
        disposition: "attachment" as const,
        filename: a.filename,
        type: a.contentType ?? "application/octet-stream",
        content: decodeBase64(a.content),
      })),
      headers: {
        ...(payload.inReplyTo ? { "In-Reply-To": payload.inReplyTo } : {}),
        ...(payload.references ? { References: payload.references } : {}),
      },
    });
    // A database blip after the binding has accepted the message must not look
    // like a send failure, or a retry would deliver a second copy.
    try {
      await db
        .update(messages)
        .set({
          sendStatus: "sent",
          sendAttempts: attempts,
          sendError: null,
          sentMessageId: sent.messageId,
        })
        .where(
          and(
            eq(messages.id, payload.messageId),
            eq(messages.organizationId, payload.organizationId),
            // Never overwrite a terminal state written by a concurrent attempt.
            eq(messages.sendStatus, "queued"),
          ),
        );
    } catch (bookkeeping) {
      console.error("outbound_mark_sent_failed", {
        messageId: payload.messageId,
        message: bookkeeping instanceof Error ? bookkeeping.message : String(bookkeeping),
      });
    }
    return { ok: true, sentMessageId: sent.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(messages)
      .set({
        sendStatus: "failed",
        sendAttempts: attempts,
        // Bounded: send errors are shown to users and stored indefinitely.
        sendError: message.slice(0, 500),
      })
      .where(
        and(
          eq(messages.id, payload.messageId),
          eq(messages.organizationId, payload.organizationId),
          eq(messages.sendStatus, "queued"),
        ),
      );
    return { ok: false, error: message, retryable: false };
  }
}

/**
 * Close out queued sends that can no longer be retried safely. Marking them
 * failed is what makes the state honest; the mail is still in R2 and the row
 * still carries everything needed to resend deliberately.
 */
export async function failExpiredSends(db: Db, orgId: string, now: number): Promise<number> {
  const expired = await db
    .update(messages)
    .set({
      sendStatus: "failed",
      sendError: sql`coalesce(${messages.sendError}, 'Not delivered within the retry window; resend to try again')`,
    })
    .where(
      and(
        eq(messages.organizationId, orgId),
        eq(messages.direction, "outbound"),
        eq(messages.sendStatus, "queued"),
        lt(messages.occurredAt, new Date(now - RETRY_WINDOW_MS)),
      ),
    )
    .returning({ id: messages.id });
  return expired.length;
}

/**
 * Messages still awaiting delivery for an org, oldest first.
 *
 * Bounded to the retry window: a message older than that is left alone rather
 * than risking a duplicate. Such rows keep
 * their `queued` status and are visible for a human to resend deliberately.
 */
export async function pendingOutbound(db: Db, orgId: string, now: number, limit = 20) {
  return await db
    .select({
      id: messages.id,
      r2Key: messages.r2Key,
      fromEmail: messages.fromEmail,
      fromName: messages.fromName,
      subject: messages.subject,
      inReplyTo: messages.inReplyTo,
      references: messages.references,
      sendAttempts: messages.sendAttempts,
      occurredAt: messages.occurredAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, orgId),
        eq(messages.direction, "outbound"),
        eq(messages.sendStatus, "queued"),
        lt(messages.sendAttempts, MAX_SEND_ATTEMPTS),
        gt(messages.occurredAt, new Date(now - RETRY_WINDOW_MS)),
      ),
    )
    .orderBy(messages.occurredAt)
    .limit(limit);
}

export { classifySendError, type SendErrorKind } from "./errors";
export { parseEmailEvent, recordEmailEvent } from "./events";
export { queueOutbound, type QueueOutboundInput, type QueueOutboundResult } from "./queue";
export { evaluateBreaker, sendingPause, suppressedRecipients } from "./safety";
