import { sql } from "drizzle-orm";
import type { Db } from "../db";

/**
 * D1-backed fixed-window rate limiter for the public agent endpoints (/pair,
 * /token) and the per-org send budget. The window is advanced atomically inside a single
 * upsert so concurrent requests can't race the counter:
 *
 *   - fresh key            → insert count=1, window_start=now
 *   - existing, in-window  → count = count + 1 (window_start unchanged)
 *   - existing, expired    → count = 1, window_start = now  (window rolls over)
 *
 * Returns the post-increment count; the caller compares against its budget.
 */

const WINDOW_MS = 15 * 60 * 1000;

/** Fixed-window budgets (per 15 minutes), keyed by endpoint + principal. */
export const RATE_LIMITS = {
  /** POST /api/agent/pair, keyed by client IP. */
  pairPerIp: 10,
  /** POST /api/agent/token, keyed by client IP. */
  tokenPerIp: 60,
  /** POST /api/agent/token, keyed by client_id. */
  tokenPerClient: 30,
  /** Outbound sends per org (human + agent), keyed by org id. Abuse backstop, not a billing cap. */
  sendPerOrg: 200,
} as const;

export const RATE_WINDOW_MS = WINDOW_MS;

/**
 * Record one hit against `key` and report whether it is still within `limit`.
 * `windowMs` defaults to the 15-minute fixed window.
 */
export async function rateLimitHit(
  db: Db,
  key: string,
  limit: number,
  windowMs = WINDOW_MS,
): Promise<{ allowed: boolean; count: number }> {
  const now = Date.now();
  const threshold = now - windowMs;
  const row = await db.get<{ count: number }>(sql`
    INSERT INTO agent_rate_hits (key, count, window_start)
    VALUES (${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN agent_rate_hits.window_start > ${threshold}
                   THEN agent_rate_hits.count + 1 ELSE 1 END,
      window_start = CASE WHEN agent_rate_hits.window_start > ${threshold}
                          THEN agent_rate_hits.window_start ELSE ${now} END
    RETURNING count
  `);
  const count = Number(row?.count ?? 0);
  return { allowed: count <= limit, count };
}

/** Owner-controlled installation throughput; per-agent caps remain independently enforced. */
export function organizationSendLimit(env: { AGENT_SEND_LIMIT_PER_15_MIN?: string }): number {
  const raw = env.AGENT_SEND_LIMIT_PER_15_MIN;
  if (!raw) return RATE_LIMITS.sendPerOrg;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 100_000 ? value : RATE_LIMITS.sendPerOrg;
}
