import type { Env } from "../env";
import { ingestConcurrency } from "./ingest-dispatch";
import { organizationSendLimit } from "./agent-rate-limit";

/** Owner-requested aggregates; no mail bodies, sender identities or credential values. */
export async function readCapacity(env: Env, now = Date.now()) {
  const results = await env.DB.batch([
    env.DB.prepare("SELECT count(*) AS messages, coalesce(sum(stored_bytes),0) AS logicalStoredBytes FROM messages"),
    env.DB.prepare("SELECT status, count(*) AS count, min(created_at) AS oldestAt FROM ingest_jobs GROUP BY status"),
    env.DB.prepare("SELECT enrichment_status AS status, count(*) AS count FROM ingest_jobs GROUP BY enrichment_status"),
    env.DB.prepare("SELECT count(*) AS completedLastFiveMinutes FROM ingest_jobs WHERE completed_at >= ?").bind(now - 300_000),
    env.DB.prepare("SELECT avg(completed_at-created_at) AS averageIngestMs FROM (SELECT completed_at,created_at FROM ingest_jobs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1000)"),
    env.DB.prepare("SELECT state, count(*) AS count FROM agent_work GROUP BY state"),
    env.DB.prepare("SELECT count(*) AS reviewRequired FROM agent_send_requests WHERE state='pending'"),
    env.DB.prepare("SELECT status, count(*) AS count FROM webhook_deliveries GROUP BY status"),
  ]);
  const jobs = results[1]!.results as unknown as { status: string; count: number; oldestAt: number }[];
  return {
    at: new Date(now).toISOString(),
    mailbox: results[0]!.results[0],
    ingestion: { states: jobs, oldestPendingAgeMs: Math.max(0, now - (jobs.find(row => row.status === "pending")?.oldestAt ?? now)),
      ...(results[3]!.results[0] as Record<string, unknown>), ...(results[4]!.results[0] as Record<string, unknown>) },
    enrichment: results[2]!.results,
    work: results[5]!.results,
    sends: results[6]!.results[0],
    webhooks: results[7]!.results,
    limits: { ingestionConcurrency: ingestConcurrency(env), agentAndHumanSendsPer15Minutes: organizationSendLimit(env),
      searchBodyCharacters: env.SEARCH_BODY_CHAR_LIMIT ?? "32768", attachmentTextIndexing: env.INDEX_ATTACHMENT_TEXT !== "off" },
    measurement: "Logical message bytes include referenced copies; they are not physical R2 or D1 usage. Cloudflare billing and queue backlog remain in your account dashboard.",
  };
}
