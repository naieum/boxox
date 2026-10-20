/**
 * Reciprocal-rank fusion: each list contributes 1 / (k + rank) for every id it
 * holds, rank counted from 1. Scores from bm25 and cosine similarity aren't
 * comparable, ranks are, and k = 60 keeps one list's top hit from drowning out
 * agreement between both lists.
 */
export const RRF_K = 60;

export interface FusedHit {
  id: string;
  score: number;
  /** 1-based rank in each input list; null where the list didn't hold the id. */
  ranks: (number | null)[];
}

export function fuseRanks(lists: readonly (readonly string[])[], k = RRF_K): FusedHit[] {
  const hits = new Map<string, FusedHit>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      const hit = hits.get(id) ?? { id, score: 0, ranks: lists.map(() => null) };
      hit.score += 1 / (k + i + 1);
      hit.ranks[li] = i + 1;
      hits.set(id, hit);
    });
  });
  // Ties keep first-seen order, which favours the earlier (keyword) list.
  return [...hits.values()].sort((a, b) => b.score - a.score);
}
