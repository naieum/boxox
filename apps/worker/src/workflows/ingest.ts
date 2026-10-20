import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createDb } from "../db";
import { emitReceivedEvent } from "../dev/received";
import { notifyNewMessage } from "../do/mailbox-hub";
import type { Env, IngestParams } from "../env";
import { freeRuntime, isFree } from "../services/capabilities";
import { runIngest } from "../services/ingest/run";
import { scanStoredMessage } from "../services/spam/ingest";
import { completeIngestJob, recordIngestJob, scheduleEnrichment } from "../services/ingest-dispatch";
import type { StoreResult } from "../services/ingest/store";

/**
 * Parse (postal-mime, with limits) → route → thread/dedupe → store, one
 * durable step each, then a push to open clients. The instance id is the raw
 * message's R2 key, so retries are idempotent; mail that won't parse is
 * quarantined rather than retried.
 */
export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep): Promise<StoreResult> {
    const runtime = isFree(this.env) ? freeRuntime(this.env) : null;
    await step.do("record ingestion job", () => recordIngestJob(this.env, event.payload));
    let stored = await runIngest(this.env, event.payload, step);
    if (stored.status === "stored") {
      const messageId = stored.messageId;
      const folder = await step.do("scan message for spam", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" }, () => runtime ? runtime.scan(messageId) : scanStoredMessage(this.env, messageId));
      if (folder) stored = { ...stored, folder };
      const actualFolder = stored.folder;
      await step.do("notify clients", () => runtime ? runtime.notify(messageId, actualFolder) : notifyNewMessage(this.env, createDb(this.env), messageId, actualFolder));
      await step.do("emit message.received", () => runtime ? runtime.emit(messageId) : emitReceivedEvent(this.env, messageId));
      if (stored.folder !== "quarantine" && stored.folder !== "unrouted") {
        await step.do("schedule optional enrichment", () => scheduleEnrichment(this.env, event.payload.rawKey, messageId));
      }
    }
    await step.do("complete ingestion job", () => completeIngestJob(this.env, event.payload.rawKey));
    return stored;
  }
}
