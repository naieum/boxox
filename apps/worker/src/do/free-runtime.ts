import { DurableObject } from "cloudflare:workers";
import { appFetch } from "../app";
import { createDb } from "../db";
import { emitReceivedEvent } from "../dev/received";
import { attemptDelivery } from "../dev/webhooks";
import { handleEmail } from "../email";
import type { Env } from "../env";
import { runScheduled } from "../scheduled";
import { notifyNewMessage } from "./mailbox-hub";
import { parseStep } from "../services/ingest/run";
import { routeInbound } from "../services/ingest/route";
import { storeInbound, type InboundSummary } from "../services/ingest/store";
import type { InboundRoute } from "../services/ingest/route";
import { scanStoredMessage } from "../services/spam/ingest";
import { indexStoredMessage } from "../services/search/runtime";

/**
 * Free Workers have 10 ms of CPU per invocation/Workflow step. SQLite Durable
 * Objects have a separate CPU allowance. Keep parsing and app logic here;
 * Workflow steps still persist results and control retries outside this object.
 * RPC methods are binding-only. Public fetch always runs the authenticated app.
 */
export class FreeRuntime extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
      passThroughOnException: () => {}, props: {},
    } as ExecutionContext;
    return appFetch(request, this.env, ctx);
  }

  async receive(input: { from: string; to: string; rawSize: number; headers: [string, string][]; raw: ReadableStream<Uint8Array> }): Promise<string | null> {
    let rejected: string | null = null;
    await handleEmail({ ...input, headers: new Headers(input.headers), setReject: reason => { rejected = reason; } }, this.env);
    return rejected;
  }

  parse(rawKey: string) { return parseStep(this.env, rawKey); }
  route(mail: InboundSummary & { recipient: string; envelopeFrom: string }, receivedAt: string) {
    const senders = [...new Set([mail.fromEmail, mail.envelopeFrom].filter(sender => sender.includes("@")))];
    return routeInbound(createDb(this.env), mail.recipient, senders, new Date(receivedAt));
  }
  store(route: InboundRoute, mail: InboundSummary, receivedAt: string) {
    return storeInbound(createDb(this.env), route, mail, new Date(receivedAt));
  }
  scan(messageId: string) { return scanStoredMessage(this.env, messageId); }
  index(messageId: string) { return indexStoredMessage(this.env, messageId); }
  async notify(messageId: string, folder: string) {
    await notifyNewMessage(this.env, createDb(this.env), messageId, folder);
  }
  emit(messageId: string) { return emitReceivedEvent(this.env, messageId); }
  async scheduled(cron: string) { await runScheduled(cron, this.env); }
  async deliverWebhook(body: unknown) {
    const id = (body as { deliveryId?: unknown } | null)?.deliveryId;
    if (typeof id !== "string") return;
    const result = await attemptDelivery(createDb(this.env), id);
    if (result.kind === "retry") await this.env.WEBHOOK_QUEUE.send({ deliveryId: id }, { delaySeconds: Math.ceil(result.delayMs / 1000) });
  }
}
