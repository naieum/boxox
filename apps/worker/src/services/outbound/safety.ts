import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { appSettings, domains, messageEvents, operationalEvents, suppressions } from "@boxox/db";
import type { Db } from "../../db";
import { log } from "../../log";

/**
 * Sender-reputation guards. Cloudflare can suspend sending for the whole
 * account when bounces or complaints climb, so hard-bounced and complaining
 * recipients are suppressed, and a circuit breaker pauses all sending once the
 * recent bounce or complaint rate crosses a threshold.
 */

export const BREAKER_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Below this many delivery outcomes in the window, one bounce can't trip the breaker. */
export const BREAKER_MIN_SAMPLE = 20;
export const BOUNCE_RATE_THRESHOLD = 0.05;
export const COMPLAINT_RATE_THRESHOLD = 0.01;

const OUTCOMES = ["delivered", "bounced", "complained", "failed"] as const;

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

async function domainIdFor(db: Db, email: string): Promise<string | null> {
  const row = await db
    .select({ id: domains.id })
    .from(domains)
    .where(eq(domains.name, domainOf(email)))
    .limit(1);
  return row[0]?.id ?? null;
}

/** The subset of `recipients` suppressed for the sending address's domain. */
export async function suppressedRecipients(db: Db, from: string, recipients: string[]): Promise<Set<string>> {
  const lowered = [...new Set(recipients.map((r) => r.toLowerCase()))];
  const domainId = await domainIdFor(db, from);
  if (!domainId || !lowered.length) return new Set();
  const rows = await db
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(and(eq(suppressions.domainId, domainId), inArray(suppressions.email, lowered)));
  return new Set(rows.map((r) => r.email));
}

export async function suppress(
  db: Db,
  input: { from: string; recipient: string; reason: "bounce" | "complaint"; detail?: string },
): Promise<boolean> {
  const domainId = await domainIdFor(db, input.from);
  if (!domainId) return false;
  await db
    .insert(suppressions)
    .values({
      id: crypto.randomUUID(),
      domainId,
      email: input.recipient.toLowerCase(),
      reason: input.reason,
      detail: input.detail?.slice(0, 300) ?? null,
    })
    .onConflictDoNothing();
  return true;
}

export async function sendingPause(db: Db): Promise<{ since: Date; reason: string | null } | null> {
  const row = await db
    .select({ at: appSettings.sendingPausedAt, reason: appSettings.sendingPausedReason })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);
  return row[0]?.at ? { since: row[0].at, reason: row[0].reason } : null;
}

export interface BreakerRates {
  total: number;
  bounceRate: number;
  complaintRate: number;
}

export async function recentRates(db: Db, now: number): Promise<BreakerRates> {
  const rows = await db
    .select({ type: messageEvents.type, n: sql<number>`count(*)` })
    .from(messageEvents)
    .where(
      and(
        inArray(messageEvents.type, [...OUTCOMES]),
        gte(messageEvents.occurredAt, new Date(now - BREAKER_WINDOW_MS)),
      ),
    )
    .groupBy(messageEvents.type);
  const count = (t: string) => Number(rows.find((r) => r.type === t)?.n ?? 0);
  const total = rows.reduce((n, r) => n + Number(r.n), 0);
  return {
    total,
    bounceRate: total ? count("bounced") / total : 0,
    complaintRate: total ? count("complained") / total : 0,
  };
}

/**
 * Pause all sending when the recent bounce or complaint rate is over its
 * threshold. Only the owner un-pauses; the breaker never closes on its own.
 */
export async function evaluateBreaker(db: Db, now = Date.now()): Promise<{ tripped: boolean; rates: BreakerRates }> {
  const rates = await recentRates(db, now);
  if (rates.total < BREAKER_MIN_SAMPLE) return { tripped: false, rates };
  const reason =
    rates.bounceRate >= BOUNCE_RATE_THRESHOLD
      ? `Bounce rate ${(rates.bounceRate * 100).toFixed(1)}% over the last 7 days (limit ${BOUNCE_RATE_THRESHOLD * 100}%)`
      : rates.complaintRate >= COMPLAINT_RATE_THRESHOLD
        ? `Complaint rate ${(rates.complaintRate * 100).toFixed(1)}% over the last 7 days (limit ${COMPLAINT_RATE_THRESHOLD * 100}%)`
        : null;
  if (!reason) return { tripped: false, rates };
  if (await sendingPause(db)) return { tripped: true, rates };

  const at = new Date(now);
  await db
    .insert(appSettings)
    .values({ id: 1, sendingPausedAt: at, sendingPausedReason: reason, updatedAt: at })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { sendingPausedAt: at, sendingPausedReason: reason, updatedAt: at },
      setWhere: sql`${appSettings.sendingPausedAt} IS NULL`,
    });
  // The owner alert: shown on the Domains page and in operational logs.
  await db.insert(operationalEvents).values({
    id: crypto.randomUUID(),
    organizationId: "owner",
    kind: "sending_paused",
    level: "error",
    detail: { reason, ...rates },
  });
  log.error("sending_paused", { reason, ...rates });
  return { tripped: true, rates };
}
