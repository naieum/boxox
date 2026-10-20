import { createDb } from "../db";
import { fanoutMessageEvent, type EventFanoutEnv } from "../dev/event-fanout";
import { notifyDeliveryStatus } from "../do/mailbox-hub";
import { log } from "../log";
import { parseEmailEvent, recordEmailEvent } from "../services/outbound/events";
import { evaluateBreaker } from "../services/outbound/safety";

/**
 * Consumer for cf-email-events: delivery status per recipient, suppression of
 * hard bounces and complaints, then one circuit-breaker check per batch. A
 * message that fails to record is retried (and dead-lettered after
 * max_retries), never dropped.
 */
export async function handleEmailEvents(batch: MessageBatch<unknown>, env: EventFanoutEnv): Promise<void> {
  const db = createDb(env);
  let negative = false;
  for (const msg of batch.messages) {
    const ev = parseEmailEvent(msg.body);
    if (!ev) {
      log.warn("email_event_unrecognised", { queueMessageId: msg.id });
      msg.ack();
      continue;
    }
    try {
      const { matched, apiMessageId } = await recordEmailEvent(db, ev);
      if (ev.type === "bounced" || ev.type === "complained") negative = true;
      if (apiMessageId) await fanoutMessageEvent(env, apiMessageId, `cf:${ev.eventId}`);
      msg.ack();
      if (matched) await notifyDeliveryStatus(env, db, ev.messageId);
    } catch (err) {
      log.error("email_event_record_failed", { queueMessageId: msg.id, eventId: ev.eventId, error: err });
      msg.retry();
    }
  }
  if (negative) await evaluateBreaker(db);
}
