import type { Env, IngestParams } from "../env";
import { log } from "../log";

export const INGEST_RECOVERY_CRON = "*/5 * * * *";
const RECHECK_MS = 60_000;
const MAX_ATTEMPTS = 5;
const ORPHAN_CURSOR = "ingest:orphan-cursor:v1";
function missingWorkflow(error: unknown): boolean {
  // Only a definite missing-instance response releases an ambiguous slot.
  // Transport failures retain it until the status endpoint recovers.
  const text = error instanceof Error ? error.message : "";
  return /not.?found|does not exist|no such instance/i.test(text);
}
export interface IngestJob {
  raw_key: string; received_at: string; status: "staging" | "pending" | "running" | "complete" | "failed";
  attempts: number; next_attempt_at: number; updated_at: number; created_at: number;
  completed_at: number | null;
  last_error: string | null; message_id: string | null;
  enrichment_status: "none" | "pending" | "running" | "complete" | "failed";
}

export function ingestConcurrency(env: Pick<Env, "INGEST_MAX_CONCURRENCY">): number {
  const value = Number(env.INGEST_MAX_CONCURRENCY ?? 8);
  return Number.isInteger(value) && value >= 1 && value <= 64 ? value : 8;
}
export async function recordIngestJob(env: Pick<Env, "DB">, params: IngestParams, now = Date.now(), status: "staging" | "pending" = "pending"): Promise<void> {
  await env.DB.prepare(`INSERT INTO ingest_jobs (raw_key, received_at, status, next_attempt_at, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(raw_key) DO NOTHING`).bind(params.rawKey, params.receivedAt, status, now, now, now).run();
}
export async function getIngestJob(env: Pick<Env, "DB">, rawKey: string): Promise<IngestJob | null> {
  return env.DB.prepare("SELECT * FROM ingest_jobs WHERE raw_key = ?").bind(rawKey).first<IngestJob>();
}

/** The queue is only a wake-up hint: losing it cannot lose accepted mail. */
export async function submitIngest(env: Env, params: IngestParams): Promise<void> {
  await recordIngestJob(env, params);
  await env.DB.prepare("UPDATE ingest_jobs SET status = 'pending', updated_at = ? WHERE raw_key = ? AND status = 'staging'").bind(Date.now(), params.rawKey).run();
  try {
    if (env.INGEST_QUEUE && env.BOXOX_EDITION !== "free") await env.INGEST_QUEUE.send({ rawKey: params.rawKey });
    else await dispatchIngest(env, params.rawKey);
  } catch {
    // A recorded pending/running job is retried by reconciliation. Avoid SMTP
    // retries creating extra raw copies after we already accepted durable work.
    log.warn("ingest_dispatch_deferred", { rawKey: params.rawKey });
  }
}

async function failAttempt(env: Env, job: IngestJob, now: number) {
  const failed = job.attempts >= MAX_ATTEMPTS;
  await env.DB.prepare(`UPDATE ingest_jobs SET status = ?, next_attempt_at = ?, updated_at = ?, last_error = 'dispatch-unavailable'
    WHERE raw_key = ? AND status = 'running'`).bind(failed ? "failed" : "pending", now + Math.min(3_600_000, 30_000 * 2 ** job.attempts), now, job.raw_key).run();
}

/** Atomically reserve one of the installation's bounded in-flight slots. */
export async function dispatchIngest(env: Env, rawKey: string, now = Date.now()): Promise<"started" | "busy" | "settled"> {
  const claim = await env.DB.prepare(`UPDATE ingest_jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
    WHERE raw_key = ? AND status = 'pending' AND next_attempt_at <= ?
      AND (SELECT count(*) FROM ingest_jobs WHERE status = 'running') < ? RETURNING *`)
    .bind(now, rawKey, now, ingestConcurrency(env)).first<IngestJob>();
  if (!claim) {
    const job = await getIngestJob(env, rawKey);
    return job?.status === "pending" ? "busy" : "settled";
  }
  try {
    await env.INGEST_WORKFLOW.create({ id: rawKey, params: { rawKey, receivedAt: claim.received_at } });
    return "started";
  } catch {
    // create() may have succeeded remotely before the response was lost. Never
    // restart a running instance or assign a different id after that ambiguity.
    try {
      const instance = await env.INGEST_WORKFLOW.get(rawKey);
      const state = await instance.status();
      if (state.status === "complete") {
        await completeIngestJob(env, rawKey, false);
        return "settled";
      }
      if (state.status === "errored" || state.status === "terminated") {
        await instance.restart();
        return "started";
      }
      if (state.status === "paused") {
        await instance.resume();
        return "started";
      }
      if (["queued", "running", "waiting", "waitingForPause"].includes(state.status)) return "started";
    } catch { /* Recover through the durable ledger, without logging raw errors. */ }
    // Retain the running lease for one minute: reconciliation checks instance
    // status again before releasing the slot or allowing another create call.
    throw new Error("Ingest dispatch is awaiting reconciliation");
  }
}

export async function completeIngestJob(env: Env, rawKey: string, refill = true): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("UPDATE ingest_jobs SET status = 'complete', completed_at = coalesce(completed_at, ?), last_error = NULL, updated_at = ? WHERE raw_key = ?")
    .bind(now, now, rawKey).run();
  if (refill) {
    const { results } = await env.DB.prepare("SELECT raw_key FROM ingest_jobs WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, raw_key LIMIT 2").bind(Date.now()).all<{ raw_key: string }>();
    for (const job of results) {
      try { await dispatchIngest(env, job.raw_key); } catch { /* Ledger reconciliation recovers dispatch. */ }
    }
  }
}
export async function completeEnrichmentJob(env: Env, rawKey: string): Promise<void> {
  await env.DB.prepare("UPDATE ingest_jobs SET enrichment_status = 'complete' WHERE raw_key = ?").bind(rawKey).run();
  const { results } = await env.DB.prepare("SELECT raw_key FROM ingest_jobs WHERE status = 'complete' AND enrichment_status = 'pending' ORDER BY updated_at, raw_key LIMIT 2").all<{ raw_key: string }>();
  for (const job of results) await dispatchEnrichment(env, job.raw_key);
}
export async function scheduleEnrichment(env: Env, rawKey: string, messageId: string): Promise<void> {
  await env.DB.prepare("UPDATE ingest_jobs SET message_id = ?, enrichment_status = 'pending' WHERE raw_key = ? AND enrichment_status = 'none'")
    .bind(messageId, rawKey).run();
  await dispatchEnrichment(env, rawKey);
}

async function dispatchEnrichment(env: Env, rawKey: string) {
  if (!env.ENRICH_WORKFLOW) return;
  const job = await env.DB.prepare(`UPDATE ingest_jobs SET enrichment_status = 'running', updated_at = ?
    WHERE raw_key = ? AND enrichment_status = 'pending' AND message_id IS NOT NULL
      AND (SELECT count(*) FROM ingest_jobs WHERE enrichment_status = 'running') < ? RETURNING message_id`)
    .bind(Date.now(), rawKey, ingestConcurrency(env)).first<{ message_id: string }>();
  if (!job) return;
  try { await env.ENRICH_WORKFLOW.create({ id: rawKey, params: { rawKey, messageId: job.message_id } }); }
  catch { log.warn("ingest_enrichment_deferred", { rawKey }); }
}

/** Only explicitly versioned objects are scanned, so upgrading does not replay old mail. */
export async function recoverRawOrphans(env: Env, limit = 1000): Promise<number> {
  const cursor = await env.KV.get(ORPHAN_CURSOR);
  const page = await env.MAIL_STORE.list({ prefix: "inbound-", limit, cursor: cursor ?? undefined, include: ["customMetadata"] });
  let recovered = 0;
  const candidates = page.objects.filter(object => object.customMetadata?.ingestVersion === "2");
  for (let offset = 0; offset < candidates.length; offset += 80) {
    const group = candidates.slice(offset, offset + 80);
    const { results } = await env.DB.prepare(`SELECT raw_key FROM ingest_jobs WHERE raw_key IN (${group.map(() => "?").join(",")})`).bind(...group.map(object => object.key)).all<{ raw_key: string }>();
    const existing = new Set(results.map(row => row.raw_key));
    for (const object of group) if (!existing.has(object.key)) {
      await recordIngestJob(env, { rawKey: object.key, receivedAt: object.customMetadata?.receivedAt ?? object.uploaded.toISOString() });
      recovered++;
    }
  }
  if (page.truncated) await env.KV.put(ORPHAN_CURSOR, page.cursor);
  else await env.KV.delete(ORPHAN_CURSOR);
  return recovered;
}

/** The pre-write journal closes the R2/D1 gap without scanning historical mail. */
export async function recoverStagedIngest(env: Env, limit = 50, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare("SELECT raw_key, created_at FROM ingest_jobs WHERE status = 'staging' AND updated_at <= ? ORDER BY updated_at LIMIT ?")
    .bind(now - RECHECK_MS, Math.min(Math.max(limit, 1), 100)).all<{ raw_key: string; created_at: number }>();
  let recovered = 0;
  for (const job of results) {
    const raw = await env.MAIL_STORE.head(job.raw_key);
    if (raw) {
      await env.DB.prepare("UPDATE ingest_jobs SET status = 'pending', updated_at = ? WHERE raw_key = ? AND status = 'staging'").bind(now, job.raw_key).run();
      recovered++;
    } else if (job.created_at <= now - 24 * 60 * 60_000) {
      await env.DB.prepare("UPDATE ingest_jobs SET status = 'failed', last_error = 'raw-write-incomplete', updated_at = ? WHERE raw_key = ? AND status = 'staging'").bind(now, job.raw_key).run();
    } else {
      await env.DB.prepare("UPDATE ingest_jobs SET updated_at = ? WHERE raw_key = ? AND status = 'staging'").bind(now, job.raw_key).run();
    }
  }
  return recovered;
}

export async function reconcileIngest(env: Env, limit = 50, now = Date.now()) {
  const bounded = Math.min(Math.max(limit, 1), 100);
  const { results } = await env.DB.prepare(`SELECT * FROM ingest_jobs WHERE
    (status = 'pending' AND next_attempt_at <= ?) OR (status = 'running' AND updated_at <= ?)
    ORDER BY updated_at, raw_key LIMIT ?`).bind(now, now - RECHECK_MS, bounded).all<IngestJob>();
  for (const job of results) {
    try {
      if (job.status === "running") {
        let terminal = false;
        try {
          const instance = await env.INGEST_WORKFLOW.get(job.raw_key);
          const state = await instance.status();
          if (state.status === "complete") { await completeIngestJob(env, job.raw_key, false); continue; }
          if (["queued", "running", "waiting", "waitingForPause"].includes(state.status)) {
            await env.DB.prepare("UPDATE ingest_jobs SET updated_at = ? WHERE raw_key = ? AND status = 'running'").bind(now, job.raw_key).run();
            continue;
          }
          if (state.status === "paused") {
            await env.DB.prepare("UPDATE ingest_jobs SET status = 'failed', last_error = 'workflow-paused', updated_at = ? WHERE raw_key = ? AND status = 'running'").bind(now, job.raw_key).run();
            continue;
          }
          terminal = state.status === "errored" || state.status === "terminated";
        } catch (error) { terminal = missingWorkflow(error); }
        if (!terminal) {
          // A retained slot may precede create() itself (Worker crash). Creating
          // the exact same id is safe even while status is unavailable; an
          // existing instance is never restarted by this recovery path.
          try { await env.INGEST_WORKFLOW.create({ id: job.raw_key, params: { rawKey: job.raw_key, receivedAt: job.received_at } }); } catch { /* Recheck later. */ }
          await env.DB.prepare("UPDATE ingest_jobs SET updated_at = ? WHERE raw_key = ? AND status = 'running'").bind(now, job.raw_key).run();
          continue;
        }
        await failAttempt(env, job, now);
      } else await dispatchIngest(env, job.raw_key, now);
    } catch { log.warn("ingest_reconcile_deferred", { rawKey: job.raw_key }); }
  }
  if (env.ENRICH_WORKFLOW) {
    const { results: pending } = await env.DB.prepare("SELECT raw_key, message_id, enrichment_status FROM ingest_jobs WHERE status = 'complete' AND enrichment_status IN ('pending', 'running') AND message_id IS NOT NULL ORDER BY updated_at LIMIT ?").bind(bounded).all<Pick<IngestJob, "raw_key" | "message_id" | "enrichment_status">>();
    for (const job of pending) {
      try {
        if (job.enrichment_status === "pending") { await dispatchEnrichment(env, job.raw_key); continue; }
        // An exhausted enrichment workflow is retained for explicit owner replay.
        try {
          const state = await (await env.ENRICH_WORKFLOW.get(job.raw_key)).status();
          if (["errored", "terminated"].includes(state.status)) await env.DB.prepare("UPDATE ingest_jobs SET enrichment_status = 'failed' WHERE raw_key = ?").bind(job.raw_key).run();
          else if (state.status === "complete") await env.DB.prepare("UPDATE ingest_jobs SET enrichment_status = 'complete' WHERE raw_key = ?").bind(job.raw_key).run();
          else {
            if (state.status === "unknown") {
              try { await env.ENRICH_WORKFLOW.create({ id: job.raw_key, params: { rawKey: job.raw_key, messageId: job.message_id! } }); } catch { /* Same id, same reserved slot. */ }
            }
            await env.DB.prepare("UPDATE ingest_jobs SET updated_at = ? WHERE raw_key = ?").bind(now, job.raw_key).run();
          }
        } catch (error) {
          if (missingWorkflow(error)) await env.DB.prepare("UPDATE ingest_jobs SET enrichment_status = 'pending' WHERE raw_key = ? AND enrichment_status = 'running'").bind(job.raw_key).run();
          else {
            try { await env.ENRICH_WORKFLOW.create({ id: job.raw_key, params: { rawKey: job.raw_key, messageId: job.message_id! } }); } catch { /* Retain the slot through status outages. */ }
          }
        }
      } catch { log.warn("enrichment_reconcile_deferred", { rawKey: job.raw_key }); }
    }
  }
  return { checked: results.length };
}

export async function retryIngestJob(env: Env, rawKey: string): Promise<boolean> {
  const job = await getIngestJob(env, rawKey);
  if (!job || job.status === "running" || job.status === "staging") return false;
  if (job.last_error === "raw-write-incomplete" && !await env.MAIL_STORE.head(rawKey)) return false;
  if (job.status === "complete") {
    if (job.enrichment_status !== "failed" || !job.message_id || !env.ENRICH_WORKFLOW) return false;
    const claimed = await env.DB.prepare(`UPDATE ingest_jobs SET enrichment_status = 'running', updated_at = ?
      WHERE raw_key = ? AND enrichment_status = 'failed'
        AND (SELECT count(*) FROM ingest_jobs WHERE enrichment_status = 'running') < ? RETURNING raw_key`)
      .bind(Date.now(), rawKey, ingestConcurrency(env)).first();
    if (!claimed) return false;
    try { await (await env.ENRICH_WORKFLOW.get(rawKey)).restart(); }
    catch {
      await env.DB.prepare("UPDATE ingest_jobs SET enrichment_status = 'failed' WHERE raw_key = ? AND enrichment_status = 'running'").bind(rawKey).run();
      throw new Error("Enrichment replay unavailable");
    }
    return true;
  }
  await env.DB.prepare("UPDATE ingest_jobs SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?, last_error = NULL WHERE raw_key = ? AND status != 'running'").bind(Date.now(), Date.now(), rawKey).run();
  await dispatchIngest(env, rawKey);
  return true;
}
