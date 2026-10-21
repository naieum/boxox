import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { domains } from "@boxox/db";
import type { AppContext } from "../middleware";
import { checkDomainHealth } from "../services/domain-health";

/**
 * Public DNS/configuration status only. Never return addresses, mail, or credentials.
 * (The sibling GET /health in app.ts publishes BUILD_SHA on purpose: the source is
 * public, and installers compare it against the release they deployed.)
 */
export function createPublicDomainHealthRoutes(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  return new Hono<AppContext>().get("/", async (c) => {
    const cached = await c.env.KV.get("public-domain-health", "json") as Record<string, string> | null;
    if (cached) return c.json(cached, 200, { "cache-control": "public, max-age=60" });
    const rows = await c.get("db").select().from(domains)
      .where(and(eq(domains.organizationId, "default"), eq(domains.active, true)));
    const status: Record<string, string> = Object.create(null);
    // Serial domains bound the number of simultaneous DNS requests.
    for (const domain of rows) {
      const health = await checkDomainHealth(domain.name, { receiving: domain.receivingEnabled }, fetcher);
      status[domain.name] = domain.sendingEnabled && domain.receivingEnabled
        && domain.status === "ready" && health.healthy ? "healthy" : "degraded";
    }
    await c.env.KV.put("public-domain-health", JSON.stringify(status), { expirationTtl: 60 });
    return c.json(status, 200, { "cache-control": "public, max-age=60" });
  });
}

export const publicDomainHealthRoutes = createPublicDomainHealthRoutes();
