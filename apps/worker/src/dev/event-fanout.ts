import { and, eq } from "drizzle-orm";
import { apiMessages, messageEvents } from "@boxox/db";
import { createDb } from "../db";
import type { Env } from "../env";
import { emitWebhookEvent, WEBHOOK_EVENTS, type WebhookEventType } from "./webhooks";

export type EventFanoutEnv = Pick<Env, "DB"> & Partial<Pick<Env, "WEBHOOK_QUEUE" | "MAILBOX_HUB">>;

/**
 * Publish an already-durable API message fact. The timeline id and timestamp
 * remain unchanged across workflow/queue retries and tracking pixel reloads.
 */
export async function fanoutMessageEvent(env: EventFanoutEnv, messageId: string, eventId: string): Promise<void> {
  if (!env.WEBHOOK_QUEUE) return;
  const db = createDb(env);
  const [row] = await db.select({ event: messageEvents, message: apiMessages })
    .from(messageEvents).innerJoin(apiMessages, eq(apiMessages.id, messageEvents.apiMessageId))
    .where(and(eq(messageEvents.id, eventId), eq(apiMessages.id, messageId))).limit(1);
  if (!row) return;
  const type = `message.${row.event.type === "rejected" ? "failed" : row.event.type}`;
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(type)) return;
  await emitWebhookEvent({ ...env, WEBHOOK_QUEUE: env.WEBHOOK_QUEUE }, row.message.domainId, type as WebhookEventType, {
    id: row.message.id, messageId: row.message.id, from: row.message.fromEmail,
    ...(row.event.recipient ? { recipient: row.event.recipient } : {}),
    ...row.event.detail,
  }, { eventId: row.event.id, now: row.event.occurredAt.getTime() });
}
