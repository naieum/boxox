import { createDb } from "../db";
import { log } from "../log";
import { messagesDueForRescan } from "../services/spam/classifier";
import { scanStoredMessage, type SpamIngestEnv } from "../services/spam/ingest";

/** A small serial batch; current persisted consent and budget apply to each retry. */
export async function rescanUnscanned(env: SpamIngestEnv, limit = 10, now = Date.now()) {
  const due = await messagesDueForRescan(createDb(env), now, limit);
  let completed = 0;
  let failed = 0;
  for (const message of due) {
    try {
      await scanStoredMessage(env, message.id, { rescan: true });
      completed++;
    } catch (error) {
      failed++;
      log.error("spam_rescan_failed", { messageId: message.id, kind: error instanceof Error ? error.name : "unknown" });
    }
  }
  const result = { attempted: due.length, completed, failed, batchLimit: limit };
  if (due.length) log.info("spam_rescan_batch", result);
  return result;
}
