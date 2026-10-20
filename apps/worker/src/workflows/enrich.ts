import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { EnrichParams, Env } from "../env";
import { freeRuntime, isFree } from "../services/capabilities";
import { indexStoredMessage } from "../services/search/runtime";
import { completeEnrichmentJob } from "../services/ingest-dispatch";

/** Optional extraction/embeddings run after delivery, with their own retry budget. */
export class EnrichWorkflow extends WorkflowEntrypoint<Env, EnrichParams> {
  async run(event: WorkflowEvent<EnrichParams>, step: WorkflowStep) {
    const { rawKey, messageId } = event.payload;
    const result = await step.do("index message for search", { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes" }, async () => {
      const row = await this.env.DB.prepare(`SELECT m.scan_status, t.folder FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?`).bind(messageId).first<{ scan_status: string; folder: string }>();
      if (!row || row.scan_status === "pending" || ["quarantine", "unrouted"].includes(row.folder)) return { skipped: true };
      const indexed = isFree(this.env) ? await freeRuntime(this.env).index(messageId) : await indexStoredMessage(this.env, messageId);
      if (indexed && (("error" in indexed) || (!indexed.vectors.ok && indexed.vectors.reason === "error"))) throw new Error("Optional search enrichment unavailable");
      return indexed;
    });
    await step.do("complete enrichment job", () => completeEnrichmentJob(this.env, rawKey));
    return result;
  }
}
