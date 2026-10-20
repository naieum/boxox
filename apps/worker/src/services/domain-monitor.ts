import { eq } from "drizzle-orm";
import { aiSettings, domains } from "@boxox/db";
import type { Db } from "../db";
import type { Env } from "../env";
import { checkDomainHealth, type DomainHealth } from "./domain-health";
import { checkSpamhaus } from "./spam/signals-lookup";

type Domain = typeof domains.$inferSelect;

export function healthProblems(health: DomainHealth): string[] {
  return [...health.checks.filter(c => c.required && c.status !== "ok").map(c => c.name),
    ...((health.reputation?.status === "listed" || health.reputation?.lastKnown === "listed") ? ["reputation"] : [])].sort();
}

/** Checks only owned domains. Reputation queries use the owner's existing opt-in and DQS key. */
export async function monitorDomain(db: Db, env: Pick<Env, "SPAMHAUS_DQS_KEY">, domain: Domain,
  fetcher: typeof fetch, sending?: { selector?: string; returnPath?: string }): Promise<DomainHealth> {
  const previous = domain.health as unknown as DomainHealth | null;
  const saved = previous?.checks ?? [];
  const health = await checkDomainHealth(domain.name, {
    selector: sending?.selector ?? saved.find(c => c.name === "dkim")?.host.split("._domainkey.")[0],
    returnPath: sending?.returnPath ?? saved.find(c => c.name === "spf")?.host,
    receiving: domain.receivingEnabled, sending: domain.sendingEnabled, bimi: domain.sendingEnabled,
  }, fetcher);
  const settings = await db.query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) });
  const lastKnown = previous?.reputation?.lastKnown ?? (["clear", "listed"].includes(previous?.reputation?.status ?? "") ? previous!.reputation!.status as "clear" | "listed" : undefined);
  health.reputation = { status: "off", lastKnown, detail: "Enable reputation lookups and configure your Spamhaus DQS key for sender-domain checks." };
  if (settings?.reputationLookups && env.SPAMHAUS_DQS_KEY && domain.sendingEnabled) {
    const result = await checkSpamhaus({ key: env.SPAMHAUS_DQS_KEY, ip: null, domains: [domain.name] },
      (input, init) => fetcher(input, init));
    health.reputation = result.errors.length
      ? { status: "unknown", lastKnown, detail: "Spamhaus lookup unavailable. No clean result or listing inferred." }
      : { status: result.signals.length ? "listed" : "clear", lastKnown: result.signals.length ? "listed" : "clear", detail: result.signals.length ? "Sending domain appears on Spamhaus DBL. Review the listing with Spamhaus." : "No Spamhaus DBL listing returned at this check." };
  }
  const problems = healthProblems(health);
  const before = previous?.checks ? healthProblems(previous) : [];
  health.alerts = previous?.alerts?.slice(0, 4) ?? [];
  if (JSON.stringify(problems) !== JSON.stringify(before)) {
    health.alerts.unshift({ at: health.checkedAt, kind: problems.length ? "problem" : "recovered", checks: problems.length ? problems : before });
    health.alerts = health.alerts.slice(0, 5);
  }
  await db.update(domains).set({ health: { ...health }, healthCheckedAt: new Date(health.checkedAt) }).where(eq(domains.id, domain.id));
  return health;
}
