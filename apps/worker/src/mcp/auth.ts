import { and, eq } from "drizzle-orm";
import { addressGrants, agents, mcpClients } from "@boxox/db";
import type { Db } from "../db";
import type { AgentGrant, AgentPrincipal } from "../routes/agent-api";
import { agentsKilled } from "../services/agent-policy";

/**
 * What the OAuth provider stores on a grant (and hands back on every MCP call):
 * the agent principal the owner bound the client to. Paired script agents reach
 * /mcp with their agent JWT instead and carry no clientId.
 */
export interface McpProps {
  agentId: string;
  organizationId: string;
  clientId?: string;
}

export type McpAuthResult =
  | { ok: true; agent: AgentPrincipal; grants: AgentGrant[] }
  | { ok: false; status: 401 | 403; code: string; message: string };

export function readMcpProps(props: unknown): McpProps | null {
  if (!props || typeof props !== "object") return null;
  const p = props as Record<string, unknown>;
  if (typeof p.agentId !== "string" || typeof p.organizationId !== "string") return null;
  if (p.clientId !== undefined && typeof p.clientId !== "string") return null;
  return { agentId: p.agentId, organizationId: p.organizationId, clientId: p.clientId as string | undefined };
}

/**
 * Re-checks everything on each call, so a revoke, a disabled agent or the kill
 * switch takes effect on tokens already issued: the client must still be
 * approved, unrevoked and bound to this agent; the agent must be active; grants
 * load through the same active-agent join as the REST API.
 */
export async function resolveMcpPrincipal(db: Db, props: McpProps): Promise<McpAuthResult> {
  if (await agentsKilled(db)) {
    return { ok: false, status: 403, code: "agents_disabled", message: "All agents are switched off" };
  }
  if (props.clientId !== undefined) {
    const client = (
      await db.select().from(mcpClients).where(eq(mcpClients.clientId, props.clientId)).limit(1)
    )[0];
    if (!client || !client.approvedAt || client.revokedAt || client.agentId !== props.agentId) {
      return { ok: false, status: 401, code: "client_revoked", message: "This MCP client is not approved" };
    }
    const lastSeen = client.lastSeenAt?.getTime() ?? 0;
    if (Date.now() - lastSeen > 60_000) {
      await db
        .update(mcpClients)
        .set({ lastSeenAt: new Date() })
        .where(eq(mcpClients.clientId, client.clientId))
        .catch(() => {});
    }
  }
  const agent = (
    await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, props.agentId),
          eq(agents.organizationId, props.organizationId),
          eq(agents.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (!agent) return { ok: false, status: 401, code: "unauthorized", message: "Agent not found or disabled" };

  const grantRows = await db
    .select({ addressId: addressGrants.addressId, permissions: addressGrants.permissions })
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
  return {
    ok: true,
    agent: { id: agent.id, organizationId: agent.organizationId, name: agent.name, clientId: agent.clientId },
    grants: grantRows.map((g) => ({
      addressId: g.addressId,
      permissions: Array.isArray(g.permissions) ? (g.permissions as string[]) : [],
    })),
  };
}
