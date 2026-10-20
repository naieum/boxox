import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { completeEnrichmentJob, completeIngestJob, dispatchIngest, getIngestJob, recordIngestJob, reconcileIngest, recoverRawOrphans, recoverStagedIngest, retryIngestJob, scheduleEnrichment, submitIngest } from "../src/services/ingest-dispatch";
import { handleIngestDispatch } from "../src/queues/ingest-dispatch";
import { parseStep } from "../src/services/ingest/run";

const params = (key: string) => ({ rawKey: `inbound-20261019-${key}`, receivedAt: "2026-10-19T00:00:00.000Z" });
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM ingest_jobs").run();
  await env.KV.delete("ingest:orphan-cursor:v1");
});

describe("recoverable ingestion dispatch", () => {
  it("limits only indexed text and retains the complete body in R2", async () => {
    const item = params("search-budget");
    const body = "The complete original message remains available to agents. ".repeat(20);
    await env.MAIL_STORE.put(item.rawKey, `From: sender@example.test\r\nTo: inbox@example.test\r\nSubject: Search budget\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
    const summary = await parseStep({ ...env, SEARCH_BODY_CHAR_LIMIT: "12" }, item.rawKey);
    expect(summary.searchText).toHaveLength(12);
    const stored = await (await env.MAIL_STORE.get(summary.bodyKey))!.json<{ text: string }>();
    expect(stored.text.trim()).toBe(body.trim());
  });
  it("keeps a durable pending job when the burst queue is unavailable", async () => {
    const create = vi.fn();
    const bindings = { ...env, INGEST_QUEUE: { send: vi.fn(async () => { throw new Error("queue unavailable"); }) }, INGEST_WORKFLOW: { create } } as unknown as Env;
    await submitIngest(bindings, params("queue-outage"));
    expect(await getIngestJob(env, params("queue-outage").rawKey)).toMatchObject({ status: "pending", attempts: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it("reserves bounded slots atomically and releases them only after completion", async () => {
    const create = vi.fn(async () => ({}));
    const bindings = { ...env, INGEST_MAX_CONCURRENCY: "2", INGEST_WORKFLOW: { create } } as unknown as Env;
    for (const key of ["a", "b", "c"]) await recordIngestJob(env, params(key), 10);
    const result = await Promise.all(["a", "b", "c"].map(key => dispatchIngest(bindings, params(key).rawKey, 20)));
    expect(result.filter(status => status === "started")).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(2);
    const pending = await env.DB.prepare("SELECT raw_key FROM ingest_jobs WHERE status = 'pending'").first<{ raw_key: string }>();
    const running = await env.DB.prepare("SELECT raw_key FROM ingest_jobs WHERE status = 'running' LIMIT 1").first<{ raw_key: string }>();
    await completeIngestJob(bindings, running!.raw_key);
    expect(await dispatchIngest(bindings, pending!.raw_key, 30)).toBe("settled");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("fills a pending slot on completion without waiting for queue retries or cron", async () => {
    const create = vi.fn(async () => ({}));
    const bindings = { ...env, INGEST_MAX_CONCURRENCY: "1", INGEST_WORKFLOW: { create } } as unknown as Env;
    await recordIngestJob(env, params("first"));
    await recordIngestJob(env, params("next"));
    await dispatchIngest(bindings, params("first").rawKey);
    await completeIngestJob(bindings, params("first").rawKey);
    expect(await getIngestJob(env, params("next").rawKey)).toMatchObject({ status: "running" });
    expect(create).toHaveBeenCalledTimes(2);
    const before = (await getIngestJob(env, params("first").rawKey))!.completed_at;
    await completeIngestJob(bindings, params("first").rawKey);
    expect((await getIngestJob(env, params("first").rawKey))!.completed_at).toBe(before);
  });

  it("bounds optional enrichment separately and refills its pending work", async () => {
    const create = vi.fn(async () => ({}));
    const bindings = { ...env, INGEST_MAX_CONCURRENCY: "1", ENRICH_WORKFLOW: { create } } as unknown as Env;
    for (const key of ["enrich-a", "enrich-b", "enrich-c"]) {
      await recordIngestJob(env, params(key));
      await env.DB.prepare("UPDATE ingest_jobs SET status = 'complete' WHERE raw_key = ?").bind(params(key).rawKey).run();
      await scheduleEnrichment(bindings, params(key).rawKey, `msg-${key}`);
    }
    expect(create).toHaveBeenCalledTimes(1);
    await completeEnrichmentJob(bindings, params("enrich-a").rawKey);
    expect(create).toHaveBeenCalledTimes(2);
    const running = await env.DB.prepare("SELECT count(*) AS n FROM ingest_jobs WHERE enrichment_status = 'running'").first<{ n: number }>();
    expect(running?.n).toBe(1);
  });

  it("recovers directly journaled R2 writes and expires abandoned staging without deleting mail", async () => {
    await recordIngestJob(env, params("staged-raw"), 10, "staging");
    await recordIngestJob(env, params("missing-raw"), 10, "staging");
    await env.MAIL_STORE.put(params("staged-raw").rawKey, "durable MIME");
    expect(await recoverStagedIngest(env, 50, 25 * 60 * 60_000)).toBe(1);
    expect(await getIngestJob(env, params("staged-raw").rawKey)).toMatchObject({ status: "pending" });
    expect(await getIngestJob(env, params("missing-raw").rawKey)).toMatchObject({ status: "failed", last_error: "raw-write-incomplete" });
    expect(await env.MAIL_STORE.get(params("staged-raw").rawKey)).not.toBeNull();
  });

  it("does not create or restart a second instance after an ambiguous create response", async () => {
    const restart = vi.fn();
    const create = vi.fn(async () => { throw new Error("connection reset after accepted create"); });
    const bindings = { ...env, INGEST_QUEUE: undefined, INGEST_WORKFLOW: { create, get: async () => ({ status: async () => ({ status: "running" }), restart }) } } as unknown as Env;
    await submitIngest(bindings, params("ambiguous"));
    expect(await dispatchIngest(bindings, params("ambiguous").rawKey)).toBe("settled");
    await reconcileIngest(bindings, 10, Date.now() + 120_000);
    expect(create).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
    expect(await getIngestJob(env, params("ambiguous").rawKey)).toMatchObject({ status: "running", attempts: 1 });
  });

  it("retains its active slot if the workflow status service is unavailable", async () => {
    const bindings = { ...env, INGEST_QUEUE: undefined, INGEST_MAX_CONCURRENCY: "1", INGEST_WORKFLOW: { create: async () => { throw new Error("network failure"); }, get: async () => { throw new Error("network failure"); } } } as unknown as Env;
    await submitIngest(bindings, params("network"));
    await reconcileIngest(bindings, 10, Date.now() + 120_000);
    await recordIngestJob(env, params("later"));
    expect(await dispatchIngest(bindings, params("later").rawKey)).toBe("busy");
    expect(await getIngestJob(env, params("network").rawKey)).toMatchObject({ status: "running" });
  });

  it("recovers a raw R2 object left before its D1 job could be written, without replaying legacy mail", async () => {
    const current = params("orphan");
    await env.MAIL_STORE.put(current.rawKey, "retained MIME", { customMetadata: { ingestVersion: "2", receivedAt: current.receivedAt } });
    await env.MAIL_STORE.put(params("legacy").rawKey, "old MIME");
    expect(await recoverRawOrphans(env)).toBe(1);
    expect(await getIngestJob(env, current.rawKey)).toMatchObject({ status: "pending", received_at: current.receivedAt });
    expect(await getIngestJob(env, params("legacy").rawKey)).toBeNull();
    expect(await recoverRawOrphans(env)).toBe(0);
  });

  it("replays an exhausted job under the same workflow id", async () => {
    const item = params("replay");
    const restart = vi.fn(async () => {});
    const create = vi.fn(async () => { throw new Error("already_exists"); });
    const bindings = { ...env, INGEST_WORKFLOW: { create, get: async () => ({ status: async () => ({ status: "errored" }), restart }) } } as unknown as Env;
    await recordIngestJob(env, item);
    await env.DB.prepare("UPDATE ingest_jobs SET status = 'failed', attempts = 5 WHERE raw_key = ?").bind(item.rawKey).run();
    expect(await retryIngestJob(bindings, item.rawKey)).toBe(true);
    expect(create).toHaveBeenCalledWith({ id: item.rawKey, params: item });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(await getIngestJob(env, item.rawKey)).toMatchObject({ status: "running", attempts: 1 });
  });

  it("acknowledges malformed wake-ups and retries admission pressure", async () => {
    await recordIngestJob(env, params("slot"), 10);
    await recordIngestJob(env, params("overflow"), 10);
    const bindings = { ...env, INGEST_MAX_CONCURRENCY: "1", INGEST_WORKFLOW: { create: async () => ({}) } } as unknown as Env;
    await dispatchIngest(bindings, params("slot").rawKey, 20);
    const malformed = { body: {}, ack: vi.fn(), retry: vi.fn() };
    const full = { body: { rawKey: params("overflow").rawKey }, ack: vi.fn(), retry: vi.fn() };
    await handleIngestDispatch({ messages: [malformed, full] } as unknown as MessageBatch<unknown>, bindings);
    expect(malformed.ack).toHaveBeenCalledOnce();
    expect(full.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });
});
