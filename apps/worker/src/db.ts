import { drizzle } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import { sql } from "drizzle-orm";
import { schema } from "@boxox/db";
import type { Env } from "./env";

export type Db = ReturnType<typeof createDb>;

export function createDb(env: Pick<Env, "DB">) {
  return drizzle(env.DB, { schema });
}

/**
 * D1 has no interactive transactions (Drizzle's db.transaction() issues BEGIN,
 * which D1 rejects). A batch runs as one implicit transaction: every statement
 * commits or none does. Statements can't read each other's results, so compute
 * ids and values before building the batch.
 */
export async function batch(db: Db, statements: BatchItem<"sqlite">[]) {
  const [first, ...rest] = statements;
  if (!first) return [];
  return db.batch([first, ...rest]);
}

const MAX_QUERY_TERMS = 16;

/**
 * User text → an FTS5 MATCH expression that can't be a syntax error: every
 * letter/number run becomes a quoted prefix term, all of them required.
 * Returns null when there is nothing to search for.
 */
export function ftsQuery(input: string): string | null {
  const terms = input.match(/[\p{L}\p{N}]+/gu)?.slice(0, MAX_QUERY_TERMS) ?? [];
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" ");
}

export interface SearchHit {
  threadId: string;
  rank: number;
}

/**
 * Keyword search over threads_fts, best match first. bm25 weights subject
 * over participants over body; a thread ranks by its best message.
 * `addressIds` is the caller's grant set — null only for the owner.
 */
export async function searchThreads(
  db: Db,
  opts: { query: string; addressIds: string[] | null; limit?: number; orgId?: string },
): Promise<SearchHit[]> {
  const match = ftsQuery(opts.query);
  if (!match || opts.addressIds?.length === 0) return [];
  const scope = opts.addressIds
    ? sql`AND t.address_id IN (${sql.join(
        opts.addressIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const orgScope = opts.orgId ? sql`AND t.organization_id = ${opts.orgId}` : sql``;
  // bm25() can't run inside an aggregate, so score in a materialized CTE first.
  return db.all<SearchHit>(sql`
    WITH hits AS MATERIALIZED (
      SELECT threads_fts.thread_id AS thread_id, bm25(threads_fts, 0.0, 3.0, 2.0, 1.0) AS score
      FROM threads_fts JOIN threads t ON t.id = threads_fts.thread_id
      WHERE threads_fts MATCH ${match} ${scope} ${orgScope}
    )
    SELECT thread_id AS threadId, min(score) AS rank
    FROM hits
    GROUP BY thread_id
    ORDER BY rank
    LIMIT ${opts.limit ?? 50}
  `);
}
