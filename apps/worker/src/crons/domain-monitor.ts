import { and, asc, eq, or } from "drizzle-orm";
import { domains } from "@boxox/db";
import { createDb } from "../db";
import type { Env } from "../env";
import { log } from "../log";
import { monitorDomain } from "../services/domain-monitor";

export const DOMAIN_MONITOR_CRON = "15 * * * *";
/** Oldest first, five domains per hour: bounded DNS work and eventual coverage for larger installs. */
export async function monitorDomains(env: Pick<Env, "DB" | "SPAMHAUS_DQS_KEY">, fetcher: typeof fetch = fetch): Promise<number> {
  const db = createDb(env);
  const rows = await db.select().from(domains).where(and(eq(domains.active, true),
    or(eq(domains.sendingEnabled, true), eq(domains.receivingEnabled, true))))
    .orderBy(asc(domains.healthCheckedAt), asc(domains.id)).limit(5);
  for (const domain of rows) {
    try { await monitorDomain(db, env, domain, fetcher); }
    catch { log.warn("domain_monitor_failed", { domainId: domain.id }); }
  }
  return rows.length;
}
