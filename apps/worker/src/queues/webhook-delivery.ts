import { createDb } from "../db";
import { attemptDelivery, type DeliverDeps, type WebhookEnv, type WebhookQueueMessage } from "../dev/webhooks";
import { log } from "../log";

/**
 * Consumer for webhook-delivery: one attempt per message. A failed attempt is
 * re-sent with the next delay from the retry schedule rather than retried in
 * place, so the queue's own max_retries only covers crashes in this handler.
 */
export async function handleWebhookDeliveries(
  batch: MessageBatch<unknown>,
  env: WebhookEnv,
  deps: DeliverDeps = {},
): Promise<void> {
  const db = createDb(env);
  for (const msg of batch.messages) {
    const deliveryId = (msg.body as Partial<WebhookQueueMessage> | null)?.deliveryId;
    if (typeof deliveryId !== "string") {
      log.warn("webhook_message_unrecognised", { queueMessageId: msg.id });
      msg.ack();
      continue;
    }
    try {
      const outcome = await attemptDelivery(env, db, deliveryId, deps);
      if (outcome.kind === "retry") {
        await env.WEBHOOK_QUEUE.send({ deliveryId }, { delaySeconds: Math.ceil(outcome.delayMs / 1000) });
      }
      msg.ack();
    } catch (err) {
      log.error("webhook_delivery_failed", { queueMessageId: msg.id, deliveryId, error: err });
      msg.retry();
    }
  }
}
