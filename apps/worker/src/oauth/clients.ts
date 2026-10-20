import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { agents, mcpClients } from "@boxox/db";
import { writeAudit } from "../audit";
import type { Db } from "../db";
import type { Env } from "../env";
import { requireOrgAdmin, requireOrgMember, type AppContext } from "../middleware";
import { oauthApi, publicOrigin } from "./provider";

/**
 * Revoking a client: mark it revoked (every MCP call re-checks this, so live
 * access tokens stop at once), revoke its grants so refresh tokens die too,
 * and delete the registration so it can't start a new authorization.
 */
export async function revokeMcpClient(
  env: Env,
  origin: string,
  db: Db,
  clientId: string,
  actor: { organizationId: string; email: string },
): Promise<boolean> {
  const row = (await db.select().from(mcpClients).where(eq(mcpClients.clientId, clientId)).limit(1))[0];
  if (!row) return false;
  await db.update(mcpClients).set({ revokedAt: new Date() }).where(eq(mcpClients.clientId, clientId));

  const api = oauthApi(env, origin);
  if (row.agentId) {
    let cursor: string | undefined;
    do {
      const page = await api.listUserGrants(row.agentId, { cursor });
      for (const grant of page.items) {
        if (grant.clientId === clientId) await api.revokeGrant(grant.id, row.agentId);
      }
      cursor = page.cursor;
    } while (cursor);
  }
  await api.deleteClient(clientId);

  await writeAudit(db, {
    organizationId: actor.organizationId,
    actorType: "user",
    actorId: actor.email,
    action: "mcp_client.revoked",
    targetType: "mcp_client",
    targetId: clientId,
    metadata: { agentId: row.agentId },
  });
  return true;
}

/** /api/orgs/:orgId/mcp-clients: the owner's list of MCP clients, with revoke. */
export const mcpClientRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember, requireOrgAdmin)

  .get("/", async (c) => {
    const rows = await c
      .get("db")
      .select({
        clientId: mcpClients.clientId,
        name: mcpClients.name,
        redirectUris: mcpClients.redirectUris,
        agentId: mcpClients.agentId,
        agentName: agents.name,
        approvedAt: mcpClients.approvedAt,
        approvedBy: mcpClients.approvedBy,
        revokedAt: mcpClients.revokedAt,
        lastSeenAt: mcpClients.lastSeenAt,
        createdAt: mcpClients.createdAt,
        organizationId: agents.organizationId,
      })
      .from(mcpClients)
      .leftJoin(agents, eq(mcpClients.agentId, agents.id))
      .orderBy(desc(mcpClients.createdAt));
    const orgId = c.get("orgId");
    return c.json({
      clients: rows
        .filter((r) => r.organizationId === null || r.organizationId === orgId)
        .map(({ organizationId: _org, ...r }) => r),
    });
  })

  .post("/:clientId/revoke", async (c) => {
    const db = c.get("db");
    const clientId = c.req.param("clientId");
    const owned = await db
      .select({ organizationId: agents.organizationId })
      .from(mcpClients)
      .leftJoin(agents, eq(mcpClients.agentId, agents.id))
      .where(eq(mcpClients.clientId, clientId))
      .limit(1);
    const orgId = c.get("orgId");
    if (!owned[0] || (owned[0].organizationId !== null && owned[0].organizationId !== orgId)) {
      return c.json({ error: { code: "not_found", message: "No such client" } }, 404);
    }
    await revokeMcpClient(c.env, publicOrigin(c.env, c.req.raw), db, clientId, {
      organizationId: orgId,
      email: c.get("user").email,
    });
    return c.json({ ok: true });
  });
