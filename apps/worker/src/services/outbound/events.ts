import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import { apiMessages, messageEvents, messages } from "@boxox/db";
import type { Db } from "../../db";
import { suppress } from "./safety";

/**
 * Email Sending events from the cf-email-events queue. One event arrives per
 * recipient, all carrying the messageId send() returned (angle brackets
 * included), so outcomes are kept per recipient in message_events and the
 * message's delivery_status is the worst current outcome across recipients.
 */

export const DELIVERY_TYPES = ["delivered", "deferred", "bounced", "complained", "failed", "rejected"] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

/** Worst first: a complaint outranks a bounce, and anything outranks delivered. */
const SEVERITY: DeliveryType[] = ["complained", "bounced", "failed", "rejected", "deferred", "delivered"];

export interface EmailEvent {
  eventId: string;
  type: DeliveryType;
  messageId: string;
  sender: string;
  recipient: string;
  occurredAt: Date;
  detail: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Subscriptions take short names (message.bounced) but events arrive as
 * cf.email.sending.message.bounced. Returns null for anything unrecognised.
 */
export function parseEmailEvent(body: unknown): EmailEvent | null {
  const b = body as Record<string, any> | null;
  const p = b?.payload;
  const short = str(b?.type)?.replace(/^cf\.email\.sending\./, "").replace(/^message\./, "");
  const type = DELIVERY_TYPES.find((t) => t === short);
  const eventId = str(p?.eventId);
  const messageId = str(p?.messageId);
  const recipient = str(p?.recipient);
  if (!type || !eventId || !messageId || !recipient) return null;
  const at = new Date(str(b?.metadata?.eventTimestamp) ?? Date.now());
  const delivery = p.delivery ?? {};
  const bounce = p.bounce ?? {};
  const detail = Object.fromEntries(
    Object.entries({
      bounceType: str(bounce.type),
      classification: str(bounce.classification),
      smtpStatusCode: str(delivery.smtpStatusCode),
      smtpEnhancedStatusCode: str(delivery.smtpEnhancedStatusCode),
      smtpResponse: str(delivery.smtpResponse)?.slice(0, 300),
      terminal: typeof p.terminal === "boolean" ? p.terminal : undefined,
    }).filter(([, v]) => v !== undefined),
  );
  return {
    eventId,
    type,
    messageId,
    sender: str(p.sender) ?? "",
    recipient: recipient.toLowerCase(),
    occurredAt: Number.isNaN(at.getTime()) ? new Date() : at,
    detail,
  };
}

export function worstStatus(latestByRecipient: Iterable<DeliveryType>): DeliveryType | null {
  const seen = new Set(latestByRecipient);
  return SEVERITY.find((t) => seen.has(t)) ?? null;
}

async function aggregate(db: Db, where: SQL): Promise<DeliveryType | null> {
  const rows = await db
    .select({ recipient: messageEvents.recipient, type: messageEvents.type })
    .from(messageEvents)
    .where(and(where, inArray(messageEvents.type, [...DELIVERY_TYPES])))
    .orderBy(asc(messageEvents.occurredAt), asc(messageEvents.createdAt));
  const latest = new Map<string, DeliveryType>();
  for (const r of rows) latest.set(r.recipient ?? "", r.type as DeliveryType);
  return worstStatus(latest.values());
}

/**
 * Record one event. Safe to run again for the same event: the row is keyed by
 * Cloudflare's eventId (queue message ids differ per delivery), and the
 * status, suppression and breaker inputs are recomputed from stored rows.
 */
export async function recordEmailEvent(db: Db, ev: EmailEvent): Promise<{ matched: boolean; suppressed: boolean; apiMessageId?: string }> {
  const [msg] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.sentMessageId, ev.messageId))
    .limit(1);
  const [api] = await db
        .select({ id: apiMessages.id })
        .from(apiMessages)
        .where(eq(apiMessages.sentMessageId, ev.messageId))
        .limit(1);

  if (msg || api) {
    await db
      .insert(messageEvents)
      .values({
        id: `cf:${ev.eventId}`,
        messageId: api ? null : msg?.id ?? null,
        apiMessageId: api?.id ?? null,
        type: ev.type,
        recipient: ev.recipient,
        detail: ev.detail,
        occurredAt: ev.occurredAt,
      })
      .onConflictDoNothing();
    if (msg) {
      const status = await aggregate(db, api ? eq(messageEvents.apiMessageId, api.id) : eq(messageEvents.messageId, msg.id));
      await db.update(messages).set({ deliveryStatus: status }).where(eq(messages.id, msg.id));
    }
    if (api) {
      const status = await aggregate(db, eq(messageEvents.apiMessageId, api.id));
      // api_messages has no rejected status; a rejected recipient reads as failed.
      const apiStatus = status === "rejected" ? "failed" : status;
      if (apiStatus) {
        await db
          .update(apiMessages)
          .set({ status: apiStatus, updatedAt: new Date() })
          .where(eq(apiMessages.id, api.id));
      }
    }
  }

  // Cloudflare does not suppress after a bounce (spike finding 6), so we do.
  const hard = ev.type === "bounced" && ev.detail.bounceType !== "soft";
  const suppressed =
    (hard || ev.type === "complained") && ev.sender
      ? await suppress(db, {
          from: ev.sender,
          recipient: ev.recipient,
          reason: hard ? "bounce" : "complaint",
          detail: String(ev.detail.smtpResponse ?? ev.detail.classification ?? ev.type),
        })
      : false;
  return { matched: !!(msg || api), suppressed, ...(api ? { apiMessageId: api.id } : {}) };
}
