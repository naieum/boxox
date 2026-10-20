import { vi } from "vitest";

/**
 * Workers AI and Vectorize have no local simulator, and tests must never send
 * anything to a real model. These fakes record every call and answer from the
 * script they are given.
 */
export function fakeAi(reply: (model: string, input: unknown) => unknown = () => ({ response: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 } })) {
  const run = vi.fn(async (model: string, input: unknown, _options?: unknown) => reply(model, input));
  return { ai: { run } as unknown as Ai, run };
}

/** An in-memory index with cosine similarity, enough for upsert/query/delete flows. */
export function fakeVectorize() {
  const vectors = new Map<string, VectorizeVector>();
  const cosine = (a: number[], b: number[]) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      na += a[i]! ** 2;
      nb += b[i]! ** 2;
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };
  const matchesFilter = (v: VectorizeVector, filter?: VectorizeVectorMetadataFilter) =>
    !filter || Object.entries(filter).every(([k, want]) => v.metadata?.[k] === want);
  const index = {
    async upsert(list: VectorizeVector[]) {
      for (const v of list) vectors.set(v.id, v);
      return { mutationId: crypto.randomUUID() };
    },
    async insert(list: VectorizeVector[]) {
      return index.upsert(list.filter((v) => !vectors.has(v.id)));
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) vectors.delete(id);
      return { mutationId: crypto.randomUUID() };
    },
    async getByIds(ids: string[]) {
      return ids.flatMap((id) => (vectors.has(id) ? [vectors.get(id)!] : []));
    },
    async query(vector: number[], options: VectorizeQueryOptions = {}) {
      const matches = [...vectors.values()]
        .filter((v) => matchesFilter(v, options.filter))
        .map((v) => ({
          id: v.id,
          score: cosine(vector, [...v.values]),
          ...(options.returnMetadata && options.returnMetadata !== "none" ? { metadata: v.metadata } : {}),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK ?? 5);
      return { matches, count: matches.length };
    },
  };
  return { index: index as unknown as Vectorize, vectors };
}
