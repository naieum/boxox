import { eq } from "drizzle-orm";
import { aiSettings } from "@boxox/db";
import { createDb } from "../db";
import { log } from "../log";
import { messagesDueForRescan } from "../services/spam/classifier";
import { markRulesCurrent, messagesWithOutdatedRules, scanStoredMessage, type SpamIngestEnv } from "../services/spam/ingest";

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

/**
 * After an upgrade that changes the local rules, scores recent inbox mail
 * again so phishing delivered before the upgrade is moved out. No model is
 * called. Each message is stamped whether or not it could be scored.
 */
export async function rescanOutdatedRules(env: SpamIngestEnv, limit = 25, now = Date.now()) {
  const db = createDb(env);
  const settings = await db.query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) });
  if (settings?.localFilters !== true) return { attempted: 0, moved: 0, failed: 0 };
  const outdated = await messagesWithOutdatedRules(db, now, limit);
  let moved = 0;
  let failed = 0;
  for (const message of outdated) {
    try {
      const folder = await scanStoredMessage(env, message.id, { rulesOnly: true });
      if (folder === "spam" || folder === "quarantine") moved++;
    } catch (error) {
      failed++;
      log.error("spam_rules_rescan_failed", { messageId: message.id, kind: error instanceof Error ? error.name : "unknown" });
    }
    await markRulesCurrent(db, message.id).catch(() => undefined);
  }
  const result = { attempted: outdated.length, moved, failed };
  if (outdated.length) log.info("spam_rules_rescan_batch", result);
  return result;
}
