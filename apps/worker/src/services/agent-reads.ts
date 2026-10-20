import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { messages, threads } from "@boxox/db";
import type { Db } from "../db";
import type { Env } from "../env";
import type { AgentGrant, AgentMessage, AgentPrincipal, ThreadSummary } from "../routes/agent-api";
import { auditAgent, visibleWithoutClassify } from "./agent-policy";

type Principal = Pick<AgentPrincipal, "id" | "organizationId">;
export class AgentReadError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "AgentReadError";
  }
}
export interface AgentPageOptions { limit?: number; cursor?: string }
export interface AgentMessageOptions extends AgentPageOptions { includeBody?: boolean }
export interface AgentMessageMetadata extends AgentMessage { bodyTruncated: boolean; bodyUnavailable?: "too_large" | "missing" | "unreadable" }
const MAX_BODY_CHARS = 32_768;
const MAX_BODY_OBJECT_BYTES = 2 * 1024 * 1024;
const permission = (grants: AgentGrant[], addressId: string, name: string) => grants.some(g => g.addressId === addressId && g.permissions.includes(name));
/** Pending mail has not passed local safety checks. Even classify cannot read it. */
function readyForAgents() {
  return sql`NOT EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.threadId} = ${threads.id} AND ${messages.direction} = 'inbound' AND ${messages.scanStatus} = 'pending')`;
}
function requireRead(grants: AgentGrant[], addressId: string | null): asserts addressId is string {
  if (!addressId || !permission(grants, addressId, "read")) throw new AgentReadError(403, "forbidden", "Missing 'read' permission on this mailbox");
}
function pageLimit(limit: number | undefined, body = false): number {
  const max = body ? 10 : 100;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > max)) {
    throw new AgentReadError(400, "bad_request", `limit must be an integer between 1 and ${max}`);
  }
  return limit ?? (body ? 10 : 50);
}
type Cursor = { v: 1; kind: "threads" | "messages" | "changes"; org: string; scope: string; at?: number; id?: string; seq?: number; classify?: boolean };
function encode(cursor: Cursor): string { return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decode(cursor: string | undefined, kind: Cursor["kind"], org: string, scope: string): Cursor | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const c = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as Cursor;
    if (c.v !== 1 || c.kind !== kind || c.org !== org || c.scope !== scope) throw new Error();
    if (kind === "changes") {
      if (!Number.isSafeInteger(c.seq) || c.seq! < 0) throw new Error();
    } else if (!Number.isSafeInteger(c.at) || !Number.isFinite(new Date(c.at!).getTime()) || typeof c.id !== "string" || !c.id.length || c.id.length > 256) throw new Error();
    return c;
  } catch { throw new AgentReadError(400, "bad_cursor", "Invalid cursor for this mailbox or thread"); }
}
const threadProjection = {
  id: threads.id, subject: threads.subject, snippet: threads.snippet, folder: threads.folder, unread: threads.unread,
  messageCount: threads.messageCount, lastMessageAt: threads.lastMessageAt, counterpartyEmail: threads.counterpartyEmail,
  counterpartyName: threads.counterpartyName, addressId: threads.addressId,
};
export function agentThreadSummary(t: Pick<typeof threads.$inferSelect, keyof typeof threadProjection>): ThreadSummary {
  return { id: t.id, subject: t.subject, snippet: t.snippet, folder: t.folder, unread: t.unread, messageCount: t.messageCount, lastMessageAt: t.lastMessageAt.toISOString(), counterpartyEmail: t.counterpartyEmail, counterpartyName: t.counterpartyName, addressId: t.addressId };
}
export async function loadAgentThread(db: Db, agent: Principal, grants: AgentGrant[], threadId: string) {
  const [thread] = await db.select().from(threads).where(and(eq(threads.id, threadId), eq(threads.organizationId, agent.organizationId))).limit(1);
  if (!thread) throw new AgentReadError(404, "not_found", "No such thread");
  requireRead(grants, thread.addressId);
  const [visible] = await db.select({ id: threads.id }).from(threads).where(and(eq(threads.id, threadId), readyForAgents(), permission(grants, thread.addressId, "classify") ? undefined : visibleWithoutClassify())).limit(1);
  if (!visible) throw new AgentReadError(404, "not_found", "No such thread");
  return thread;
}
/** Keyset pagination: timestamp ties use immutable IDs, never OFFSET. */
export async function listAgentThreads(db: Db, agent: Principal, grants: AgentGrant[], addressId: string, options: AgentPageOptions = {}): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> {
  requireRead(grants, addressId);
  const limit = pageLimit(options.limit);
  const cursor = decode(options.cursor, "threads", agent.organizationId, addressId);
  const rows = await db.select(threadProjection).from(threads).where(and(
    eq(threads.organizationId, agent.organizationId), eq(threads.addressId, addressId), sql`${threads.folder} != 'trash'`, readyForAgents(),
    permission(grants, addressId, "classify") ? undefined : visibleWithoutClassify(),
    cursor ? or(lt(threads.lastMessageAt, new Date(cursor.at!)), and(eq(threads.lastMessageAt, new Date(cursor.at!)), lt(threads.id, cursor.id!))) : undefined,
  )).orderBy(desc(threads.lastMessageAt), desc(threads.id)).limit(limit + 1);
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  await auditAgent(db, agent, "agent.threads_listed", { type: "address", id: addressId }, { count: selected.length });
  return { threads: selected.map(agentThreadSummary), nextCursor: rows.length > limit && last ? encode({ v: 1, kind: "threads", org: agent.organizationId, scope: addressId, at: last.lastMessageAt.getTime(), id: last.id }) : null };
}
const messageProjection = {
  id: messages.id, direction: messages.direction, fromEmail: messages.fromEmail, fromName: messages.fromName,
  toEmails: messages.toEmails, ccEmails: messages.ccEmails, subject: messages.subject, snippet: messages.snippet,
  occurredAt: messages.occurredAt, r2Key: messages.r2Key,
};
type MessageRow = { [K in keyof typeof messageProjection]: typeof messages.$inferSelect[K] };
async function messageResult(env: Env, m: MessageRow, includeBody: boolean): Promise<AgentMessageMetadata> {
  const result: AgentMessageMetadata = { id: m.id, direction: m.direction, fromEmail: m.fromEmail, fromName: m.fromName, toEmails: m.toEmails ?? [], ccEmails: m.ccEmails ?? [], subject: m.subject, snippet: m.snippet, text: null, occurredAt: m.occurredAt.toISOString(), bodyTruncated: false };
  if (!includeBody) return result;
  const obj = await env.MAIL_STORE.get(m.r2Key);
  if (!obj) return { ...result, bodyUnavailable: "missing" };
  if (obj.size > MAX_BODY_OBJECT_BYTES) {
    await obj.body.cancel();
    return { ...result, bodyUnavailable: "too_large" };
  }
  try {
    const raw = await obj.json<{ data?: { text?: unknown }; text?: unknown }>();
    const text = raw.data?.text ?? raw.text;
    if (typeof text === "string") { result.text = text.slice(0, MAX_BODY_CHARS); result.bodyTruncated = text.length > MAX_BODY_CHARS; }
  } catch { result.bodyUnavailable = "unreadable"; }
  return result;
}
export async function getAgentThread(env: Env, db: Db, agent: Principal, grants: AgentGrant[], threadId: string, options: AgentMessageOptions = {}) {
  const thread = await loadAgentThread(db, agent, grants, threadId);
  const includeBody = options.includeBody === true;
  const limit = pageLimit(options.limit, includeBody);
  const cursor = decode(options.cursor, "messages", agent.organizationId, threadId);
  const rows = await db.select(messageProjection).from(messages).where(and(
    eq(messages.threadId, threadId), eq(messages.organizationId, agent.organizationId), eq(messages.addressId, thread.addressId!),
    cursor ? or(gt(messages.occurredAt, new Date(cursor.at!)), and(eq(messages.occurredAt, new Date(cursor.at!)), gt(messages.id, cursor.id!))) : undefined,
  )).orderBy(asc(messages.occurredAt), asc(messages.id)).limit(limit + 1);
  const selected = rows.slice(0, limit);
  // Sequential body reads bound both concurrency and output, independently of thread size.
  const results: AgentMessageMetadata[] = [];
  for (const row of selected) results.push(await messageResult(env, row, includeBody));
  const last = selected.at(-1);
  await auditAgent(db, agent, "agent.thread_read", { type: "thread", id: threadId }, { messages: selected.length, includeBody });
  return { thread: agentThreadSummary(thread), messages: results, nextCursor: rows.length > limit && last ? encode({ v: 1, kind: "messages", org: agent.organizationId, scope: threadId, at: last.occurredAt.getTime(), id: last.id }) : null };
}
/** An explicit, bounded body fetch; no other messages in the conversation are read. */
export async function getAgentMessage(env: Env, db: Db, agent: Principal, grants: AgentGrant[], messageId: string, options: { includeBody?: boolean } = {}) {
  const [row] = await db.select({ ...messageProjection, threadId: messages.threadId, addressId: messages.addressId }).from(messages).where(and(eq(messages.id, messageId), eq(messages.organizationId, agent.organizationId))).limit(1);
  if (!row) throw new AgentReadError(404, "not_found", "No such message");
  const thread = await loadAgentThread(db, agent, grants, row.threadId);
  if (row.addressId !== thread.addressId) throw new AgentReadError(404, "not_found", "No such message");
  const result = await messageResult(env, row, options.includeBody === true);
  await auditAgent(db, agent, "agent.thread_read", { type: "thread", id: thread.id }, { messageId, messages: 1, includeBody: options.includeBody === true });
  return { threadId: thread.id, message: result };
}
export interface AgentChange { cursor: string; kind: string; threadId: string; messageId: string | null; occurredAt: string }
/**
 * An append-only mailbox journal. Filter with CURRENT policy on every replay.
 * Classification/move triggers append new events, so advancing past hidden mail
 * cannot lose its later release from quarantine. nextCursor is a durable checkpoint,
 * including on an empty page; persist it only after processing the page successfully.
 */
export async function listAgentChanges(db: Db, agent: Principal, grants: AgentGrant[], addressId: string, options: AgentPageOptions = {}): Promise<{ changes: AgentChange[]; nextCursor: string; hasMore: boolean }> {
  requireRead(grants, addressId);
  const limit = pageLimit(options.limit);
  const cursor = decode(options.cursor, "changes", agent.organizationId, addressId);
  const classify = permission(grants, addressId, "classify");
  if (cursor && cursor.classify !== classify) {
    throw new AgentReadError(400, "cursor_permissions_changed", "Mailbox permissions changed; restart the changes feed without a cursor");
  }
  const after = cursor?.seq ?? 0;
  const [watermark] = await db.all<{ seq: number }>(sql`SELECT coalesce(max(seq), 0) AS seq FROM agent_changes WHERE organization_id = ${agent.organizationId} AND address_id = ${addressId}`);
  const high = Number(watermark?.seq ?? 0);
  if (after > high) throw new AgentReadError(400, "bad_cursor", "Cursor is ahead of this mailbox journal");
  const rows = await db.all<{ seq: number; kind: string; threadId: string; messageId: string | null; occurredAt: number }>(sql`
    SELECT c.seq, c.kind, c.thread_id AS threadId, c.message_id AS messageId, c.created_at AS occurredAt
    FROM agent_changes c LEFT JOIN threads ON threads.id = c.thread_id
    WHERE c.organization_id = ${agent.organizationId} AND c.address_id = ${addressId} AND c.seq > ${after} AND c.seq <= ${high}
      AND ((c.kind IN ('thread_deleted', 'thread_removed') AND c.ready_for_agents = 1 AND (${classify ? 1 : 0} = 1 OR c.visible_without_classify = 1))
        OR (c.kind NOT IN ('thread_deleted', 'thread_removed') AND threads.organization_id = ${agent.organizationId} AND threads.address_id = ${addressId}
          AND ${readyForAgents()} ${classify ? sql`` : sql`AND ${visibleWithoutClassify()}`}))
    ORDER BY c.seq LIMIT ${limit + 1}
  `);
  const selected = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const token = (seq: number) => encode({ v: 1, kind: "changes", org: agent.organizationId, scope: addressId, seq, classify });
  await auditAgent(db, agent, "agent.threads_listed", { type: "address", id: addressId }, { changes: selected.length });
  return { changes: selected.map(row => ({ cursor: token(row.seq), kind: row.kind, threadId: row.threadId, messageId: row.messageId, occurredAt: new Date(row.occurredAt).toISOString() })), nextCursor: token(hasMore ? selected.at(-1)!.seq : high), hasMore };
}
