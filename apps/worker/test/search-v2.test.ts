import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { attachments, messages } from "@boxox/db";
import { createDb, searchThreads } from "../src/db";
import { memoryBudgetStore, type AiConsent } from "../src/services/ai";
import { attachmentTextKey } from "../src/services/attachments";
import { fuseRanks, hybridSearch, indexMessage, vectorId, RRF_K, ATTACHMENT_MARK } from "../src/services/search";
import { fakeAi, fakeVectorize } from "./helpers/ai";
import { id, messageRow, seedMailbox, seedThread } from "./helpers/seed";

/**
 * Hybrid search on a real D1 and R2. Embeddings come from a fake that maps a
 * few words to fixed concept axes, so "meaning" is predictable and nothing
 * reaches a model; Vectorize is the in-memory fake.
 */
const db = createDb(env);
const EMBED = "openai/text-embedding-3-small";
const DIMS = 1536;
const CONCEPTS: Record<string, number> = {
  invoice: 0, bill: 0, billing: 0, payment: 0, receipt: 0,
  turbine: 1, turbines: 1, windmill: 1, wind: 1,
  flight: 2, trip: 2, itinerary: 2, boarding: 2,
};

function embedding(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const axis = CONCEPTS[word];
    if (axis !== undefined) v[axis]! += 1;
  }
  return v;
}

function embedder() {
  const fake = fakeAi((model, input) => {
    expect(model).toBe(EMBED);
    const texts = (input as { input: string[] }).input;
    return {
      state: "Completed",
      result: { object: "list", data: texts.map((t, index) => ({ object: "embedding", index, embedding: embedding(t) })) },
    };
  });
  const toMarkdown = vi.fn(async () => {
    throw new Error("toMarkdown should not be reached: the text is already in R2");
  });
  return { ...fake, ai: Object.assign(fake.ai, { toMarkdown }) as unknown as Ai, toMarkdown };
}

const ON: AiConsent = { enabled: true, provider: "openai" };

function deps(opts: { consent?: AiConsent; vectors?: Vectorize | null; ai?: Ai; dailyBudgetUsd?: number } = {}) {
  return {
    db,
    bucket: env.MAIL_STORE,
    ai: opts.ai ?? embedder().ai,
    consent: opts.consent ?? ON,
    budget: memoryBudgetStore(),
    dailyBudgetUsd: opts.dailyBudgetUsd ?? 1,
    vectors: opts.vectors === undefined ? fakeVectorize().index : opts.vectors,
  };
}

async function mailbox() {
  return seedMailbox(db, { orgId: id() });
}

async function mail(box: { orgId: string; addressId: string }, subject: string, body: string) {
  const threadId = await seedThread(db, box, { subject });
  const row = messageRow(box, threadId, { subject, searchText: `${subject} sender@ext.test ${body}` });
  await db.insert(messages).values(row);
  return { threadId, messageId: row.id! };
}

async function withAttachmentText(messageId: string, filename: string, text: string) {
  const sha256 = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  await env.MAIL_STORE.put(attachmentTextKey(sha256), text);
  await db.insert(attachments).values({
    id: id(),
    messageId,
    sha256,
    filename,
    detectedType: "application/pdf",
    size: text.length,
    risk: "safe",
  });
}

describe("hybrid search", () => {
  it("skips attachment conversion without removing previously indexed text", async () => {
    const box = await mailbox();
    const previous = `Body text ${ATTACHMENT_MARK} retained.pdf retained attachment reference`;
    const { messageId } = await mail(box, "Retention", "body");
    await db.update(messages).set({ searchText: previous }).where(eq(messages.id, messageId));
    await withAttachmentText(messageId, "new.pdf", "New attachment text should not be added");
    const ai = embedder();
    const result = await indexMessage({ ...deps({ ai: ai.ai, vectors: null }), indexAttachmentText: false }, messageId);
    expect(result).toEqual({ attachments: 0, vectors: { ok: false, reason: "no-index" } });
    expect(ai.toMarkdown).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
    expect((await db.query.messages.findFirst({ where: eq(messages.id, messageId) }))?.searchText).toBe(previous);
  });
  it("finds an attachment by its text", async () => {
    const box = await mailbox();
    const { threadId, messageId } = await mail(box, "Quarterly paperwork", "see the attached file");
    await withAttachmentText(messageId, "po.pdf", "Purchase order ZX9931 covers twelve wind turbines for the north site.");
    await mail(box, "Lunch", "sandwiches at noon");

    expect(await searchThreads(db, { query: "ZX9931", addressIds: [box.addressId] })).toEqual([]);

    const ai = embedder();
    const vec = fakeVectorize();
    const d = deps({ ai: ai.ai, vectors: vec.index });
    expect(await indexMessage(d, messageId)).toEqual({ attachments: 1, vectors: { ok: true, count: 2 } });
    expect(ai.toMarkdown).not.toHaveBeenCalled();
    expect(vec.vectors.get(vectorId(messageId, 0))?.metadata).toEqual({ messageId, threadId, addressId: box.addressId });

    // By keyword: the order number only appears inside the PDF.
    const byKeyword = await hybridSearch(d, { query: "ZX9931", addressIds: [box.addressId] });
    expect(byKeyword.hits[0]).toMatchObject({ threadId, keywordRank: 1 });

    // By meaning: "windmill" is nowhere in the mail or the PDF, only its concept is.
    const byMeaning = await hybridSearch(d, { query: "windmill", addressIds: [box.addressId] });
    expect(byMeaning.mode).toBe("hybrid");
    expect(byMeaning.hits).toEqual([expect.objectContaining({ threadId, keywordRank: null, semanticRank: 1 })]);

    // Reindexing replaces the attachment part instead of appending it again.
    await indexMessage(d, messageId);
    const [row] = await db.select({ searchText: messages.searchText }).from(messages).where(eq(messages.id, messageId));
    expect(row!.searchText!.split("ZX9931")).toHaveLength(2);
    expect(row!.searchText!.split(ATTACHMENT_MARK)).toHaveLength(2);
    expect(row!.searchText).toMatch(/^Quarterly paperwork sender@ext\.test see the attached file /);
  });

  it("falls back to keyword-only when AI is off", async () => {
    const box = await mailbox();
    const a = await mail(box, "Invoice 4411", "invoice for the march payment");
    const b = await mail(box, "Your bill is ready", "billing statement, payment due friday");
    await withAttachmentText(b.messageId, "statement.pdf", "Reference KQ7720");
    const scope = { query: "invoice", addressIds: [box.addressId] };
    const keywordOnly = (await searchThreads(db, scope)).map((h) => h.threadId);
    expect(keywordOnly).toEqual([a.threadId]);

    for (const consent of [
      { enabled: false, provider: null },
      { enabled: false, provider: "openai" },
      // Anthropic has no embedding model.
      { enabled: true, provider: "anthropic" },
    ] satisfies AiConsent[]) {
      const ai = embedder();
      const d = deps({ consent, ai: ai.ai });
      const indexed = await indexMessage(d, b.messageId);
      expect(indexed?.attachments).toBe(1);
      expect(indexed?.vectors.ok).toBe(false);

      const result = await hybridSearch(d, scope);
      expect(result.mode).toBe("keyword");
      expect(result.hits.map((h) => h.threadId)).toEqual(keywordOnly);
      expect(result.hits.every((h) => h.semanticRank === null)).toBe(true);
      // Attachment text is still searchable by keyword.
      expect((await hybridSearch(d, { query: "KQ7720", addressIds: [box.addressId] })).hits.map((h) => h.threadId)).toEqual([b.threadId]);
      expect(ai.run).not.toHaveBeenCalled();
    }

    // No Vectorize binding, a spent budget, or a failing index: still keyword results.
    expect((await hybridSearch(deps({ vectors: null }), scope)).mode).toBe("keyword");
    const spent = deps({ dailyBudgetUsd: 0 });
    expect(await hybridSearch(spent, scope)).toMatchObject({ mode: "keyword", hits: [{ threadId: a.threadId }] });
    const broken = fakeVectorize().index;
    broken.query = async () => {
      throw new Error("vectorize unavailable");
    };
    expect(await hybridSearch(deps({ vectors: broken }), scope)).toMatchObject({ mode: "keyword", hits: [{ threadId: a.threadId }] });
    const garbled = fakeAi(() => ({ state: "Completed", result: { data: [{ embedding: [1, 2] }] } }));
    expect((await hybridSearch(deps({ ai: garbled.ai }), scope)).mode).toBe("keyword");
    expect(garbled.run).toHaveBeenCalledOnce();
  });

  it("fuses keyword and semantic ranks", async () => {
    expect(fuseRanks([["a", "b"], ["b", "c"]])).toEqual([
      { id: "b", score: 1 / (RRF_K + 2) + 1 / (RRF_K + 1), ranks: [2, 1] },
      { id: "a", score: 1 / (RRF_K + 1), ranks: [1, null] },
      { id: "c", score: 1 / (RRF_K + 2), ranks: [null, 2] },
    ]);

    const box = await mailbox();
    const other = await mailbox();
    const both = await mail(box, "Invoice 4411", "invoice for the march payment");
    const meaningOnly = await mail(box, "Your bill is ready", "billing statement, payment due friday");
    const keywordOnly = await mail(box, "Re: the invoice template", "use the new layout");
    const unrelated = await mail(box, "Flight itinerary", "boarding at gate 4");
    const elsewhere = await mail(other, "Payment receipt", "receipt for your payment");

    const vec = fakeVectorize();
    const d = deps({ vectors: vec.index });
    for (const m of [both, meaningOnly, unrelated, elsewhere]) await indexMessage(d, m.messageId);
    // Indexed while the embedding call was refused: keyword only.
    await indexMessage(deps({ vectors: vec.index, consent: { enabled: false, provider: null } }), keywordOnly.messageId);

    const result = await hybridSearch(d, { query: "invoice", addressIds: [box.addressId] });
    expect(result.mode).toBe("hybrid");
    const byThread = new Map(result.hits.map((h) => [h.threadId, h]));
    expect(result.hits[0]!.threadId).toBe(both.threadId);
    expect(byThread.get(both.threadId)).toMatchObject({ keywordRank: expect.any(Number), semanticRank: expect.any(Number) });
    expect(byThread.get(meaningOnly.threadId)).toMatchObject({ keywordRank: null, semanticRank: expect.any(Number) });
    expect(byThread.get(keywordOnly.threadId)).toMatchObject({ keywordRank: expect.any(Number), semanticRank: null });
    expect(byThread.has(unrelated.threadId)).toBe(false);
    // Another mailbox's vector matched the query, but this caller has no grant for it.
    expect(byThread.has(elsewhere.threadId)).toBe(false);
    expect(result.hits).toHaveLength(3);
    for (const h of result.hits) {
      const expected = (h.keywordRank ? 1 / (RRF_K + h.keywordRank) : 0) + (h.semanticRank ? 1 / (RRF_K + h.semanticRank) : 0);
      expect(h.score).toBeCloseTo(expected, 12);
    }

    // The owner (no grant filter) sees the other mailbox's match too.
    const owner = await hybridSearch(d, { query: "invoice", addressIds: null });
    expect(owner.hits.map((h) => h.threadId)).toContain(elsewhere.threadId);
  });
});
