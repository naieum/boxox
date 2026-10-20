import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { addressGrants, addresses, domains, threads } from "@boxox/db";
import { addressPatchSchema, grantCreateSchema } from "@boxox/shared";
import { writeAudit } from "../audit";
import { requireOrgAdmin, requireOrgMember, type AppContext } from "../middleware";
import { accessibleAddressIds } from "../services/access";

export const addressRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember)

  // Org-wide address list for the sidebar / From picker, scoped to the accessor.
  .get("/", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const accessor = {
      userId: c.get("user").id,
      email: c.get("user").email,
      role: c.get("orgRole"),
    };
    const readable = await accessibleAddressIds(db, orgId, accessor, "read");
    const sendable = await accessibleAddressIds(db, orgId, accessor, "send");

    const where =
      readable === null
        ? eq(addresses.organizationId, orgId)
        : and(
            eq(addresses.organizationId, orgId),
            inArray(addresses.id, readable.length ? readable : ["__none__"]),
          );
    const rows = await db
      .select({
        id: addresses.id,
        localPart: addresses.localPart,
        kind: addresses.kind,
        displayName: addresses.displayName,
        status: addresses.status,
        domainId: addresses.domainId,
        domainName: domains.name,
      })
      .from(addresses)
      .innerJoin(domains, eq(addresses.domainId, domains.id))
      .where(where)
      .orderBy(asc(domains.name), asc(addresses.localPart));

    const unread = await db
      .select({ addressId: threads.addressId, n: sql<number>`count(*)` })
      .from(threads)
      .where(
        and(
          eq(threads.organizationId, orgId),
          eq(threads.unread, true),
          eq(threads.folder, "inbox"),
        ),
      )
      .groupBy(threads.addressId);
    const unreadBy = new Map(unread.map((r) => [r.addressId, r.n]));

    // Unrouted mail is admin-visible only.
    let unroutedCount = 0;
    if (readable === null) {
      const held = await db
        .select({ n: sql<number>`count(*)` })
        .from(threads)
        .where(and(eq(threads.organizationId, orgId), eq(threads.folder, "unrouted")));
      unroutedCount = held[0]?.n ?? 0;
    }

    return c.json({
      unroutedCount,
      addresses: rows.map((a) => ({
        ...a,
        email: `${a.localPart}@${a.domainName}`,
        unread: unreadBy.get(a.id) ?? 0,
        canSend: sendable === null || sendable.includes(a.id),
      })),
    });
  })

  // Reconfigure an address (kind/status/displayName/expiry are all mutable).
  .patch("/:addressId", requireOrgAdmin, async (c) => {
    const parsed = addressPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: "Invalid address patch" } }, 400);
    }
    const db = c.get("db");
    const orgId = c.get("orgId");
    const addressId = c.req.param("addressId");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.kind !== undefined) patch.kind = parsed.data.kind;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.displayName !== undefined) patch.displayName = parsed.data.displayName;
    if (parsed.data.expiresAt !== undefined) {
      patch.expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    }
    const updated = await db
      .update(addresses)
      .set(patch)
      .where(and(eq(addresses.id, addressId), eq(addresses.organizationId, orgId)))
      .returning({ id: addresses.id });
    if (!updated[0]) {
      return c.json({ error: { code: "not_found", message: "No such address" } }, 404);
    }
    await writeAudit(db, {
      organizationId: orgId,
      actorType: "user",
      actorId: c.get("user").id,
      action: "address.reconfigured",
      targetType: "address",
      targetId: addressId,
      metadata: parsed.data as Record<string, unknown>,
    });
    return c.json({ ok: true });
  })

  // Attach a person by email.
  .post("/:addressId/grants", requireOrgAdmin, async (c) => {
    const parsed = grantCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: "Invalid grant" } }, 400);
    }
    const db = c.get("db");
    const orgId = c.get("orgId");
    const addressId = c.req.param("addressId");
    const addr = await db
      .select({ id: addresses.id })
      .from(addresses)
      .where(and(eq(addresses.id, addressId), eq(addresses.organizationId, orgId)))
      .limit(1);
    if (!addr[0]) {
      return c.json({ error: { code: "not_found", message: "No such address" } }, 404);
    }
    // Keyed by the email Access will present for that person.
    const email = parsed.data.email.toLowerCase();
    const id = crypto.randomUUID();
    await db.insert(addressGrants).values({
      id,
      addressId,
      organizationId: orgId,
      principalType: "user",
      principalId: null,
      inviteEmail: email,
      permissions: parsed.data.permissions,
      createdBy: c.get("user").id,
    });
    await writeAudit(db, {
      organizationId: orgId,
      actorType: "user",
      actorId: c.get("user").id,
      action: "grant.added",
      targetType: "address",
      targetId: addressId,
      metadata: { email, permissions: parsed.data.permissions },
    });
    return c.json({ id });
  })

  .delete("/:addressId/grants/:grantId", requireOrgAdmin, async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const deleted = await db
      .delete(addressGrants)
      .where(
        and(
          eq(addressGrants.id, c.req.param("grantId")),
          eq(addressGrants.addressId, c.req.param("addressId")),
          eq(addressGrants.organizationId, orgId),
        ),
      )
      .returning({ id: addressGrants.id, inviteEmail: addressGrants.inviteEmail });
    if (!deleted[0]) {
      return c.json({ error: { code: "not_found", message: "No such grant" } }, 404);
    }
    await writeAudit(db, {
      organizationId: orgId,
      actorType: "user",
      actorId: c.get("user").id,
      action: "grant.removed",
      targetType: "address",
      targetId: c.req.param("addressId"),
      metadata: { email: deleted[0].inviteEmail },
    });
    return c.json({ ok: true });
  });
