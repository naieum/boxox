import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  addressGrants,
  addresses,
  agentPairingCodes,
  agents,
  auditEvents,
  domains,
} from "@boxox/db";
import { agentCreateSchema, agentPatchSchema } from "@boxox/shared";
import { writeAudit } from "../audit";
import { batch, type Db } from "../db";
import { requireOrgAdmin, requireOrgMember, type AppContext } from "../middleware";
import {
  generateClientId,
  generatePairingCode,
  sha256Hex,
} from "../services/agent-auth";
import { agentsKilled, setAgentsKilled } from "../services/agent-policy";

/**
 * Session-side agent management. Mounted under /api/orgs/:orgId/agents (already
 * behind requireSession); every route additionally requires org membership and
 * admin role.
 *
 * Codes and secrets never enter audit metadata or the console.
 */

const PAIRING_TTL_MS = 15 * 60 * 1000;

const sendCap = z.number().int().min(0).max(100_000).nullable().optional();
const patchSchema = agentPatchSchema.extend({ sendHourlyCap: sendCap, sendDailyCap: sendCap });
const killSwitchSchema = z.object({ disabled: z.boolean() });

export const agentsRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember, requireOrgAdmin)

  // The kill switch for every agent at once (per agent: PATCH status=disabled).
  .get("/kill-switch", async (c) => c.json({ disabled: await agentsKilled(c.get("db")) }))

  .put("/kill-switch", async (c) => {
    const parsed = killSwitchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: "disabled must be a boolean" } }, 400);
    }
    const db = c.get("db");
    await setAgentsKilled(db, parsed.data.disabled);
    await writeAudit(db, {
      organizationId: c.get("orgId"),
      actorType: "user",
      actorId: c.get("user").id,
      action: parsed.data.disabled ? "agents.disabled" : "agents.enabled",
    });
    return c.json({ disabled: parsed.data.disabled });
  })

  // The audit view: what agents did, newest first, optionally for one agent.
  .get("/audit", async (c) => {
    const db = c.get("db");
    const agentId = c.req.query("agentId");
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, c.get("orgId")),
          eq(auditEvents.actorType, "agent"),
          agentId ? eq(auditEvents.actorId, agentId) : undefined,
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    return c.json({
      events: rows.map((e) => ({
        id: e.id,
        agentId: e.actorId,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  })

  // Create an agent. client_id is assigned now and stable for life.
  .post("/", async (c) => {
    const parsed = agentCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid agent" } },
        400,
      );
    }
    const db = c.get("db");
    const orgId = c.get("orgId");
    const actor = c.get("user");


    const { name, description, addressId, permissions } = parsed.data;

    // Validate the optional initial grant target belongs to this org.
    let grantAddressId: string | null = null;
    if (addressId) {
      const arow = await db
        .select({ id: addresses.id })
        .from(addresses)
        .where(and(eq(addresses.id, addressId), eq(addresses.organizationId, orgId)))
        .limit(1);
      if (!arow[0]) {
        return c.json({ error: { code: "not_found", message: "No such address" } }, 404);
      }
      grantAddressId = arow[0].id;
    }

    const agentId = crypto.randomUUID();
    const clientId = generateClientId();
    const grantId = crypto.randomUUID();

    await batch(db, [
      db.insert(agents).values({
        id: agentId,
        organizationId: orgId,
        name,
        description: description ?? null,
        status: "active",
        clientId,
        createdBy: actor.id,
      }),
      ...(grantAddressId
        ? [
            db.insert(addressGrants).values({
              id: grantId,
              addressId: grantAddressId,
              organizationId: orgId,
              principalType: "agent" as const,
              principalId: agentId,
              permissions,
              createdBy: actor.id,
            }),
          ]
        : []),
    ]);

    await writeAudit(db, {
      organizationId: orgId,
      actorType: "user",
      actorId: actor.id,
      action: "agent.created",
      targetType: "agent",
      targetId: agentId,
      metadata: { name, clientId, addressId: grantAddressId, permissions },
    });
    if (grantAddressId) {
      await writeAudit(db, {
        organizationId: orgId,
        actorType: "user",
        actorId: actor.id,
        action: "grant.added",
        targetType: "address",
        targetId: grantAddressId,
        metadata: { principalType: "agent", agentId, permissions },
      });
    }

    return c.json({
      agent: {
        id: agentId,
        name,
        description: description ?? null,
        status: "active",
        clientId,
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
        grants: grantAddressId
          ? [{ id: grantId, addressId: grantAddressId, permissions }]
          : [],
      },
    });
  })

  // List agents with their granted addresses.
  .get("/", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const agentRows = await db
      .select()
      .from(agents)
      .where(eq(agents.organizationId, orgId))
      .orderBy(desc(agents.createdAt));

    const grantRows = await db
      .select({
        id: addressGrants.id,
        addressId: addressGrants.addressId,
        agentId: addressGrants.principalId,
        permissions: addressGrants.permissions,
        localPart: addresses.localPart,
        domainName: domains.name,
      })
      .from(addressGrants)
      .innerJoin(addresses, eq(addressGrants.addressId, addresses.id))
      .innerJoin(domains, eq(addresses.domainId, domains.id))
      .where(
        and(eq(addressGrants.organizationId, orgId), eq(addressGrants.principalType, "agent")),
      );

    const byAgent = new Map<string, typeof grantRows>();
    for (const g of grantRows) {
      if (!g.agentId) continue;
      const list = byAgent.get(g.agentId) ?? [];
      list.push(g);
      byAgent.set(g.agentId, list);
    }

    return c.json({
      agents: agentRows.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        status: a.status,
        clientId: a.clientId,
        paired: a.clientSecretHash !== null,
        sendHourlyCap: a.sendHourlyCap,
        sendDailyCap: a.sendDailyCap,
        createdAt: a.createdAt.toISOString(),
        lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        grants: (byAgent.get(a.id) ?? []).map((g) => ({
          id: g.id,
          addressId: g.addressId,
          email: `${g.localPart}@${g.domainName}`,
          permissions: (g.permissions as string[]) ?? [],
        })),
      })),
    });
  })

  // Rename / enable / disable.
  .patch("/:agentId", async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: "Invalid patch" } }, 400);
    }
    const db = c.get("db");
    const orgId = c.get("orgId");
    const agentId = c.req.param("agentId");

    const current = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.organizationId, orgId)))
      .limit(1);
    if (!current[0]) {
      return c.json({ error: { code: "not_found", message: "No such agent" } }, 404);
    }

    const patch: Partial<typeof agents.$inferInsert> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.sendHourlyCap !== undefined) patch.sendHourlyCap = parsed.data.sendHourlyCap;
    if (parsed.data.sendDailyCap !== undefined) patch.sendDailyCap = parsed.data.sendDailyCap;
    if (Object.keys(patch).length === 0) {
      return c.json({ error: { code: "bad_request", message: "Nothing to change" } }, 400);
    }

    await db
      .update(agents)
      .set(patch)
      .where(and(eq(agents.id, agentId), eq(agents.organizationId, orgId)));

    const statusChanged =
      parsed.data.status !== undefined && parsed.data.status !== current[0].status;
    const action = statusChanged
      ? parsed.data.status === "disabled"
        ? "agent.disabled"
        : "agent.enabled"
      : "agent.updated";
    await writeAudit(db, {
      organizationId: orgId,
      actorType: "user",
      actorId: c.get("user").id,
      action,
      targetType: "agent",
      targetId: agentId,
      metadata: { name: parsed.data.name, status: parsed.data.status },
    });
    if (parsed.data.sendHourlyCap !== undefined || parsed.data.sendDailyCap !== undefined) {
      await writeAudit(db, {
        organizationId: orgId,
        actorType: "user",
        actorId: c.get("user").id,
        action: "agent.caps_updated",
        targetType: "agent",
        targetId: agentId,
        metadata: { sendHourlyCap: parsed.data.sendHourlyCap, sendDailyCap: parsed.data.sendDailyCap },
      });
    }

    return c.json({ ok: true });
  })

  // Delete agent + its grants in one transaction (pairing codes cascade via FK).
  .delete("/:agentId", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const agentId = c.req.param("agentId");

    const current = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.organizationId, orgId)))
      .limit(1);
    if (!current[0]) {
      return c.json({ error: { code: "not_found", message: "No such agent" } }, 404);
    }

    await batch(db, [
      db
        .delete(addressGrants)
        .where(
          and(
            eq(addressGrants.organizationId, orgId),
            eq(addressGrants.principalType, "agent"),
            eq(addressGrants.principalId, agentId),
          ),
        ),
      db.delete(agents).where(and(eq(agents.id, agentId), eq(agents.organizationId, orgId))),
    ]);

    await writeAudit(db, {
      organizationId: orgId,
      actorType: "user",
      actorId: c.get("user").id,
      action: "agent.deleted",
      targetType: "agent",
      targetId: agentId,
      metadata: { name: current[0].name },
    });

    return c.json({ ok: true });
  })

  // Rotate the pairing code: invalidate unused codes, mint a new 15-minute code,
  // return the plaintext exactly once (hashed at rest).
  .post("/:agentId/pairing-code", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const actor = c.get("user");
    const agentId = c.req.param("agentId");


    const current = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.organizationId, orgId)))
      .limit(1);
    if (!current[0]) {
      return c.json({ error: { code: "not_found", message: "No such agent" } }, 404);
    }
    if (current[0].status !== "active") {
      return c.json({ error: { code: "agent_disabled", message: "Enable the agent first" } }, 409);
    }

    // Invalidate any outstanding unused codes for this agent.
    await db
      .update(agentPairingCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(agentPairingCodes.agentId, agentId), isNull(agentPairingCodes.usedAt)));

    const code = generatePairingCode();
    const codeHash = await sha256Hex(code);
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await db.insert(agentPairingCodes).values({
      id: crypto.randomUUID(),
      agentId,
      codeHash,
      expiresAt,
      createdBy: actor.id,
    });

    await writeAudit(db, {
      organizationId: orgId,
      actorType: "user",
      actorId: actor.id,
      action: "agent.pairing_code_rotated",
      targetType: "agent",
      targetId: agentId,
      metadata: { expiresAt: expiresAt.toISOString() },
    });

    return c.json({ code, expiresAt: expiresAt.toISOString() });
  });
