import type { Env } from "../env";
import { dispatchIngest } from "../services/ingest-dispatch";

export async function handleIngestDispatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  // Sequential per batch; the D1 admission check also bounds competing batches.
  for (const message of batch.messages) {
    const rawKey = (message.body as { rawKey?: unknown } | null)?.rawKey;
    if (typeof rawKey !== "string" || rawKey.length > 100) { message.ack(); continue; }
    try {
      if (await dispatchIngest(env, rawKey) === "busy") message.retry({ delaySeconds: 30 });
      else message.ack();
    } catch { message.retry({ delaySeconds: 60 }); }
  }
}
