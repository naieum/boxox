import { appFetch } from "./app";
import { handleEmail } from "./email";
import type { Env } from "./env";
import { handleEmailEvents } from "./queues/cf-email-events";
import { handleWebhookDeliveries } from "./queues/webhook-delivery";
import { handleIngestDispatch } from "./queues/ingest-dispatch";
import { runScheduled } from "./scheduled";
import { freeRuntime, isFree } from "./services/capabilities";

export { MailboxHub } from "./do/mailbox-hub";
export { FreeRuntime } from "./do/free-runtime";
export { IngestWorkflow } from "./workflows/ingest";
export { EnrichWorkflow } from "./workflows/enrich";
export { SendWorkflow } from "./workflows/send";
export { SnoozeWorkflow } from "./workflows/snooze";

export default {
  async fetch(request, env, ctx) {
    return isFree(env) ? freeRuntime(env).fetch(request) : appFetch(request, env, ctx);
  },
  async email(message, env) {
    if (!isFree(env)) return handleEmail(message, env);
    const reject = await freeRuntime(env).receive({
      from: message.from, to: message.to, rawSize: message.rawSize,
      headers: [...message.headers], raw: message.raw,
    });
    if (reject) message.setReject(reject);
  },
  async queue(batch, env) {
    if (isFree(env)) {
      for (const message of batch.messages) {
        try {
          await freeRuntime(env).deliverWebhook(message.body);
          message.ack();
        } catch { message.retry(); }
      }
      return;
    }
    if (batch.queue === (env.INGEST_QUEUE_NAME ?? "ingest-dispatch")) return handleIngestDispatch(batch, env);
    if (batch.queue === (env.WEBHOOK_QUEUE_NAME ?? "webhook-delivery")) return handleWebhookDeliveries(batch, env);
    await handleEmailEvents(batch, env);
  },
  async scheduled(controller, env) {
    if (isFree(env)) await freeRuntime(env).scheduled(controller.cron);
    else await runScheduled(controller.cron, env);
  },
} satisfies ExportedHandler<Env>;
