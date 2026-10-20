import { readCapacity } from "../services/capacity";
import { Hono } from "hono";
import { requireOwner, requireSession, type AppContext } from "../middleware";
import { getIngestJob, ingestConcurrency, retryIngestJob, type IngestJob } from "../services/ingest-dispatch";

/** Installation-wide operational state is visible only to the installer. */
export const operationsRoutes = new Hono<AppContext>()
  .use("*", requireSession, requireOwner)
  .get("/capacity", async (c) => c.json(await readCapacity(c.env)))
  .get("/ingest", async (c) => {
    const status = c.req.query("status") ?? "failed";
    if (!["staging", "pending", "running", "complete", "failed"].includes(status)) return c.json({ error: { code: "bad_request", message: "Invalid status" } }, 400);
    const enrichment = c.req.query("enrichment");
    if (enrichment && !["pending", "running", "complete", "failed", "none"].includes(enrichment)) return c.json({ error: { code: "bad_request", message: "Invalid enrichment status" } }, 400);
    const query = enrichment
      ? c.env.DB.prepare("SELECT * FROM ingest_jobs WHERE enrichment_status = ? ORDER BY updated_at DESC, raw_key DESC LIMIT 100").bind(enrichment)
      : c.env.DB.prepare("SELECT * FROM ingest_jobs WHERE status = ? ORDER BY updated_at DESC, raw_key DESC LIMIT 100").bind(status);
    const { results } = await query.all<IngestJob>();
    const counts = await c.env.DB.prepare("SELECT status, count(*) AS count, min(created_at) AS oldest FROM ingest_jobs GROUP BY status").all();
    const enrichmentCounts = await c.env.DB.prepare("SELECT enrichment_status AS status, count(*) AS count FROM ingest_jobs GROUP BY enrichment_status").all();
    return c.json({ jobs: results, counts: counts.results, enrichmentCounts: enrichmentCounts.results, maxConcurrency: ingestConcurrency(c.env) });
  })
  .get("/ingest/:rawKey", async (c) => {
    const job = await getIngestJob(c.env, c.req.param("rawKey"));
    return job ? c.json({ job }) : c.json({ error: { code: "not_found", message: "No such ingestion job" } }, 404);
  })
  .post("/ingest/:rawKey/retry", async (c) => {
    const job = await getIngestJob(c.env, c.req.param("rawKey"));
    if (!job) return c.json({ error: { code: "not_found", message: "No such ingestion job" } }, 404);
    const retried = await retryIngestJob(c.env, job.raw_key);
    return retried ? c.json({ retried: true }) : c.json({ error: { code: "conflict", message: "The job is active or has nothing to replay" } }, 409);
  });
