import { isFree } from "../services/capabilities";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { addressGrants, addresses, domains, threads } from "@boxox/db";
import {
  addressCreateSchema,
  domainPatchSchema,
  generateLocalPart,
} from "@boxox/shared";
import { z } from "zod";
import { writeAudit } from "../audit";
import { log } from "../log";
import { requireOrgAdmin, requireOrgMember, requireOwner, type AppContext } from "../middleware";
import { cloudflareClient, CloudflareApiError, TokenNotConfiguredError } from "../services/cloudflare";

import { domainPreview, onboardDomain } from "../services/domain-onboarding";
import { cfError } from "../services/processing";
import { connectDomainAccount, disconnectDomainAccount, domainConnection, domainTokenSchema } from "../services/domain-connection";
import { cloudflareOAuthConfigured, disconnectCloudflareOAuth, startCloudflareOAuth } from "../services/cloudflare-oauth";

const domainActiveSchema = z.object({ active: z.boolean() });

import { monitorDomain } from "../services/domain-monitor";
export { checkDomainHealth, DOH_URL } from "../services/domain-health";
export type { HealthStatus, HealthCheck, DomainHealth } from "../services/domain-health";

/** True when a D1 insert hit a UNIQUE constraint; drizzle wraps the error, so check the cause too. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { message?: string; cause?: { message?: string } };
  return [e?.message, e?.cause?.message].some((m) => m?.includes("UNIQUE constraint failed"));
}

export const createDomainRoutes = (fetcher: typeof fetch = (input, init) => fetch(input, init)) =>
    new Hono<AppContext>()
    .use("*", requireOrgMember)
    .use("*", async (c, next) => { c.header("cache-control", "no-store, private"); await next(); })

    .post("/connection", requireOwner, async (c) => {
      const parsed = z.object({ token: domainTokenSchema }).safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: { code: "bad_request", message: "Enter a valid Cloudflare API token." } }, 400);
      if (!c.env.CF_ACCOUNT_ID || !c.env.BOXOX_SIGNING_SECRET) return c.json({ error: { code: "not_configured", message: "This installation needs its account and signing secret configured before connecting Cloudflare." } }, 503);
      try {
        // Read-only: connection never changes a zone or mail records.
        await cloudflareClient({ ...c.env, CF_API_TOKEN: parsed.data.token }, fetcher).listZones();
        const expiresAt = await connectDomainAccount(c, parsed.data.token);
        return c.json({ ok: true, expiresAt });
      } catch {
        return c.json({ error: { code: "cloudflare_connection_failed", message: "Cloudflare could not authorize this token. Check its account, zone access, and Zone Read permission." } }, 400);
      }
    })
    .post("/connection/oauth", requireOwner, startCloudflareOAuth)
    .delete("/connection", requireOwner, async (c) => {
      disconnectDomainAccount(c);
      await disconnectCloudflareOAuth(c, fetcher);
      return c.json({ ok: true });
    })

    // Initial setup and later domain additions share the same guarded onboarding service.
    // Owner only: the sidebar fetches this for the owner alone, and members
    // learn their domains from /addresses, which is filtered to their grants.
    .get("/", requireOrgAdmin, async (c) => {
      const db = c.get("db");
      const orgId = c.get("orgId");
      const rows = await db
        .select()
        .from(domains)
        .where(eq(domains.organizationId, orgId))
        .orderBy(asc(domains.name));
      const counts = await db
        .select({ domainId: addresses.domainId, n: sql<number>`count(*)` })
        .from(addresses)
        .where(eq(addresses.organizationId, orgId))
        .groupBy(addresses.domainId);
      const byDomain = new Map(counts.map((r) => [r.domainId, r.n]));
      return c.json({
        domains: rows.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
          region: d.region,
          active: d.active,
          unknownMailPolicy: d.unknownMailPolicy,
          catchAllAddressId: d.catchAllAddressId,
          addressCount: byDomain.get(d.id) ?? 0,
          lastSyncedAt: d.lastSyncedAt?.toISOString() ?? null,
          sendingEnabled: d.sendingEnabled,
          receivingEnabled: d.receivingEnabled,
          health: d.health,
          healthCheckedAt: d.healthCheckedAt?.toISOString() ?? null,
        })),
      });
    })

    // Zones the token can see in this account, marked when already onboarded.
    .get("/zones", requireOrgAdmin, async (c) => {
      const connection = await domainConnection(c, fetcher);
      const cf = cloudflareClient(connection.env, fetcher);
      if (!cf.configured) return c.json({ configured: false, zones: [], ...(cloudflareOAuthConfigured(c.env) ? { oauthAvailable: true } : {}) });
      try {
      const zones = await cf.listZones();
      const onboarded = await c
        .get("db")
        .select({ name: domains.name })
        .from(domains)
        .where(eq(domains.organizationId, c.get("orgId")));
      const names = new Set(onboarded.map((d) => d.name));
      return c.json({
        configured: true,
        oauthAvailable: cloudflareOAuthConfigured(c.env),
        connection: { temporary: connection.expiresAt !== null, expiresAt: connection.expiresAt, oauth: !!connection.oauth },
        zones: zones
          .map((z) => ({ id: z.id, name: z.name, status: z.status, onboarded: names.has(z.name) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
      } catch (err) {
        if (connection.oauth && err instanceof CloudflareApiError && (err.status === 401 || err.status === 403)) {
          return c.json({ configured: false, oauthAvailable: true, zones: [], connectionError: "Cloudflare access needs approval again. Reconnect to continue." });
        }
        const e = cfError(err); return c.json(e.body, e.status);
      }
    })

    .get("/zones/:domain/preview", requireOrgAdmin, async (c) => {
      try {
        const cf = cloudflareClient((await domainConnection(c, fetcher)).env, fetcher);
        if (!cf.configured) return c.json({ error: { code: "cloudflare_not_connected", message: "Connect Cloudflare from Add domain, then review this domain again." } }, 409);
        return c.json(await domainPreview(cf, await cf.findZone(c.req.param("domain").toLowerCase())));
      } catch (err) {
        const e = cfError(err);
        return c.json(e.body, e.status);
      }
    })

    .post("/onboard", requireOrgAdmin, async (c) => {
      const cf = cloudflareClient((await domainConnection(c, fetcher)).env, fetcher);
      if (!cf.configured) return c.json({ error: { code: "cloudflare_not_connected", message: "Your Cloudflare connection expired. Reconnect from Add domain before applying changes." } }, 409);
      return onboardDomain(c, fetcher, c.get("orgId"), cf);
    })

    // Account-wide Email Sending quota; new accounts start in a small sandbox quota.
    // Owner only: this reaches the Cloudflare API with the owner's credentials.
    .get("/quota", requireOrgAdmin, async (c) => {
      if (isFree(c.env)) return c.json({ configured: false });
      const cf = cloudflareClient((await domainConnection(c, fetcher)).env, fetcher);
      if (!cf.configured) return c.json({ configured: false });
      const { quota, usage } = await cf.getSendingLimits();
      return c.json({
        configured: true,
        limit: quota.value,
        unit: quota.unit,
        sent: usage.sent,
        remaining: Math.max(0, quota.value - usage.sent),
        overQuota: usage.over_quota,
        resetsAt: usage.resets_at,
      });
    })

    // Runs the DNS health check now and stores the result on the domain. Owner
    // only: it spends DNS and Cloudflare API calls under the owner's credentials.
    .post("/:domainId/health", requireOrgAdmin, async (c) => {
      const db = c.get("db");
      const orgId = c.get("orgId");
      const domainId = c.req.param("domainId");
      const [domain] = await db
        .select()
        .from(domains)
        .where(and(eq(domains.id, domainId), eq(domains.organizationId, orgId)))
        .limit(1);
      if (!domain) {
        return c.json({ error: { code: "not_found", message: "No such domain" } }, 404);
      }

      // The real selector and return path when the token is around; Email Sending's defaults otherwise.
      let sending: { selector?: string; returnPath?: string } = {};
      const cf = cloudflareClient((await domainConnection(c, fetcher)).env, fetcher);
      if (cf.configured && domain.sendingEnabled) {
        try {
          const zone = await cf.findZone(domain.name);
          const sub = (await cf.listSendingSubdomains(zone.id)).find((s) => s.name === domain.name);
          if (sub) sending = { selector: sub.dkim_selector, returnPath: sub.return_path_domain };
        } catch (err) {
          if (!(err instanceof TokenNotConfiguredError)) {
            log.warn("domain_health_cf_lookup_failed", { domain: domain.name, error: err });
          }
        }
      }

      const health = await monitorDomain(db, c.env, domain, fetcher, sending);
      return c.json(health);
    })

    // Inactive domains hold inbound mail instead of delivering it.
    .patch("/:domainId/active", requireOrgAdmin, async (c) => {
      const parsed = domainActiveSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: { code: "bad_request", message: "Expected { active: boolean }" } }, 400);
      }
      const db = c.get("db");
      const orgId = c.get("orgId");
      const domainId = c.req.param("domainId");
      const { active } = parsed.data;

      const updated = await db
        .update(domains)
        .set({ active, updatedAt: new Date() })
        .where(and(eq(domains.id, domainId), eq(domains.organizationId, orgId)))
        .returning({ name: domains.name });
      const domain = updated[0];
      if (!domain) {
        return c.json({ error: { code: "not_found", message: "No such domain" } }, 404);
      }

      await writeAudit(db, {
        organizationId: orgId,
        actorType: "user",
        actorId: c.get("user").id,
        action: active ? "domain.activated" : "domain.deactivated",
        targetType: "domain",
        targetId: domainId,
        metadata: { name: domain.name },
      });

      return c.json({ ok: true, active });
    })

    // Reconfigure catch-all.
    .patch("/:domainId", requireOrgAdmin, async (c) => {
      const parsed = domainPatchSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: { code: "bad_request", message: "Invalid domain patch" } }, 400);
      }
      const db = c.get("db");
      const orgId = c.get("orgId");
      const domainId = c.req.param("domainId");
      const updated = await db
        .update(domains)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(domains.id, domainId), eq(domains.organizationId, orgId)))
        .returning();
      if (!updated[0]) {
        return c.json({ error: { code: "not_found", message: "No such domain" } }, 404);
      }
      await writeAudit(db, {
        organizationId: orgId,
        actorType: "user",
        actorId: c.get("user").id,
        action: "domain.reconfigured",
        targetType: "domain",
        targetId: domainId,
        metadata: parsed.data,
      });
      return c.json({ ok: true });
    })

    // Addresses on a domain, with grants and unread counts.
    // Owner only: this lists every grantee's email and permissions and unread
    // counts for every mailbox, which a member must not be able to enumerate.
    .get("/:domainId/addresses", requireOrgAdmin, async (c) => {
      const db = c.get("db");
      const orgId = c.get("orgId");
      const domainId = c.req.param("domainId");
      const rows = await db
        .select()
        .from(addresses)
        .where(and(eq(addresses.domainId, domainId), eq(addresses.organizationId, orgId)))
        .orderBy(asc(addresses.localPart));
      const grants = await db
        .select({
          id: addressGrants.id,
          addressId: addressGrants.addressId,
          principalType: addressGrants.principalType,
          inviteEmail: addressGrants.inviteEmail,
          principalId: addressGrants.principalId,
          permissions: addressGrants.permissions,
        })
        .from(addressGrants)
        .where(eq(addressGrants.organizationId, orgId));
      const unread = await db
        .select({ addressId: threads.addressId, n: sql<number>`count(*)` })
        .from(threads)
        .where(and(eq(threads.organizationId, orgId), eq(threads.unread, true), eq(threads.folder, "inbox")))
        .groupBy(threads.addressId);
      const unreadBy = new Map(unread.map((r) => [r.addressId, r.n]));
      return c.json({
        addresses: rows.map((a) => ({
          id: a.id,
          localPart: a.localPart,
          kind: a.kind,
          displayName: a.displayName,
          status: a.status,
          expiresAt: a.expiresAt?.toISOString() ?? null,
          unread: unreadBy.get(a.id) ?? 0,
          grants: grants.filter((g) => g.addressId === a.id),
        })),
      });
    })

    // Mint an address on a domain.
    .post("/:domainId/addresses", requireOrgAdmin, async (c) => {
      const parsed = addressCreateSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid address" } }, 400);
      }
      const db = c.get("db");
      const orgId = c.get("orgId");
      const domainId = c.req.param("domainId");
      const domain = await db
        .select()
        .from(domains)
        .where(and(eq(domains.id, domainId), eq(domains.organizationId, orgId)))
        .limit(1);
      if (!domain[0]) {
        return c.json({ error: { code: "not_found", message: "No such domain" } }, 404);
      }
      const localPart =
        parsed.data.localPart && !parsed.data.generate
          ? parsed.data.localPart
          : generateLocalPart();
      const id = crypto.randomUUID();
      try {
        await db.insert(addresses).values({
          id,
          domainId,
          organizationId: orgId,
          localPart,
          kind: parsed.data.kind,
          displayName: parsed.data.displayName,
          expiresAt: null,
          createdBy: c.get("user").id,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return c.json(
            { error: { code: "taken", message: `${localPart}@${domain[0].name} already exists` } },
            409,
          );
        }
        throw err;
      }

      // Optional immediate person grant, keyed by the email Access will present.
      if (parsed.data.grantEmail) {
        const email = parsed.data.grantEmail.toLowerCase();
        await db.insert(addressGrants).values({
          id: crypto.randomUUID(),
          addressId: id,
          organizationId: orgId,
          principalType: "user",
          principalId: null,
          inviteEmail: email,
          permissions: ["read", "send"],
          createdBy: c.get("user").id,
        });
      }

      await writeAudit(db, {
        organizationId: orgId,
        actorType: "user",
        actorId: c.get("user").id,
        action: "address.created",
        targetType: "address",
        targetId: id,
        metadata: { address: `${localPart}@${domain[0].name}`, kind: parsed.data.kind },
      });
      return c.json({ id, localPart, domain: domain[0].name });
    });

export const domainRoutes = createDomainRoutes();
