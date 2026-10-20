import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  addressGrants,
  addresses,
  agents,
  auditEvents,
  domains,
  messages,
  threads,
} from "@boxox/db";
import { agentSendSchema, makeSnippet, normalizeSubject } from "@boxox/shared";
import { buildReferences } from "../services/ingest";
import { batch, type Db } from "../db";
import type { Env } from "../env";
import { isFree } from "../services/capabilities";
import { AgentIdempotencyError, idempotentAgentSend } from "../services/agent-send-idempotency";
import { sendCapViolation } from "../services/outbound/cap-error";
import { deliverQueuedMessage } from "../services/outbound";
import { agentAuthConfigured, verifyAgentToken } from "../services/agent-auth";
import { organizationSendLimit, rateLimitHit } from "../services/agent-rate-limit";
import { AgentReadError, getAgentMessage, getAgentThread, listAgentChanges, listAgentThreads, type AgentMessageOptions, type AgentPageOptions } from "../services/agent-reads";
import {
  agentsKilled,
  auditAgent,
  checkAgentSendCaps,
  threadVisibleWithoutClassify,
  visibleWithoutClassify,
} from "../services/agent-policy";

/**
 * Bearer-authenticated agent REST API (/api/agent/v1/*). The same middleware and
 * service functions back the MCP server (routes/mcp.ts), so permission checks are
 * defined exactly once here and reused there.
 */

export interface AgentPrincipal {
  id: string;
  organizationId: string;
  name: string;
  clientId: string;
}

export interface AgentGrant {
  addressId: string;
  permissions: string[];
}

export type AgentEnv = {
  Bindings: Env;
  Variables: {
    db: Db;
    agent: AgentPrincipal;
    grants: AgentGrant[];
  };
};

/** Service-layer error carrying the HTTP status + code REST/MCP handlers map to. */
export class AgentError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function hasPermission(grants: AgentGrant[], addressId: string, perm: string): boolean {
  return grants.some((g) => g.addressId === addressId && g.permissions.includes(perm));
}

/**
 * The set of counterparty emails a reply-only ("send") agent may write to
 * (design §3.3 — SECURITY). A recipient is "known" ONLY when a trusted
 * interaction established it:
 *   - an AUTHENTICATED inbound message from that sender (DMARC pass / aligned
 *     SPF+DKIM; `authenticated=true`, set by ingest), OR
 *   - a prior OUTBOUND message to that recipient from the same address.
 *
 * Unauthenticated inbound is IGNORED: a spoofed `From` on inbound mail must
 * never be able to whitelist a target and unlock cold-emailing it. Anything not
 * in this set is net-new and requires the `send_new` grant.
 */
export function knownCounterparties(
  inbound: { fromEmail: string | null; authenticated: boolean }[],
  outbound: { toEmails: string[] | null }[],
): Set<string> {
  const known = new Set<string>();
  for (const m of inbound) {
    if (m.authenticated && m.fromEmail) known.add(m.fromEmail.toLowerCase());
  }
  for (const m of outbound) {
    for (const e of m.toEmails ?? []) known.add(e.toLowerCase());
  }
  return known;
}

function requireRead(grants: AgentGrant[], addressId: string | null): asserts addressId is string {
  if (!addressId || !hasPermission(grants, addressId, "read")) {
    throw new AgentError(403, "forbidden", "Missing 'read' permission on this mailbox");
  }
}

type AgentRef = Pick<AgentPrincipal, "id" | "organizationId">;

/**
 * Loads a thread the agent may act on. Spam, Quarantine and prompt-injection
 * mail needs `classify`; without it the thread answers 404, as if absent.
 */
async function loadVisibleThread(db: Db, agent: AgentRef, grants: AgentGrant[], threadId: string) {
  const trow = await db
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.organizationId, agent.organizationId)))
    .limit(1);
  const thread = trow[0];
  if (!thread) throw new AgentError(404, "not_found", "No such thread");
  requireRead(grants, thread.addressId);
  if (!hasPermission(grants, thread.addressId, "classify") && !(await threadVisibleWithoutClassify(db, threadId))) {
    throw new AgentError(404, "not_found", "No such thread");
  }
  return { ...thread, addressId: thread.addressId };
}

// ---------- bearer middleware ----------

/**
 * Verify the JWT → load the agent WHERE status='active' → load its grants
 * (JOIN agents guard, so a disabled agent has zero effective grants) → attach
 * to context, meter the call, and throttle last_seen_at. Fails closed (503)
 * when AGENT_JWT_SECRET is unset.
 */
export const attachAgent = createMiddleware<AgentEnv>(async (c, next) => {
  if (!agentAuthConfigured(c.env)) {
    return c.json(
      { error: { code: "agent_auth_unconfigured", message: "Agent API is not configured" } },
      503,
    );
  }
  const auth = c.req.header("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ error: { code: "unauthorized", message: "Bearer token required" } }, 401);
  }
  const claims = await verifyAgentToken(c.env, match[1]!.trim());
  if (!claims) {
    return c.json({ error: { code: "unauthorized", message: "Invalid or expired token" } }, 401);
  }
  const db = c.get("db");
  if (await agentsKilled(db)) {
    return c.json({ error: { code: "agents_disabled", message: "All agents are switched off" } }, 403);
  }
  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, claims.agentId),
        eq(agents.organizationId, claims.organizationId),
        eq(agents.status, "active"),
      ),
    )
    .limit(1);
  const agent = rows[0];
  if (!agent) {
    return c.json({ error: { code: "unauthorized", message: "Agent not found or disabled" } }, 401);
  }

  // Grants only load for active agents — the innerJoin re-asserts status='active'
  // (design §3.2: every agent grant load JOINs agents and requires active).
  const grantRows = await db
    .select({
      addressId: addressGrants.addressId,
      permissions: addressGrants.permissions,
    })
    .from(addressGrants)
    .innerJoin(agents, eq(addressGrants.principalId, agents.id))
    .where(
      and(
        eq(addressGrants.organizationId, agent.organizationId),
        eq(addressGrants.principalType, "agent"),
        eq(addressGrants.principalId, agent.id),
        eq(agents.status, "active"),
      ),
    );
  const grants: AgentGrant[] = grantRows.map((g) => ({
    addressId: g.addressId,
    permissions: Array.isArray(g.permissions) ? (g.permissions as string[]) : [],
  }));

  c.set("agent", {
    id: agent.id,
    organizationId: agent.organizationId,
    name: agent.name,
    clientId: agent.clientId,
  });
  c.set("grants", grants);

  // last_seen_at, throttled to ~1/min to avoid a write on every call.
  const lastSeen = agent.lastSeenAt?.getTime() ?? 0;
  if (Date.now() - lastSeen > 60_000) {
    try {
      await db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.id, agent.id));
    } catch {
      // best-effort telemetry; never fail the request over it
    }
  }

  await next();
});

// ---------- shared service functions (REST + MCP) ----------

export interface ThreadSummary {
  id: string;
  subject: string;
  snippet: string;
  folder: string;
  unread: boolean;
  messageCount: number;
  lastMessageAt: string;
  counterpartyEmail: string | null;
  counterpartyName: string | null;
  addressId: string | null;
}

export async function listThreadsForAddress(
  db: Db,
  agent: AgentRef,
  grants: AgentGrant[],
  addressId: string,
  options: AgentPageOptions = {},
): Promise<ThreadSummary[]> {
  return (await listAgentThreads(db, agent, grants, addressId, options)).threads;
}

export interface AgentMessage {
  id: string;
  direction: "inbound" | "outbound";
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  snippet: string;
  text: string | null;
  occurredAt: string;
}

export async function getThreadDetail(
  env: Env,
  db: Db,
  agent: AgentRef,
  grants: AgentGrant[],
  threadId: string,
  options: AgentMessageOptions = {},
) {
  return getAgentThread(env, db, agent, grants, threadId, options);
}

export async function markThreadRead(
  db: Db,
  agent: AgentRef,
  grants: AgentGrant[],
  threadId: string,
): Promise<void> {
  await loadVisibleThread(db, agent, grants, threadId);
  await db.update(threads).set({ unread: false, updatedAt: new Date() }).where(eq(threads.id, threadId));
  await auditAgent(db, agent, "agent.thread_marked_read", { type: "thread", id: threadId });
}

/**
 * Agents can only move mail to Trash; the retention purge, or a person, deletes
 * it for good. There is deliberately no agent hard-delete function.
 */
export async function trashThread(
  db: Db,
  agent: AgentRef,
  grants: AgentGrant[],
  threadId: string,
): Promise<void> {
  await loadVisibleThread(db, agent, grants, threadId);
  await db.update(threads).set({ folder: "trash", updatedAt: new Date() }).where(eq(threads.id, threadId));
  await auditAgent(db, agent, "agent.thread_trashed", { type: "thread", id: threadId });
}

export async function refuseHardDelete(db: Db, agent: AgentRef, threadId: string): Promise<never> {
  await auditAgent(db, agent, "agent.delete_refused", { type: "thread", id: threadId });
  throw new AgentError(403, "forbidden", "Agents cannot permanently delete mail; move it to Trash instead");
}

export interface AgentSendInput {
  fromAddressId: string;
  to: string[];
  subject: string;
  text: string;
  threadId?: string;
  idempotencyKey?: string;
  idempotencyGroup?: string;
}

/**
 * Agent send with ToS-driven permission split (design §3.3):
 *   - "send" is reply-only: every recipient must already be a counterparty on an
 *     existing thread of the from address.
 *   - a recipient not seen before requires "send_new".
 * Reuses the outbound delivery helper rather than the session-only
 * routes/send.ts.
 */
async function sendAgentEmailOnce(
  env: Env,
  db: Db,
  orgId: string,
  agentId: string,
  grants: AgentGrant[],
  input: AgentSendInput,
): Promise<{ threadId: string; messageId: string; sentMessageId: string }> {
  if (isFree(env)) throw new AgentError(403, "feature_unavailable", "Sending is unavailable in the Free inbox profile.");
  const arow = await db
    .select({
      id: addresses.id,
      localPart: addresses.localPart,
      displayName: addresses.displayName,
      status: addresses.status,
      domainName: domains.name,
    })
    .from(addresses)
    .innerJoin(domains, eq(addresses.domainId, domains.id))
    .where(and(eq(addresses.id, input.fromAddressId), eq(addresses.organizationId, orgId)))
    .limit(1);
  const addr = arow[0];
  if (!addr) throw new AgentError(404, "not_found", "No such address");
  if (addr.status !== "active") {
    throw new AgentError(409, "address_inactive", "From address is not active");
  }
  const agent = { id: agentId, organizationId: orgId };
  const refuse = async (err: AgentError, metadata: Record<string, unknown>): Promise<never> => {
    await auditAgent(db, agent, "agent.send_refused", { type: "address", id: addr.id }, {
      code: err.code,
      to: input.to,
      ...metadata,
    });
    throw err;
  };

  // Probe only the requested recipients. Loading every correspondent made each
  // agent reply grow with the entire mailbox and returned unbounded D1 results.
  const candidates = [...new Set(input.to.map(email => email.toLowerCase()))];
  const known = new Set<string>();
  for (const recipient of candidates) {
    const inbound = await db.select({ id: messages.id }).from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(and(eq(messages.organizationId, orgId), eq(messages.addressId, addr.id),
        eq(messages.direction, "inbound"), eq(messages.authenticated, true), sql`${messages.scanStatus} != 'pending'`,
        sql`lower(${messages.fromEmail}) = ${recipient}`, visibleWithoutClassify())).limit(1);
    if (inbound.length) { known.add(recipient); continue; }
    const outbound = await db.all<{ recipient: string }>(sql`SELECT recipient FROM outbound_recipients
      WHERE organization_id=${orgId} AND address_id=${addr.id} AND recipient=${recipient} LIMIT 1`);
    if (outbound.length) known.add(recipient);
  }
  const netNew = input.to.filter(email => !known.has(email.toLowerCase()));
  const hasSend = hasPermission(grants, input.fromAddressId, "send");
  const hasSendNew = hasPermission(grants, input.fromAddressId, "send_new");

  if (netNew.length > 0) {
    if (!hasSendNew) {
      await refuse(
        new AgentError(
          403,
          "forbidden",
          "Missing 'send_new' permission: recipients include addresses with no prior thread",
        ),
        { netNew },
      );
    }
  } else if (!hasSend && !hasSendNew) {
    await refuse(new AgentError(403, "forbidden", "Missing 'send' permission on this address"), {});
  }

  const fromEmail = `${addr.localPart}@${addr.domainName}`;
  const from = addr.displayName ? `${addr.displayName} <${fromEmail}>` : fromEmail;

  // Reply threading: reference the last inbound message when replying.
  let threadId = input.threadId ?? null;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  if (threadId) {
    const trow = await db
      .select({ id: threads.id, addressId: threads.addressId })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.organizationId, orgId)))
      .limit(1);
    if (!trow[0]) throw new AgentError(404, "not_found", "No such thread");
    if (trow[0].addressId !== input.fromAddressId) {
      throw new AgentError(409, "thread_mismatch", "Thread does not belong to the from address");
    }
    if (
      !hasPermission(grants, input.fromAddressId, "classify") &&
      !(await threadVisibleWithoutClassify(db, threadId))
    ) {
      throw new AgentError(404, "not_found", "No such thread");
    }
    const last = await db
      .select({ rfcMessageId: messages.rfcMessageId, references: messages.references })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.direction, "inbound")))
      // DESC + limit 1: ascending with .at(-1) took the 50th-OLDEST inbound
      // message as the parent on any thread longer than 50.
      .orderBy(desc(messages.occurredAt))
      .limit(1);
    const parent = last[0];
    inReplyTo = parent?.rfcMessageId ?? null;
    // Agents reply into human threads, so they must emit the same RFC 5322
    // ancestry chain — otherwise an agent's reply fragments the conversation in
    // the recipient's client even though the human path threads correctly.
    references = buildReferences(parent?.references ?? null, parent?.rfcMessageId ?? null);
  }

  const cap = await checkAgentSendCaps(db, agentId);
  if (!cap.allowed) {
    await refuse(
      new AgentError(429, "send_cap_reached", `This agent's ${cap.window} send cap (${cap.limit}) is reached`),
      { window: cap.window, limit: cap.limit },
    );
  }

  // Per-org outbound throttle (abuse backstop, not a billing cap). Charged on the
  // verified path only, just before the send goes out — over budget writes nothing
  // and never calls the send binding. Budget is shared with human sends (routes/send.ts).
  const sendLimit = await rateLimitHit(db, `send:org:${orgId}`, organizationSendLimit(env));
  if (!sendLimit.allowed) {
    throw new AgentError(429, "rate_limited", "Send rate limit exceeded");
  }

  const now = new Date();
  const msgId = crypto.randomUUID();
  const r2Key = `sent/${orgId}/${now.toISOString().slice(0, 10)}/${msgId}.json`;
  await env.MAIL_STORE.put(
    r2Key,
    JSON.stringify({ text: input.text, to: input.to, subject: input.subject }),
    { httpMetadata: { contentType: "application/json" } },
  );

  // The local record must not be able to half-commit — see the same reasoning
  // in routes/send.ts.
  const newThread = !threadId;
  const storedThreadId = (threadId ??= crypto.randomUUID());
  const auditId = crypto.randomUUID();
  try {
    await batch(db, [
      db.insert(auditEvents).values({
        id: auditId, organizationId: orgId, actorType: "agent", actorId: agentId,
        action: "agent.message_sent", targetType: "message", targetId: msgId,
        metadata: { from: fromEmail, to: input.to, pending: true, netNew: netNew.length }, createdAt: now,
      }),
      ...(newThread
        ? [
            db.insert(threads).values({
              id: threadId,
              organizationId: orgId,
              addressId: addr.id,
              subject: input.subject,
              subjectNorm: normalizeSubject(input.subject),
              counterpartyEmail: input.to[0] ?? null,
              counterpartyName: null,
              folder: "sent",
              unread: false,
              lastMessageAt: now,
            }),
          ]
        : []),
      db.insert(messages).values({
        id: msgId,
        threadId,
        organizationId: orgId,
        addressId: addr.id,
        /** Mailbox scope; outbound leaves rfcMessageId null and is never deduped. */
        dedupeScope: addr.id,
        direction: "outbound",
        // We sent it, so the sender identity is trusted — this lets a later
        // reply-only send treat these recipients as known counterparties.
        authenticated: true,
        fromEmail,
        fromName: addr.displayName,
        toEmails: input.to,
        ccEmails: [],
        subject: input.subject,
        snippet: makeSnippet(input.text),
        inReplyTo,
        references,
        r2Key,
        hasText: true,
        // Written BEFORE the send binding is called, exactly as routes/send.ts does.
        sendStatus: "queued",
        sendAttempts: 0,
        occurredAt: now,
      }),
      db
        .update(threads)
        .set({
          lastMessageAt: now,
          snippet: makeSnippet(input.text),
          messageCount: sql`${threads.messageCount} + 1`,
          updatedAt: now,
        })
        .where(eq(threads.id, threadId)),
    ]);
  } catch (err) {
    const violation = sendCapViolation(err);
    if (!violation) throw err;
    await env.MAIL_STORE.delete(r2Key);
    const window = violation === "agent_send_daily_cap" ? "daily" : "hourly";
    await refuse(new AgentError(429, "send_cap_reached", `This agent's ${window} send cap is reached`), { window });
  }

  // Same helper the human send path uses.
  const outcome = await deliverQueuedMessage(db, env.EMAIL, {
    messageId: msgId,
    organizationId: orgId,
    from,
    to: input.to,
    cc: [],
    subject: input.subject,
    text: input.text,
    html: null,
    attachments: [],
    inReplyTo,
    references,
    attempts: 0,
  });
  // Written for failed sends too: the message is saved and retryable, so it
  // counts against the agent's caps.
  await db.update(auditEvents).set({ metadata: {
    from: fromEmail, to: input.to,
    sentMessageId: outcome.ok ? outcome.sentMessageId : null,
    failed: !outcome.ok, netNew: netNew.length,
  } }).where(eq(auditEvents.id, auditId));
  if (!outcome.ok) {
    // The message IS saved. Say so, so an agent does not compose and send a
    // second copy.
    throw new AgentError(
      502,
      "send_failed",
      `${outcome.error} — the message was saved (id ${msgId}); do not compose it again.`,
    );
  }

  return { threadId: storedThreadId, messageId: msgId, sentMessageId: outcome.sentMessageId };
}

/** The same request key covers REST, static-bearer MCP and OAuth MCP retries. */
export async function sendAgentEmail(
  env: Env, db: Db, orgId: string, agentId: string, grants: AgentGrant[], input: AgentSendInput,
): Promise<{ threadId: string; messageId: string; sentMessageId: string }> {
  if (input.idempotencyGroup && !input.idempotencyKey) throw new AgentError(400, "bad_request", "idempotencyGroup requires idempotencyKey");
  if (!input.idempotencyKey) return sendAgentEmailOnce(env, db, orgId, agentId, grants, input);
  // Revocation and profile checks precede cached-result reads too.
  if (isFree(env)) throw new AgentError(403, "feature_unavailable", "Sending is unavailable in the Free inbox profile.");
  if (!hasPermission(grants, input.fromAddressId, "send") && !hasPermission(grants, input.fromAddressId, "send_new")) {
    throw new AgentError(403, "forbidden", "Missing send permission on this address");
  }
  const address = await db.select({ id: addresses.id }).from(addresses)
    .where(and(eq(addresses.id, input.fromAddressId), eq(addresses.organizationId, orgId), eq(addresses.status, "active"))).limit(1);
  if (!address.length) throw new AgentError(404, "not_found", "No active address");
  const { idempotencyKey, idempotencyGroup, ...payload } = input;
  try {
    return await idempotentAgentSend(db, { organizationId: orgId, agentId: idempotencyGroup ? `group:${input.fromAddressId}:${idempotencyGroup}` : agentId, key: idempotencyKey, input: payload },
      () => sendAgentEmailOnce(env, db, orgId, agentId, grants, payload));
  } catch (error) {
    if (error instanceof AgentIdempotencyError) throw new AgentError(error.status, error.code, error.message);
    throw error;
  }
}

// ---------- REST routes ----------

function fail(err: unknown): never {
  throw err;
}

function readPageQuery(query: Record<string, string>): AgentPageOptions {
  return { limit: query.limit === undefined ? undefined : Number(query.limit), cursor: query.cursor };
}
function readBodyQuery(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new AgentReadError(400, "bad_request", "includeBody must be true or false");
}

export const agent_apiRoutes = new Hono<AgentEnv>()
  .use("*", attachAgent)

  .get("/me", (c) => {
    const agent = c.get("agent");
    const grants = c.get("grants");
    return c.json({
      agent: { id: agent.id, name: agent.name, clientId: agent.clientId },
      addresses: grants.map((g) => ({ addressId: g.addressId, permissions: g.permissions })),
    });
  })

  .get("/addresses/:addressId/threads", async (c) => {
    try {
      return c.json(await listAgentThreads(c.get("db"), c.get("agent"), c.get("grants"), c.req.param("addressId"), readPageQuery(c.req.query())));
    } catch (err) {
      if (err instanceof AgentReadError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400 | 403 | 404);
      return fail(err);
    }
  })

  .get("/addresses/:addressId/changes", async (c) => {
    try {
      return c.json(await listAgentChanges(c.get("db"), c.get("agent"), c.get("grants"), c.req.param("addressId"), readPageQuery(c.req.query())));
    } catch (err) {
      if (err instanceof AgentReadError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400 | 403 | 404);
      return fail(err);
    }
  })

  .get("/threads/:threadId", async (c) => {
    try {
      return c.json(await getThreadDetail(c.env, c.get("db"), c.get("agent"), c.get("grants"), c.req.param("threadId"), { ...readPageQuery(c.req.query()), includeBody: readBodyQuery(c.req.query("includeBody")) }));
    } catch (err) {
      if (err instanceof AgentReadError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400 | 403 | 404);
      return fail(err);
    }
  })

  .get("/messages/:messageId", async (c) => {
    try {
      return c.json(await getAgentMessage(c.env, c.get("db"), c.get("agent"), c.get("grants"), c.req.param("messageId"), { includeBody: readBodyQuery(c.req.query("includeBody")) }));
    } catch (err) {
      if (err instanceof AgentReadError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400 | 403 | 404);
      return fail(err);
    }
  })

  .post("/threads/:threadId/read", async (c) => {
    try {
      await markThreadRead(
        c.get("db"),
        c.get("agent"),
        c.get("grants"),
        c.req.param("threadId"),
      );
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status as 403 | 404);
      }
      return fail(err);
    }
  })

  .post("/threads/:threadId/trash", async (c) => {
    try {
      await trashThread(c.get("db"), c.get("agent"), c.get("grants"), c.req.param("threadId"));
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status as 403 | 404);
      }
      return fail(err);
    }
  })

  .delete("/threads/:threadId", async (c) => {
    try {
      return await refuseHardDelete(c.get("db"), c.get("agent"), c.req.param("threadId"));
    } catch (err) {
      if (err instanceof AgentError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status as 403);
      }
      return fail(err);
    }
  })

  .post("/send", async (c) => {
    const raw = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const key = c.req.header("Idempotency-Key");
    if (key && raw?.idempotencyKey && key !== raw.idempotencyKey) return c.json({ error: { code: "bad_request", message: "Idempotency-Key header and body disagree" } }, 400);
    const parsed = agentSendSchema.safeParse(raw && key ? { ...raw, idempotencyKey: key } : raw);
    if (!parsed.success) {
      return c.json(
        { error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid message" } },
        400,
      );
    }
    try {
      const result = await sendAgentEmail(
        c.env,
        c.get("db"),
        c.get("agent").organizationId,
        c.get("agent").id,
        c.get("grants"),
        parsed.data,
      );
      return c.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof AgentError) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          err.status as 403 | 404 | 409 | 429 | 502,
        );
      }
      return fail(err);
    }
  });
