import { env, introspectWorkflowInstance } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addresses, aiSettings, messages, spamModels, spamTokens, spamTraining, threads } from "@boxox/db";
import { createDb } from "../src/db";
import worker from "../src/index";
import { inboundRawKey } from "../src/email";
import { utcDay } from "../src/services/ai";
import { runIngest, type IngestStep } from "../src/services/ingest/run";
import { learn } from "../src/services/spam/bayes";
import { scanStoredMessage } from "../src/services/spam/ingest";
import { getIngestJob, reconcileIngest } from "../src/services/ingest-dispatch";
import { fakeAi } from "./helpers/ai";
import { id, messageRow, seedMailbox, seedThread } from "./helpers/seed";

const db = createDb(env);
const SPAM = "cheap pills casino jackpot lottery viagra winner cash prize guaranteed discount investment exclusive offer money reward bonus credit promotion deal";
const step = { do: async (_name: string, a: unknown, b?: unknown) => ((typeof a === "function" ? a : b) as () => Promise<unknown>)() } as unknown as IngestStep;

async function setting(over: Partial<typeof aiSettings.$inferInsert> = {}) {
  const row = { id: 1, localFilters: true, reputationLookups: false, ai: false, provider: "cloudflare" as const, onlyWhenUncertain: false, dailyBudgetMicros: 1_000_000, ...over };
  await db.insert(aiSettings).values(row).onConflictDoUpdate({ target: aiSettings.id, set: row });
}

async function delivery(body = "Synthetic meeting note", from = "sender@ext.test", authenticated = true) {
  const domain = `${id()}.test`;
  const box = await seedMailbox(db, { orgId: id(), domain, localPart: "me" });
  const rawKey = inboundRawKey(new Date());
  const raw = new TextEncoder().encode([
    `From: Sender <${from}>`, `To: me@${domain}`, `Subject: Test ${id()}`,
    `Message-ID: <${id()}@ext.test>`, `Date: ${new Date().toUTCString()}`,
    `Authentication-Results: mx.cloudflare.net; spf=${authenticated ? "pass" : "fail"} smtp.mailfrom=ext.test; dkim=${authenticated ? "pass" : "fail"} header.d=ext.test; dmarc=${authenticated ? "pass" : "fail"} header.from=ext.test`,
    "Content-Type: text/plain; charset=utf-8", "", body,
  ].join("\r\n"));
  await env.MAIL_STORE.put(rawKey, raw, { customMetadata: { to: `me@${domain}`, from } });
  return { ...box, domain, params: { rawKey, receivedAt: new Date().toISOString() } };
}

async function stored(body?: string, authenticated = true) {
  const item = await delivery(body, "sender@ext.test", authenticated);
  const result = await runIngest(env, item.params, step);
  if (result.status !== "stored") throw new Error("fixture not stored");
  return { ...item, ...result };
}

beforeEach(async () => {
  await db.delete(aiSettings);
  await db.delete(spamTraining);
  await db.delete(spamTokens);
  await db.delete(spamModels);
  await env.KV.delete(`ai-spend:${utcDay()}`);
});

describe("inbound spam runtime integration", () => {
  it("finishes mandatory screening when replaying a failed instance that already stored its message", async () => {
    await setting();
    const item = await delivery();
    const failed = await introspectWorkflowInstance(env.INGEST_WORKFLOW, item.params.rawKey);
    try {
      await failed.modify(async (m) => {
        await m.disableRetryDelays();
        await m.mockStepError({ name: "scan message for spam" }, new Error("temporary screening outage"), 4);
      });
      await env.INGEST_WORKFLOW.create({ id: item.params.rawKey, params: item.params });
      await failed.waitForStatus("errored");
      const row = await db.query.messages.findFirst({ where: eq(messages.id, `msg-${item.params.rawKey}`) });
      expect(row?.scanStatus).toBe("pending");
    } finally { await failed.dispose(); }
    // Disposal clears only the local Workflow engine/history. D1 and R2 remain,
    // reproducing the persisted inputs of a restart from the first step. The
    // dispatch tests separately verify restart() is called for the same id.
    const replay = await introspectWorkflowInstance(env.INGEST_WORKFLOW, item.params.rawKey);
    try {
      await env.INGEST_WORKFLOW.create({ id: item.params.rawKey, params: item.params });
      await replay.waitForStatus("complete");
      const output = await replay.getOutput() as { status: string; messageId: string };
      expect(output.status).toBe("stored");
      expect(output.messageId).toBe(`msg-${item.params.rawKey}`);
      expect((await db.query.messages.findFirst({ where: eq(messages.id, output.messageId) }))?.scanStatus).toBe("scanned");
      expect(await getIngestJob(env, item.params.rawKey)).toMatchObject({ status: "complete" });
    } finally { await replay.dispose(); }
  });
  it("completes screened delivery even when optional enrichment exhausts its retries", async () => {
    await setting();
    const item = await delivery();
    const ingest = await introspectWorkflowInstance(env.INGEST_WORKFLOW, item.params.rawKey);
    const enrichment = await introspectWorkflowInstance(env.ENRICH_WORKFLOW!, item.params.rawKey);
    try {
      await enrichment.modify(async (m) => {
        await m.disableRetryDelays();
        await m.mockStepError({ name: "index message for search" }, new Error("synthetic enrichment unavailable"));
      });
      await env.INGEST_WORKFLOW.create({ id: item.params.rawKey, params: item.params });
      await ingest.waitForStatus("complete");
      await enrichment.waitForStatus("errored");
      const output = await ingest.getOutput() as { messageId: string; folder: string };
      expect(output.folder).toBe("inbox");
      expect(await ingest.waitForStepResult({ name: "emit message.received" })).toEqual([]);
      expect((await db.query.messages.findFirst({ where: eq(messages.id, output.messageId) }))?.scanStatus).toBe("scanned");
      expect(await getIngestJob(env, item.params.rawKey)).toMatchObject({ status: "complete", enrichment_status: "running" });
      await reconcileIngest(env);
      expect(await getIngestJob(env, item.params.rawKey)).toMatchObject({ status: "complete", enrichment_status: "failed" });
    } finally { await ingest.dispose(); await enrichment.dispose(); }
  });
  it("does not grant the known-correspondent bypass to an unauthenticated From", async () => {
    await setting({ ai: true });
    const item = await stored(SPAM, false);
    await db.insert(messages).values(messageRow(item, item.threadId, { direction: "outbound", fromEmail: `me@${item.domain}`, toEmails: ["sender@ext.test"] }));
    const ai = fakeAi();
    await scanStoredMessage({ ...env, AI: ai.ai }, item.messageId);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const row = await db.query.messages.findFirst({ where: eq(messages.id, item.messageId) });
    expect(row?.spamVerdict?.combiner).not.toMatchObject({ hardRule: "wrote-to-sender" });
  });

  it("runs the real workflow through Bayes, folder persistence and indexing with AI off", async () => {
    await setting();
    const item = await delivery(SPAM);
    const trainingThread = await seedThread(db, item);
    for (const label of ["spam", "ham"] as const) {
      const row = messageRow(item, trainingThread, { fromEmail: `${label}@training.test` });
      await db.insert(messages).values(row);
      await learn(db, row.id!, label, { subject: "Training", fromEmail: row.fromEmail!, text: label === "spam" ? SPAM : "meeting agenda review source code schedule discussion", html: null });
    }
    const instance = await introspectWorkflowInstance(env.INGEST_WORKFLOW, item.params.rawKey);
    try {
      await env.INGEST_WORKFLOW.create({ id: item.params.rawKey, params: item.params });
      await instance.waitForStatus("complete");
      expect(await instance.waitForStepResult({ name: "scan message for spam" })).toBe("spam");
      const enrichment = await introspectWorkflowInstance(env.ENRICH_WORKFLOW!, item.params.rawKey);
      try {
        await enrichment.waitForStatus("complete");
        expect(await enrichment.waitForStepResult({ name: "index message for search" })).toMatchObject({ vectors: { ok: false, reason: "no-model" } });
      } finally { await enrichment.dispose(); }
      const output = await instance.getOutput() as { messageId: string; threadId: string; folder: string };
      expect(output.folder).toBe("spam");
      const message = await db.query.messages.findFirst({ where: eq(messages.id, output.messageId) });
      expect(message?.scanStatus).toBe("scanned");
      expect(message?.spamVerdict).toMatchObject({ layer1: { ran: true }, bayes: { spamMessages: 1, hamMessages: 1 }, ai: { status: "skipped", reason: "ai-off" }, combiner: { folder: "spam", weights: "ai-free" } });
      expect((await db.query.threads.findFirst({ where: eq(threads.id, output.threadId) }))?.folder).toBe("spam");
      expect(await env.KV.get(`ai-spend:${utcDay()}`)).toBeNull();
      expect(await env.MAIL_STORE.head(item.params.rawKey)).not.toBeNull();
    } finally { await instance.dispose(); }
  });

  it("uses persisted consent, per-address opt-out and budget without model calls", async () => {
    const ai = fakeAi(() => { throw new Error("model must not run"); });
    const bindings = { ...env, AI: ai.ai };
    const first = await stored();
    await scanStoredMessage(bindings, first.messageId);
    expect((await db.query.messages.findFirst({ where: eq(messages.id, first.messageId) }))?.spamVerdict).toMatchObject({ layer1: { ran: false }, ai: { status: "skipped", reason: "certain" } });
    await setting({ ai: true });
    const opted = await stored();
    await db.update(addresses).set({ aiOptOut: true }).where(eq(addresses.id, opted.addressId));
    await scanStoredMessage(bindings, opted.messageId);
    expect((await db.query.messages.findFirst({ where: eq(messages.id, opted.messageId) }))?.spamVerdict).toMatchObject({ ai: { status: "skipped", reason: "address-opted-out" } });
    await setting({ ai: true, dailyBudgetMicros: 0 });
    const capped = await stored();
    await scanStoredMessage(bindings, capped.messageId);
    expect((await db.query.messages.findFirst({ where: eq(messages.id, capped.messageId) }))?.spamVerdict).toMatchObject({ ai: { status: "skipped", reason: "budget-spent" } });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("keeps AI failures unscanned and retries only when explicitly rescanned", async () => {
    await setting({ ai: true });
    const item = await stored();
    await db.update(threads).set({ priority: 3, category: "work" }).where(eq(threads.id, item.threadId));
    const ai = fakeAi(() => { throw new Error("synthetic unavailable model"); });
    const bindings = { ...env, AI: ai.ai };
    expect(await scanStoredMessage(bindings, item.messageId)).toBe("inbox");
    expect((await db.query.messages.findFirst({ where: eq(messages.id, item.messageId) }))?.spamVerdict).toMatchObject({ ai: { status: "unscanned", reason: "error", attempt: 1 }, combiner: { weights: "ai-free", fallback: "unscanned:error" } });
    expect(await db.query.threads.findFirst({ where: eq(threads.id, item.threadId) })).toMatchObject({ priority: 3, category: "work" });
    await scanStoredMessage(bindings, item.messageId);
    expect(ai.run).toHaveBeenCalledTimes(1);
    ai.run.mockImplementation(async () => ({ choices: [{ message: { content: JSON.stringify({ spam: 0, phishing: 0, impersonation: 0, prompt_injection: 0, category: "personal", priority: 1, reasons: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
    await scanStoredMessage(bindings, item.messageId, { rescan: true });
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(await db.query.threads.findFirst({ where: eq(threads.id, item.threadId) })).toMatchObject({ priority: 1, category: "personal" });
    expect((await db.query.messages.findFirst({ where: eq(messages.id, item.messageId) }))?.scanStatus).toBe("scanned");
  });

  it("honours a sender the owner actually wrote to, and preserves owner-chosen folders", async () => {
    await setting({ ai: true });
    const item = await stored(SPAM);
    const outgoing = messageRow(item, item.threadId, { direction: "outbound", fromEmail: `me@${item.domain}`, toEmails: ["sender@ext.test"] });
    await db.insert(messages).values(outgoing);
    const ai = fakeAi();
    await db.update(threads).set({ folder: "archive" }).where(eq(threads.id, item.threadId));
    expect(await scanStoredMessage({ ...env, AI: ai.ai }, item.messageId)).toBe("archive");
    expect((await db.query.messages.findFirst({ where: eq(messages.id, item.messageId) }))?.spamVerdict).toMatchObject({ combiner: { hardRule: "wrote-to-sender", folder: "inbox" } });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("scheduled rescans continue past an operational failure and complete other due mail", async () => {
    await setting({ ai: true });
    const ai = fakeAi(() => { throw new Error("synthetic outage"); });
    const bindings = { ...env, AI: ai.ai };
    const missing = await stored();
    const recoverable = await stored();
    for (const item of [missing, recoverable]) {
      await scanStoredMessage(bindings, item.messageId);
      const message = await db.query.messages.findFirst({ where: eq(messages.id, item.messageId) });
      const verdict = message!.spamVerdict!;
      await db.update(messages).set({ spamVerdict: { ...verdict, ai: { ...(verdict.ai as Record<string, unknown>), rescanAt: Date.now() - 1000 } } }).where(eq(messages.id, item.messageId));
    }
    await env.MAIL_STORE.delete(missing.params.rawKey);
    ai.run.mockImplementation(async () => ({ choices: [{ message: { content: JSON.stringify({ spam: 0, phishing: 0, impersonation: 0, prompt_injection: 0, category: "personal", priority: 1, reasons: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
    await worker.scheduled({ cron: "0 3 * * *", scheduledTime: Date.now() } as ScheduledController, bindings);
    expect((await db.query.messages.findFirst({ where: eq(messages.id, recoverable.messageId) }))?.scanStatus).toBe("scanned");
    expect((await db.query.messages.findFirst({ where: eq(messages.id, missing.messageId) }))?.scanStatus).toBe("unscanned");
    expect(ai.run).toHaveBeenCalledTimes(3);
  });

});
