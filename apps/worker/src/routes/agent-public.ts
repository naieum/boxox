import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { agentPairingCodes, agents, operationalEvents } from "@boxox/db";
import { agentPairSchema, agentTokenSchema } from "@boxox/shared";
import { writeAudit } from "../audit";
import type { AppContext } from "../middleware";
import {
  agentAuthConfigured,
  generateClientSecret,
  mintAgentToken,
  sha256Hex,
  verifySecret,
} from "../services/agent-auth";
import { agentsKilled } from "../services/agent-policy";
import { RATE_LIMITS, rateLimitHit } from "../services/agent-rate-limit";

/**
 * Public agent endpoints — no session, no bearer. Both fail closed (503) when
 * AGENT_JWT_SECRET is unset, and both sit behind the Postgres fixed-window rate
 * limiter (design §3.5). Neither ever emits a plaintext code, secret, or token
 * into audit metadata, operational_events, or the console.
 */

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

async function warnOp(
  db: AppContext["Variables"]["db"],
  organizationId: string,
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(operationalEvents).values({
      id: crypto.randomUUID(),
      organizationId,
      kind,
      level: "warn",
      detail,
    });
  } catch {
    // telemetry is best-effort; never block the auth path on it
  }
}

export const agent_publicRoutes = new Hono<AppContext>()
  // ---- POST /api/agent/pair { code } → { clientId, clientSecret } (once) ----
  .post("/pair", async (c) => {
    if (!agentAuthConfigured(c.env)) {
      return c.json(
        { error: { code: "agent_auth_unconfigured", message: "Agent API is not configured" } },
        503,
      );
    }
    const db = c.get("db");
    const ip = clientIp(c);
    if (await agentsKilled(db)) {
      return c.json({ error: { code: "agents_disabled", message: "All agents are switched off" } }, 403);
    }

    const limit = await rateLimitHit(db, `pair:ip:${ip}`, RATE_LIMITS.pairPerIp);
    if (!limit.allowed) {
      return c.json({ error: { code: "rate_limited", message: "Too many pairing attempts" } }, 429);
    }

    const parsed = agentPairSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_code", message: "Invalid or expired code" } }, 401);
    }

    const codeHash = await sha256Hex(parsed.data.code);
    const rows = await db
      .select({
        codeId: agentPairingCodes.id,
        agentId: agentPairingCodes.agentId,
        expiresAt: agentPairingCodes.expiresAt,
        usedAt: agentPairingCodes.usedAt,
        orgId: agents.organizationId,
        status: agents.status,
        clientId: agents.clientId,
      })
      .from(agentPairingCodes)
      .innerJoin(agents, eq(agentPairingCodes.agentId, agents.id))
      .where(eq(agentPairingCodes.codeHash, codeHash))
      .limit(1);
    const row = rows[0];

    // Unknown code: nothing to attribute to an org, rate limiter handles abuse.
    if (!row) {
      return c.json({ error: { code: "invalid_code", message: "Invalid or expired code" } }, 401);
    }
    if (row.usedAt || row.expiresAt.getTime() <= Date.now()) {
      await warnOp(db, row.orgId, "agent_pair_failed", {
        agentId: row.agentId,
        reason: row.usedAt ? "already_used" : "expired",
      });
      return c.json({ error: { code: "invalid_code", message: "Invalid or expired code" } }, 401);
    }
    if (row.status !== "active") {
      await warnOp(db, row.orgId, "agent_pair_failed", { agentId: row.agentId, reason: "disabled" });
      return c.json({ error: { code: "invalid_code", message: "Invalid or expired code" } }, 401);
    }

    // Single-use burn: guarded UPDATE ... WHERE used_at IS NULL wins any race.
    const burned = await db
      .update(agentPairingCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(agentPairingCodes.id, row.codeId), isNull(agentPairingCodes.usedAt)))
      .returning({ id: agentPairingCodes.id });
    if (!burned[0]) {
      return c.json({ error: { code: "invalid_code", message: "Invalid or expired code" } }, 401);
    }

    // Rotate the secret in place on the stable client_id (lost-secret recovery).
    const clientSecret = generateClientSecret();
    const clientSecretHash = await sha256Hex(clientSecret);
    await db
      .update(agents)
      .set({ clientSecretHash })
      .where(eq(agents.id, row.agentId));

    await writeAudit(db, {
      organizationId: row.orgId,
      actorType: "agent",
      actorId: row.agentId,
      action: "agent.paired",
      targetType: "agent",
      targetId: row.agentId,
      metadata: { clientId: row.clientId },
      ipAddress: ip,
    });

    return c.json({ clientId: row.clientId, clientSecret });
  })

  // ---- POST /api/agent/token → { access_token, token_type, expires_in } ----
  .post("/token", async (c) => {
    if (!agentAuthConfigured(c.env)) {
      return c.json(
        { error: { code: "agent_auth_unconfigured", message: "Agent API is not configured" } },
        503,
      );
    }
    const db = c.get("db");
    const ip = clientIp(c);
    if (await agentsKilled(db)) {
      return c.json({ error: { code: "agents_disabled", message: "All agents are switched off" } }, 403);
    }

    const ipLimit = await rateLimitHit(db, `token:ip:${ip}`, RATE_LIMITS.tokenPerIp);
    if (!ipLimit.allowed) {
      return c.json({ error: { code: "rate_limited", message: "Too many token requests" } }, 429);
    }

    // Accept JSON or application/x-www-form-urlencoded client_credentials.
    const ct = c.req.header("content-type") ?? "";
    let raw: unknown;
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      raw = await c.req.parseBody().catch(() => null);
    } else {
      raw = await c.req.json().catch(() => null);
    }
    const parsed = agentTokenSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_request", message: "Missing client credentials" } }, 400);
    }
    const { client_id, client_secret } = parsed.data;

    const rows = await db
      .select({
        id: agents.id,
        organizationId: agents.organizationId,
        status: agents.status,
        clientSecretHash: agents.clientSecretHash,
      })
      .from(agents)
      .where(eq(agents.clientId, client_id))
      .limit(1);
    const agent = rows[0];

    // Constant-time verify even when the client_id is unknown (dummy hash inside).
    const ok = await verifySecret(client_secret, agent?.clientSecretHash ?? null);
    if (!agent || !ok) {
      return c.json({ error: { code: "invalid_client", message: "Invalid client credentials" } }, 401);
    }

    // Per-client budget is charged only on the VERIFIED path. client_id is public,
    // so charging it pre-auth would let anyone who knows it exhaust a victim
    // agent's token budget and lock the agent out (DoS). The pre-auth per-IP
    // bucket above still bounds brute-force attempts.
    const clientLimit = await rateLimitHit(db, `token:client:${client_id}`, RATE_LIMITS.tokenPerClient);
    if (!clientLimit.allowed) {
      return c.json({ error: { code: "rate_limited", message: "Too many token requests" } }, 429);
    }

    // A just-disabled agent must not mint fresh tokens.
    if (agent.status !== "active") {
      return c.json({ error: { code: "agent_disabled", message: "Agent is disabled" } }, 403);
    }

    const { token, expiresIn } = await mintAgentToken(c.env, agent.id, agent.organizationId);
    return c.json({ access_token: token, token_type: "bearer", expires_in: expiresIn });
  });
