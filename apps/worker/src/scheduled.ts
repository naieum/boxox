import { DOMAIN_MONITOR_CRON, monitorDomains } from "./crons/domain-monitor";
import { OPENPHISH_CRON, refreshOpenPhish } from "./crons/openphish";
import { rescanUnscanned } from "./crons/spam-rescan";
import { refitCombiner } from "./crons/spam-refit";
import { createDb } from "./db";
import { resealWebhookSecrets } from "./dev/webhooks";
import type { Env } from "./env";
import { log } from "./log";
import { runRetentionPurge } from "./services/retention";
import { INGEST_RECOVERY_CRON, reconcileIngest, recoverRawOrphans, recoverStagedIngest } from "./services/ingest-dispatch";

export async function runScheduled(cron: string, env: Env): Promise<void> {
  if (cron === INGEST_RECOVERY_CRON) {
    await recoverStagedIngest(env).catch(() => log.error("ingest_staging_recovery_failed"));
    await recoverRawOrphans(env).catch(() => log.error("ingest_orphan_recovery_failed"));
    await reconcileIngest(env).catch(() => log.error("ingest_recovery_failed"));
    // Webhook signing secrets stored before sealing existed are encrypted here, a batch at a time.
    await resealWebhookSecrets(env, createDb(env)).catch(() => log.error("webhook_secret_reseal_failed"));
    return;
  }
  if (cron === DOMAIN_MONITOR_CRON) { await monitorDomains(env); return; }
  await rescanUnscanned(env, 10).catch((error) => log.error("spam_rescan_batch_failed", { kind: error instanceof Error ? error.name : "unknown" }));
  if (cron === OPENPHISH_CRON) { await refreshOpenPhish(env); return; }
  await runRetentionPurge(env);
  await refitCombiner(env).catch((error) => log.error("spam_refit_failed", { error }));
}
