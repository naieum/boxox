import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { aiSettings, messages } from "@boxox/db";
import { createDb, searchThreads } from "../src/db";
import { indexStoredMessage } from "../src/services/search/runtime";
import { fakeAi, fakeVectorize } from "./helpers/ai";
import { id, messageRow, seedMailbox, seedThread } from "./helpers/seed";

describe("workflow search indexing", () => {
  it("keeps stored mail keyword-searchable when Vectorize fails", async () => {
    const db = createDb(env);
    await db.insert(aiSettings).values({ id: 1, ai: true, provider: "openai", dailyBudgetMicros: 1_000_000 });
    const box = await seedMailbox(db, { orgId: id() });
    const threadId = await seedThread(db, box, { subject: "Invoice" });
    const row = messageRow(box, threadId, { subject: "Invoice", searchText: "Invoice verification ZX9931" });
    await db.insert(messages).values(row);
    const ai = fakeAi(() => ({ data: [{ embedding: new Array(1536).fill(1) }] }));
    const vectors = fakeVectorize().index;
    vectors.upsert = async () => { throw new Error("unavailable"); };
    const result = await indexStoredMessage({ ...env, AI: ai.ai, VECTORS: vectors }, row.id!);
    expect(result).toMatchObject({ error: "indexing-unavailable" });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(await searchThreads(db, { query: "ZX9931", addressIds: [box.addressId] })).toEqual([expect.objectContaining({ threadId })]);
  });
});
