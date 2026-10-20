/**
 * Daily AI spend, in estimated USD, keyed by UTC day. Once the cap is reached
 * the wrapper refuses further calls and callers fall back to the non-AI checks.
 * The AI Gateway spend limit (same figure) is the hard backstop; this is the
 * app-side cap, so a slightly racy KV counter is acceptable.
 */

export interface BudgetStore {
  spent(day: string): Promise<number>;
  add(day: string, usd: number): Promise<void>;
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

const DAY_TTL_SECONDS = 3 * 24 * 3600;

export function kvBudgetStore(kv: KVNamespace, prefix = "ai-spend:"): BudgetStore {
  return {
    async spent(day) {
      return Number((await kv.get(prefix + day)) ?? 0) || 0;
    },
    async add(day, usd) {
      if (usd <= 0) return;
      const total = (await this.spent(day)) + usd;
      await kv.put(prefix + day, String(total), { expirationTtl: DAY_TTL_SECONDS });
    },
  };
}

export function memoryBudgetStore(): BudgetStore {
  const days = new Map<string, number>();
  return {
    async spent(day) {
      return days.get(day) ?? 0;
    },
    async add(day, usd) {
      days.set(day, (days.get(day) ?? 0) + usd);
    },
  };
}
