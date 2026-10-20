import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { addresses, threads } from "@boxox/db";
import { searchThreads, type Db } from "../../db";
import type { AiDeps } from "../ai";
import { embedTexts } from "./embed";
import { fuseRanks } from "./fuse";

/** Candidates taken from each list before fusing. */
export const CANDIDATES = 50;
/**
 * Vectorize always returns its topK, however unrelated. Below this cosine
 * similarity a match is noise for text-embedding-3-small and is dropped.
 */
export const MIN_SIMILARITY = 0.3;

export interface HybridDeps extends AiDeps {
  db: Db;
  vectors?: Vectorize | null;
  model?: string | null;
}

export interface HybridHit {
  threadId: string;
  score: number;
  keywordRank: number | null;
  semanticRank: number | null;
}

export interface HybridResult {
  /** "keyword" when AI is off, has no embedding model, or the semantic half failed. */
  mode: "hybrid" | "keyword";
  hits: HybridHit[];
}

/**
 * FTS5 keyword hits and Vectorize semantic hits, merged by reciprocal-rank
 * fusion. `addressIds` is the caller's grant set, null only for the owner;
 * semantic hits are re-checked against D1 so stale vectors and other people's
 * mailboxes never surface.
 */
export async function hybridSearch(
  deps: HybridDeps,
  opts: { query: string; addressIds: string[] | null; limit?: number; orgId?: string },
): Promise<HybridResult> {
  if (!opts.query.trim() || opts.addressIds?.length === 0) return { mode: "keyword", hits: [] };
  const [keyword, semantic] = await Promise.all([
    searchThreads(deps.db, { query: opts.query, addressIds: opts.addressIds, limit: CANDIDATES, orgId: opts.orgId }),
    semanticThreads(deps, opts.query, opts.addressIds, opts.orgId),
  ]);
  const fused = fuseRanks([keyword.map((h) => h.threadId), semantic ?? []]);
  return {
    mode: semantic ? "hybrid" : "keyword",
    hits: fused.slice(0, opts.limit ?? CANDIDATES).map((h) => ({
      threadId: h.id,
      score: h.score,
      keywordRank: h.ranks[0] ?? null,
      semanticRank: h.ranks[1] ?? null,
    })),
  };
}

/** Thread ids by meaning, best first; null when semantic search can't run. */
async function semanticThreads(deps: HybridDeps, query: string, addressIds: string[] | null, orgId?: string): Promise<string[] | null> {
  if (!deps.vectors) return null;
  const embedded = await embedTexts(deps, [query], { feature: "search-query" });
  if (!embedded.ok) return null;
  let matches: VectorizeMatch[];
  try {
    ({ matches } = await deps.vectors.query(embedded.vectors[0]!, { topK: CANDIDATES, returnMetadata: "all" }));
  } catch {
    return null;
  }
  const ordered: string[] = [];
  for (const m of matches) {
    const threadId = m.metadata?.threadId;
    if (m.score < MIN_SIMILARITY || typeof threadId !== "string" || ordered.includes(threadId)) continue;
    ordered.push(threadId);
  }
  if (!ordered.length) return [];

  const live = await deps.db
    .select({ id: threads.id })
    .from(threads)
    .leftJoin(addresses, eq(addresses.id, threads.addressId))
    .where(and(
      inArray(threads.id, ordered),
      addressIds ? inArray(threads.addressId, addressIds) : undefined,
      orgId ? eq(threads.organizationId, orgId) : undefined,
      or(isNull(threads.addressId), eq(addresses.aiOptOut, false)),
    ));
  const allowed = new Set(live.map((t) => t.id));
  return ordered.filter((id) => allowed.has(id));
}
