import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { addresses, aiSettings, domains } from "@boxox/db";
import { z } from "zod";
import { requireSession, type AppContext } from "../middleware";
import { cfError, consentScreen, processingUpdateSchema, updateProcessing } from "../services/processing";
import { capabilities } from "../services/capabilities";
import type { Env } from "../env";

const ORG_ID = "default";
const addressChoice = z.object({ aiDisabled: z.boolean() }).strict();

async function settings(db: AppContext["Variables"]["db"], env: Env) {
  const row = await db.query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) });
  const mailboxes = await db.select({ id: addresses.id, localPart: addresses.localPart, domain: domains.name, aiDisabled: addresses.aiOptOut })
    .from(addresses).innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(eq(addresses.organizationId, ORG_ID)).orderBy(asc(domains.name), asc(addresses.localPart));
  return {
    ...consentScreen(),
    capabilities: capabilities(env),
    processing: {
      localFilters: row?.localFilters ?? null, reputationLookups: row?.reputationLookups ?? null,
      ai: row?.ai ?? null, provider: row?.provider ?? null, ownerRules: row?.ownerRules ?? [],
      dailyBudgetMicros: row?.dailyBudgetMicros ?? 1_000_000, onlyWhenUncertain: row?.onlyWhenUncertain ?? true,
    },
    tokenConfigured: !!env.CF_API_TOKEN && !!env.CF_ACCOUNT_ID,
    addresses: mailboxes.map((a) => ({ id: a.id, email: `${a.localPart}@${a.domain}`, aiDisabled: a.aiDisabled })),
  };
}

/** Processing remains editable after setup; no domain/setup operations are mounted here. */
export function createSettingsRoutes(opts: { fetch?: typeof fetch } = {}) {
  return new Hono<AppContext>()
    .use("*", requireSession)
    .use("*", async (c, next) => {
      if (c.get("user").role !== "owner") return c.json({ error: { code: "forbidden", message: "Only the owner can change mail processing." } }, 403);
      await next();
    })
    .get("/processing", async (c) => c.json(await settings(c.get("db"), c.env)))
    .patch("/processing", async (c) => {
      const parsed = processingUpdateSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: { code: "bad_request", message: "Use on/off choices, up to 20 rules of 500 characters, and a daily budget from $0 to $1,000." } }, 400);
      try {
        const warnings = await updateProcessing(c.get("db"), c.env, parsed.data, opts.fetch);
        return c.json({ ...await settings(c.get("db"), c.env), warnings });
      } catch (error) {
        const e = cfError(error);
        return c.json(e.body, e.status);
      }
    })
    .patch("/processing/addresses/:addressId", async (c) => {
      const parsed = addressChoice.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: { code: "bad_request", message: "Expected { aiDisabled: true or false }." } }, 400);
      const changed = await c.get("db").update(addresses)
        .set({ aiOptOut: parsed.data.aiDisabled, updatedAt: new Date() })
        .where(and(eq(addresses.id, c.req.param("addressId")), eq(addresses.organizationId, ORG_ID)))
        .returning({ id: addresses.id, aiDisabled: addresses.aiOptOut });
      if (!changed[0]) return c.json({ error: { code: "not_found", message: "No such address." } }, 404);
      return c.json(changed[0]);
    });
}

export const settingsRoutes = createSettingsRoutes();
