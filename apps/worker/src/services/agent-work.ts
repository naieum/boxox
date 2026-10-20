import { and, eq, sql, type SQL } from "drizzle-orm";
import { messages, threads } from "@boxox/db";
import type { Db } from "../db";
import { AgentError, hasPermission, type AgentGrant, type AgentPrincipal } from "../routes/agent-api";
import { auditAgent, visibleWithoutClassify } from "./agent-policy";

type Principal = Pick<AgentPrincipal, "id" | "organizationId">;
export interface WorkOptions { group?: string; leaseSeconds?: number }
export interface WorkReceipt { messageId: string; group: string | null; claimToken: string; leaseUntil: string; attempts: number }
export interface WorkReference { messageId: string; claimToken: string; group?: string }
interface WorkRow { messageId: string; ownerAgentId: string; claimToken: string; state: string; leaseUntil: number; attempts: number }

export const MAX_WORK_BATCH = 10;
function invalid(message: string): never { throw new AgentError(400, "bad_request", message); }
function consumer(agent: Principal, group?: string): string {
  if (group === undefined) return `agent:${agent.id}`;
  if (typeof group !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(group)) invalid("group must be 1–64 letters, digits, dots, underscores or hyphens");
  return `group:${group}`;
}
function seconds(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) invalid(`Duration must be an integer between 1 and ${max} seconds`);
  return n;
}
function requireRead(grants: AgentGrant[], addressId: string) {
  if (!hasPermission(grants, addressId, "read")) throw new AgentError(403, "forbidden", "Missing 'read' permission on this mailbox");
}
function threadReady(): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM messages pending_scan WHERE pending_scan.thread_id = ${threads.id}
    AND pending_scan.direction = 'inbound' AND pending_scan.scan_status = 'pending')`;
}
function visible(agent: Principal, grants: AgentGrant[], addressId: string): SQL {
  return and(eq(messages.organizationId, agent.organizationId), eq(messages.addressId, addressId), eq(messages.direction, "inbound"), threadReady(),
    eq(threads.organizationId, agent.organizationId), eq(threads.addressId, addressId), sql`${threads.folder} != 'trash'`,
    hasPermission(grants, addressId, "classify") ? undefined : visibleWithoutClassify())!;
}
async function loadMessage(db: Db, agent: Principal, grants: AgentGrant[], messageId: string) {
  if (typeof messageId !== "string" || !messageId || messageId.length > 128) invalid("Invalid messageId");
  // One metadata query also evaluates thread visibility; no body/R2 fetch is needed.
  const [row] = await db.select({ addressId: messages.addressId, direction: messages.direction, folder: threads.folder, scanStatus: messages.scanStatus,
    ready: sql<number>`CASE WHEN ${threadReady()} THEN 1 ELSE 0 END`,
    safe: sql<number>`CASE WHEN ${visibleWithoutClassify()} THEN 1 ELSE 0 END` })
    .from(messages).innerJoin(threads, eq(messages.threadId, threads.id))
    .where(and(eq(messages.id, messageId), eq(messages.organizationId, agent.organizationId), eq(threads.organizationId, agent.organizationId),
      eq(threads.addressId, messages.addressId))).limit(1);
  if (!row?.addressId) throw new AgentError(404, "not_found", "No such message");
  requireRead(grants, row.addressId);
  if (row.ready !== 1 || row.scanStatus === "pending" || row.direction !== "inbound" || row.folder === "trash" || (!hasPermission(grants, row.addressId, "classify") && row.safe !== 1)) {
    throw new AgentError(404, "not_found", "No such message");
  }
  return row.addressId;
}
function receipt(row: WorkRow, group?: string): WorkReceipt {
  return { messageId: row.messageId, group: group ?? null, claimToken: row.claimToken, leaseUntil: new Date(row.leaseUntil).toISOString(), attempts: row.attempts };
}

/** Claim one inbound message. Sharing a group coordinates different agents; omitted group is private to this agent. */
export async function claimAgentWork(db: Db, agent: Principal, grants: AgentGrant[], input: WorkOptions & { messageId: string }): Promise<WorkReceipt> {
  const key = consumer(agent, input.group);
  const lease = seconds(input.leaseSeconds, 300, 3600);
  const addressId = await loadMessage(db, agent, grants, input.messageId);
  const now = Date.now();
  const token = crypto.randomUUID() + crypto.randomUUID();
  const [row] = await db.all<WorkRow>(sql`
    INSERT INTO agent_work (organization_id, consumer_key, message_id, address_id, state, owner_agent_id, claim_token, lease_until, available_at, attempts, updated_at)
    VALUES (${agent.organizationId}, ${key}, ${input.messageId}, ${addressId}, 'leased', ${agent.id}, ${token}, ${now + lease * 1000}, 0, 1, ${now})
    ON CONFLICT (organization_id, consumer_key, message_id) DO UPDATE SET
      state = 'leased', owner_agent_id = excluded.owner_agent_id, claim_token = excluded.claim_token,
      lease_until = excluded.lease_until, available_at = 0, attempts = agent_work.attempts + 1, updated_at = excluded.updated_at
    WHERE agent_work.state != 'completed' AND agent_work.lease_until <= ${now} AND agent_work.available_at <= ${now}
    RETURNING message_id AS messageId, owner_agent_id AS ownerAgentId, claim_token AS claimToken, state, lease_until AS leaseUntil, attempts
  `);
  if (!row) throw new AgentError(409, "work_unavailable", "Message is already claimed, completed or waiting to retry for this consumer");
  await auditAgent(db, agent, "agent.work_claimed", { type: "message", id: input.messageId }, { group: input.group ?? null, attempts: row.attempts });
  return receipt(row, input.group);
}

/** Complete is idempotent for the same owner and claim token; a stale/replaced/expired lease cannot acknowledge work. */
export async function completeAgentWork(db: Db, agent: Principal, grants: AgentGrant[], input: WorkReference): Promise<{ messageId: string; completed: true }> {
  const key = consumer(agent, input.group);
  await loadMessage(db, agent, grants, input.messageId);
  if (typeof input.claimToken !== "string" || !input.claimToken || input.claimToken.length > 256) invalid("Invalid claimToken");
  const now = Date.now();
  const rows = await db.all<{ messageId: string }>(sql`UPDATE agent_work SET state = 'completed', completed_at = COALESCE(completed_at, ${now}), updated_at = ${now}
    WHERE organization_id = ${agent.organizationId} AND consumer_key = ${key} AND message_id = ${input.messageId}
      AND owner_agent_id = ${agent.id} AND claim_token = ${input.claimToken}
      AND (state = 'completed' OR (state = 'leased' AND lease_until > ${now}))
    RETURNING message_id AS messageId`);
  if (!rows.length) throw new AgentError(409, "claim_lost", "Claim expired, was replaced or does not belong to this agent");
  await auditAgent(db, agent, "agent.work_completed", { type: "message", id: input.messageId }, { group: input.group ?? null });
  return { messageId: input.messageId, completed: true };
}

export async function renewAgentWork(db: Db, agent: Principal, grants: AgentGrant[], input: WorkReference & { leaseSeconds?: number }): Promise<WorkReceipt> {
  const key = consumer(agent, input.group);
  const lease = seconds(input.leaseSeconds, 300, 3600);
  await loadMessage(db, agent, grants, input.messageId);
  if (typeof input.claimToken !== "string" || !input.claimToken || input.claimToken.length > 256) invalid("Invalid claimToken");
  const now = Date.now();
  const [row] = await db.all<WorkRow>(sql`UPDATE agent_work SET lease_until = ${now + lease * 1000}, updated_at = ${now}
    WHERE organization_id = ${agent.organizationId} AND consumer_key = ${key} AND message_id = ${input.messageId}
      AND owner_agent_id = ${agent.id} AND claim_token = ${input.claimToken} AND state = 'leased' AND lease_until > ${now}
    RETURNING message_id AS messageId, owner_agent_id AS ownerAgentId, claim_token AS claimToken, state, lease_until AS leaseUntil, attempts`);
  if (!row) throw new AgentError(409, "claim_lost", "Claim expired, was replaced or does not belong to this agent");
  await auditAgent(db, agent, "agent.work_renewed", { type: "message", id: input.messageId }, { group: input.group ?? null });
  return receipt(row, input.group);
}

export async function retryAgentWork(db: Db, agent: Principal, grants: AgentGrant[], input: WorkReference & { delaySeconds?: number }): Promise<{ messageId: string; availableAt: string }> {
  const key = consumer(agent, input.group);
  const delay = input.delaySeconds === 0 ? 0 : seconds(input.delaySeconds, 30, 86400);
  await loadMessage(db, agent, grants, input.messageId);
  if (typeof input.claimToken !== "string" || !input.claimToken || input.claimToken.length > 256) invalid("Invalid claimToken");
  const now = Date.now(); const availableAt = now + delay * 1000;
  const rows = await db.all(sql`UPDATE agent_work SET state = 'pending', lease_until = 0, available_at = ${availableAt}, updated_at = ${now}
    WHERE organization_id = ${agent.organizationId} AND consumer_key = ${key} AND message_id = ${input.messageId}
      AND owner_agent_id = ${agent.id} AND claim_token = ${input.claimToken} AND state = 'leased' AND lease_until > ${now}
    RETURNING message_id`);
  if (!rows.length) throw new AgentError(409, "claim_lost", "Claim expired, was replaced or does not belong to this agent");
  await auditAgent(db, agent, "agent.work_retried", { type: "message", id: input.messageId }, { group: input.group ?? null, delaySeconds: delay });
  return { messageId: input.messageId, availableAt: new Date(availableAt).toISOString() };
}

/** Bounded partial-success acknowledgment: callers may retry the same batch after a disconnect. */
export async function completeAgentWorkBatch(db: Db, agent: Principal, grants: AgentGrant[], items: WorkReference[]) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_WORK_BATCH || items.some((item) => !item || typeof item !== "object")) invalid(`items must contain 1–${MAX_WORK_BATCH} claims`);
  const results: { messageId: string; completed?: true; error?: { code: string; message: string } }[] = [];
  for (const item of items) {
    try { results.push(await completeAgentWork(db, agent, grants, item)); }
    catch (error) {
      if (!(error instanceof AgentError)) throw error;
      results.push({ messageId: item.messageId, error: { code: error.code, message: error.message } });
    }
  }
  return { results };
}

export async function listAgentWork(db: Db, agent: Principal, grants: AgentGrant[], addressId: string, opts: { group?: string; limit?: number; cursor?: string } = {}) {
  requireRead(grants, addressId);
  const key = consumer(agent, opts.group);
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit must be 1–100");
  let boundary: SQL | undefined;
  if (opts.cursor !== undefined) {
    try {
      if (typeof opts.cursor !== "string" || opts.cursor.length > 512) throw new Error();
      const parsed = JSON.parse(atob(opts.cursor)) as { at: number; id: string };
      if (!Number.isInteger(parsed.at) || typeof parsed.id !== "string" || !parsed.id || parsed.id.length > 128) throw new Error();
      boundary = sql`(${messages.occurredAt} > ${parsed.at} OR (${messages.occurredAt} = ${parsed.at} AND ${messages.id} > ${parsed.id}))`;
    } catch { invalid("Invalid work cursor"); }
  }
  const now = Date.now();
  const rows = await db.select({ messageId: messages.id, threadId: messages.threadId, subject: messages.subject, snippet: messages.snippet, occurredAt: messages.occurredAt })
    .from(messages).innerJoin(threads, eq(messages.threadId, threads.id))
    .where(and(visible(agent, grants, addressId), boundary, sql`NOT EXISTS (SELECT 1 FROM agent_work w WHERE w.organization_id = ${agent.organizationId}
      AND w.consumer_key = ${key} AND w.message_id = ${messages.id} AND (w.state = 'completed' OR w.lease_until > ${now} OR w.available_at > ${now}))`))
    .orderBy(messages.occurredAt, messages.id).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? btoa(JSON.stringify({ at: last.occurredAt.getTime(), id: last.messageId })) : null;
  await auditAgent(db, agent, "agent.work_listed", { type: "address", id: addressId }, { group: opts.group ?? null, count: page.length });
  return { messages: page.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() })), nextCursor };
}
