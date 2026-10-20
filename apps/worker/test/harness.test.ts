import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { messageEvents, messages, threads } from "@boxox/db";
import worker from "../src/index";
import { createDb } from "../src/db";
import { MODEL_IDS, memoryBudgetStore, runAi } from "../src/services/ai";
import { fakeAi, fakeVectorize } from "./helpers/ai";
import { messageRow, seedMailbox, seedThread } from "./helpers/seed";

/**
 * The harness itself: every suite runs in workerd with the root wrangler.jsonc
 * bindings, so a regression here (a binding dropped, migrations not applied)
 * would make the other suites pass for the wrong reason.
 */
const db = createDb(env);

describe("test harness bindings", () => {
  it("applies every migration to the per-file D1", async () => {
    const applied = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(applied.results.map((r) => r.name)).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
    expect(applied.results.length).toBeGreaterThanOrEqual(2);
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const names = tables.results.map((r) => r.name);
    for (const t of ["threads", "messages", "threads_fts", "api_keys", "webhooks"]) expect(names).toContain(t);
  });

  it("enforces foreign keys, as D1 does in production", async () => {
    const box = await seedMailbox(db, { orgId: "fk" });
    await expect(db.insert(messages).values(messageRow(box, "no-such-thread"))).rejects.toThrow();
  });

  it("round-trips an object through R2", async () => {
    await env.MAIL_STORE.put("harness/a.eml", "Subject: hi\r\n\r\nbody", { httpMetadata: { contentType: "message/rfc822" } });
    const got = await env.MAIL_STORE.get("harness/a.eml");
    expect(await got?.text()).toBe("Subject: hi\r\n\r\nbody");
    expect(got?.httpMetadata?.contentType).toBe("message/rfc822");
    await env.MAIL_STORE.delete("harness/a.eml");
    expect(await env.MAIL_STORE.head("harness/a.eml")).toBeNull();
  });

  it("sends to the webhook-delivery queue producer", async () => {
    const sent = (await env.WEBHOOK_QUEUE.send({ deliveryId: "harness" }, { delaySeconds: 1 })) as unknown;
    expect(sent).toMatchObject({ metadata: expect.any(Object) });
  });

  it("delivers a queue batch to the worker's queue handler", async () => {
    // An unrecognised body is acked, not retried forever.
    const batch = createMessageBatch("webhook-delivery", [
      { id: "q1", timestamp: new Date(), attempts: 1, body: { nonsense: true } },
    ]);
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks).toEqual(["q1"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("runs the nightly cron handler", async () => {
    const box = await seedMailbox(db, { orgId: "cron" });
    const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    const threadId = await seedThread(db, box, { folder: "trash", updatedAt: old });
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "0 3 * * *" }), env);
    expect(await db.select().from(threads).where(eq(threads.id, threadId))).toEqual([]);
  });

  it("runs SendWorkflow through the local Workflows engine", async () => {
    const box = await seedMailbox(db, { orgId: "wf" });
    const threadId = await seedThread(db, box);
    const row = messageRow(box, threadId, { direction: "outbound", sendStatus: "queued", toEmails: ["ann@example.test"] });
    await db.insert(messages).values(row);

    const instance = await introspectWorkflowInstance(env.SEND_WORKFLOW, `wf-${row.id}`);
    try {
      // The send itself is mocked so nothing reaches the send_email binding; the
      // gate and the bookkeeping steps run for real against D1.
      await instance.modify(async (m) => {
        await m.mockStepResult({ name: "send attempt 1" }, { kind: "sent", sentMessageId: "<wf@s.test>", recorded: false });
      });
      await env.SEND_WORKFLOW.create({ id: `wf-${row.id}`, params: { messageId: row.id! } });
      await instance.waitForStatus("complete");
      expect(await instance.getOutput()).toBe("sent");
    } finally {
      await instance.dispose();
    }
    const [sent] = await db.select().from(messages).where(eq(messages.id, row.id!));
    expect(sent?.sendStatus).toBe("sent");
    expect(sent?.sentMessageId).toBe("<wf@s.test>");
    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, row.id!));
    expect(events.map((e) => e.type)).toEqual(["sent"]);
  });

  it("stops SendWorkflow without sending when the message is gone", async () => {
    const instance = await introspectWorkflowInstance(env.SEND_WORKFLOW, "wf-missing");
    try {
      await env.SEND_WORKFLOW.create({ id: "wf-missing", params: { messageId: "does-not-exist" } });
      await instance.waitForStatus("complete");
      expect(await instance.getOutput()).toBe("missing");
    } finally {
      await instance.dispose();
    }
  });
});

describe("Workers AI and Vectorize fakes", () => {
  it("routes runAi through the fake and records the call", async () => {
    const { ai, run } = fakeAi(() => ({ response: "spam", usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    const result = await runAi(
      { ai, consent: { enabled: true, provider: "openai" }, budget: memoryBudgetStore(), dailyBudgetUsd: 1 },
      { model: "@cf/openai/gpt-oss-20b", input: { prompt: "synthetic, not mail" }, feature: "harness" },
    );
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe("@cf/openai/gpt-oss-20b");
    expect(MODEL_IDS).toContain(run.mock.calls[0]![0]);
  });

  it("answers nearest-neighbour queries from the fake index", async () => {
    const { index } = fakeVectorize();
    await index.upsert([
      { id: "spam", values: [1, 0, 0], metadata: { label: "spam" } },
      { id: "ham", values: [0, 1, 0], metadata: { label: "ham" } },
      { id: "near-spam", values: [0.9, 0.1, 0], metadata: { label: "spam" } },
    ]);
    const res = await index.query([1, 0, 0], { topK: 2, returnMetadata: "all" });
    expect(res.matches.map((m) => m.id)).toEqual(["spam", "near-spam"]);
    expect(res.matches[0]!.score).toBeCloseTo(1);
    const filtered = await index.query([1, 0, 0], { topK: 5, filter: { label: "ham" } });
    expect(filtered.matches.map((m) => m.id)).toEqual(["ham"]);
    await index.deleteByIds(["spam"]);
    expect((await index.getByIds(["spam", "ham"])).map((v) => v.id)).toEqual(["ham"]);
  });
});
