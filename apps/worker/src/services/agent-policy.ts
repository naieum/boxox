import { and, eq, gt, sql, type SQL } from "drizzle-orm";
import { agents, appSettings, auditEvents, messages, threads } from "@boxox/db";
import type { AuditAction } from "@boxox/shared";
import { writeAudit } from "../audit";
import type { Db } from "../db";

/**
 * Agent policy (docs/v2-plan.md, "Compromised or over-eager agent"): the
 * install-wide kill switch, per-agent send caps, what an agent may see, and the
 * audit trail every agent action writes.
 */

/** Install defaults when an agent's own cap is null. */
export const DEFAULT_SEND_CAPS = { hourly: 20, daily: 100 } as const;

/** A classifier `prompt_injection` score at or above this hides the message's thread. */
export const PROMPT_INJECTION_THRESHOLD = 0.5;

export async function agentsKilled(db: Db): Promise<boolean> {
  const row = await db
    .select({ disabled: appSettings.agentsDisabled })
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);
  return row[0]?.disabled === true;
}

export async function setAgentsKilled(db: Db, disabled: boolean): Promise<void> {
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ id: 1, agentsDisabled: disabled, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.id, set: { agentsDisabled: disabled, updatedAt: now } });
}

/** SQL truth for "this message was flagged as a prompt injection" (top-level or under `ai`). */
export function promptInjectionFlagged(): SQL {
  return sql`(coalesce(json_extract(${messages.spamVerdict}, '$.prompt_injection'), json_extract(${messages.spamVerdict}, '$.ai.prompt_injection'), 0) >= ${PROMPT_INJECTION_THRESHOLD})`;
}

/**
 * Threads an agent without `classify` may see: not in Spam or Quarantine, and
 * no message in them flagged as a prompt injection.
 */
export function visibleWithoutClassify(): SQL {
  return sql`(${threads.folder} NOT IN ('spam', 'quarantine') AND NOT EXISTS (
    SELECT 1 FROM ${messages} WHERE ${messages.threadId} = ${threads.id} AND ${promptInjectionFlagged()}
  ))`;
}

export async function threadVisibleWithoutClassify(db: Db, threadId: string): Promise<boolean> {
  const row = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, threadId), visibleWithoutClassify()))
    .limit(1);
  return row.length > 0;
}

export interface SendCapCheck {
  allowed: boolean;
  window?: "hourly" | "daily";
  limit?: number;
}

/** Sends counted from the agent's own `agent.message_sent` audit rows. */
export async function checkAgentSendCaps(db: Db, agentId: string, now = Date.now()): Promise<SendCapCheck> {
  const row = await db
    .select({ hourly: agents.sendHourlyCap, daily: agents.sendDailyCap })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const hourly = row[0]?.hourly ?? DEFAULT_SEND_CAPS.hourly;
  const daily = row[0]?.daily ?? DEFAULT_SEND_CAPS.daily;

  const sentSince = async (ms: number) => {
    const r = await db
      .select({ n: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorType, "agent"),
          eq(auditEvents.actorId, agentId),
          eq(auditEvents.action, "agent.message_sent"),
          gt(auditEvents.createdAt, new Date(now - ms)),
        ),
      );
    return Number(r[0]?.n ?? 0);
  };

  if ((await sentSince(60 * 60 * 1000)) >= hourly) return { allowed: false, window: "hourly", limit: hourly };
  if ((await sentSince(24 * 60 * 60 * 1000)) >= daily) return { allowed: false, window: "daily", limit: daily };
  return { allowed: true };
}

/** Every agent action, allowed or refused, lands in the audit log. Never pass bodies. */
export async function auditAgent(
  db: Db,
  agent: { id: string; organizationId: string },
  action: AuditAction,
  target?: { type: string; id: string },
  metadata?: Record<string, unknown>,
): Promise<void> {
  await writeAudit(db, {
    organizationId: agent.organizationId,
    actorType: "agent",
    actorId: agent.id,
    action,
    targetType: target?.type,
    targetId: target?.id,
    metadata,
  });
}
