import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { appSettings, domains } from "@boxox/db";
import { z } from "zod";
import type { Env } from "../env";
import { capabilities, isFree } from "../services/capabilities";
import { log } from "../log";
import type { AppContext } from "../middleware";
import { onboardDomain, domainPreview } from "../services/domain-onboarding";
export { domainPreview } from "../services/domain-onboarding";
import { bad, cfError, consentScreen, missingChoices, processingSchema, processingState, updateProcessing } from "../services/processing";
export { consentScreen, estimateMonthlyUsd, missingChoices, PROCESSING_GROUPS, PROVIDERS } from "../services/processing";
import {
  CF_API_BASE,
  CloudflareApiError,
  cloudflareClient,
  TokenNotConfiguredError,
  type CloudflareClient,
  type Zone,
} from "../services/cloudflare";

/**
 * The /setup wizard's API (docs/v2-plan.md, "Owner setup", step 7): token
 * check, zones, onboarding with MX/DMARC warnings, the "How your mail is
 * processed" consent screen, and a test send. Once setup is finished these
 * endpoints refuse changes; later domains go through the Domains page.
 */

/** Single-tenant: one install is one organization (apps/web/src/config.ts). */
export const SETUP_ORG_ID = "default";
/** The Worker the catch-all points at and the queue delivery events go to (wrangler.jsonc). */
export const WORKER_NAME = "boxox";
export const EVENTS_QUEUE = "cf-email-events";
export const MAIL_BUCKET = "boxox-mail";

const testSendSchema = z.object({
  from: z.string().trim().toLowerCase().email(),
  to: z.string().trim().email(),
});

async function setupCompletedAt(db: AppContext["Variables"]["db"]): Promise<Date | null> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.id, 1) });
  return row?.setupCompletedAt ?? null;
}

/** Account-owned tokens verify under the account; user tokens under /user. */
async function verifyToken(env: Env, fetcher: typeof fetch): Promise<{ status: string; expires_on?: string }> {
  if (!env.CF_API_TOKEN) throw new TokenNotConfiguredError();
  const headers = { authorization: `Bearer ${env.CF_API_TOKEN}` };
  const paths = [
    ...(env.CF_ACCOUNT_ID ? [`/accounts/${env.CF_ACCOUNT_ID}/tokens/verify`] : []),
    "/user/tokens/verify",
  ];
  let last: CloudflareApiError | null = null;
  for (const path of paths) {
    const res = await fetcher(`${CF_API_BASE}${path}`, { headers });
    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: { status: string; expires_on?: string };
      errors?: { code: number; message: string }[];
    } | null;
    if (res.ok && json?.success && json.result) return json.result;
    last = new CloudflareApiError(`Token verification failed (HTTP ${res.status})`, res.status, json?.errors ?? []);
  }
  throw last!;
}

async function listZones(env: Env, fetcher: typeof fetch): Promise<Zone[]> {
  if (!env.CF_API_TOKEN) throw new TokenNotConfiguredError();
  if (!env.CF_ACCOUNT_ID) throw new TokenNotConfiguredError("CF_ACCOUNT_ID");
  const q = new URLSearchParams({ "account.id": env.CF_ACCOUNT_ID, per_page: "50", status: "active" });
  const res = await fetcher(`${CF_API_BASE}/zones?${q}`, {
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: Zone[];
    errors?: { code: number; message: string }[];
  } | null;
  if (!res.ok || !json?.success) {
    throw new CloudflareApiError(`Listing zones failed (HTTP ${res.status})`, res.status, json?.errors ?? []);
  }
  return (json.result ?? []).map((z) => ({ id: z.id, name: z.name, status: z.status }));
}

/** One permission probe: the call it needs, and whether it went through. */
async function probe(name: string, needs: string, call: () => Promise<unknown>) {
  try {
    await call();
    return { name, needs, ok: true as const };
  } catch (err) {
    const status = err instanceof CloudflareApiError ? err.status : 0;
    return { name, needs, ok: false as const, status };
  }
}

/**
 * `cf` lets tests inject a client backed by a fake Cloudflare API; production
 * builds one per request from the Worker secrets.
 */
export function createSetupRoutes(opts: { fetch?: typeof fetch } = {}) {
  const fetcher: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const cf = (env: Env) => cloudflareClient(env, fetcher);

  return (
    new Hono<AppContext>()
      .get("/", async (c) => {
        const db = c.get("db");
        const [completedAt, processing, rows] = await Promise.all([
          setupCompletedAt(db),
          processingState(db),
          db.select().from(domains).where(eq(domains.organizationId, SETUP_ORG_ID)),
        ]);
        return c.json({
          capabilities: capabilities(c.env),
          completed: !!completedAt,
          completedAt: completedAt?.toISOString() ?? null,
          tokenConfigured: !!c.env.CF_API_TOKEN && !!c.env.CF_ACCOUNT_ID,
          processing,
          missingChoices: missingChoices(isFree(c.env) ? { ...processing, ai: false } : processing),
          domains: rows.map((d) => ({
            id: d.id,
            name: d.name,
            status: d.status,
            sendingEnabled: d.sendingEnabled,
            receivingEnabled: d.receivingEnabled,
          })),
        });
      })

      // Changes are refused once setup is finished.
      .use("*", async (c, next) => {
        if (c.req.method !== "GET" && (await setupCompletedAt(c.get("db")))) {
          return c.json(bad("Setup is already finished. Manage domains and processing in Settings.", "setup_completed"), 409);
        }
        await next();
      })

      .get("/token", async (c) => {
        const env = c.env;
        if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
          return c.json({
            configured: false,
            message: "Set CF_API_TOKEN and CF_ACCOUNT_ID as Worker secrets (wrangler secret put), then reload.",
          });
        }
        let token: { status: string; expires_on?: string };
        try {
          token = await verifyToken(env, fetcher);
        } catch (err) {
          const e = cfError(err);
          return c.json({ configured: true, valid: false, ...e.body });
        }
        const client = cf(env);
        let limits: Awaited<ReturnType<CloudflareClient["getSendingLimits"]>> | null = null;
        const checks = await Promise.all([
          probe("zones", "Zone read", () => listZones(env, fetcher)),
          ...(!isFree(env) ? [probe("emailSending", "Email Sending edit", async () => {
            limits = await client.getSendingLimits();
          }),
          probe("queues", "Queues edit", () => client.findQueue(c.env.EVENTS_QUEUE ?? EVENTS_QUEUE)),
          probe("eventSubscriptions", "Queues edit (event subscriptions)", () => client.listEventSubscriptions()),
          ] : []),
          probe("r2", "R2 edit (lifecycle rules)", () => client.getBucketLifecycle(c.env.MAIL_BUCKET ?? MAIL_BUCKET)),
        ]);
        const quota = limits as Awaited<ReturnType<CloudflareClient["getSendingLimits"]>> | null;
        return c.json({
          configured: true,
          valid: token.status === "active",
          status: token.status,
          expiresOn: token.expires_on ?? null,
          checks,
          sending: quota
            ? {
                quotaPerDay: quota.quota.value,
                sentToday: quota.usage.sent,
                overQuota: quota.usage.over_quota,
                sandbox: quota.quota.value <= 1_000,
              }
            : null,
          advice: "After setup, you can remove CF_API_TOKEN (wrangler secret delete CF_API_TOKEN). Add it again to onboard more domains.",
        });
      })

      .get("/zones", async (c) => {
        try {
          return c.json({ zones: await listZones(c.env, fetcher) });
        } catch (err) {
          const e = cfError(err);
          return c.json(e.body, e.status);
        }
      })

      .get("/zones/:domain/preview", async (c) => {
        try {
          const client = cf(c.env);
          const zone = await client.findZone(c.req.param("domain").toLowerCase());
          return c.json(await domainPreview(client, zone));
        } catch (err) {
          const e = cfError(err);
          return c.json(e.body, e.status);
        }
      })

      .post("/domains", (c) => onboardDomain(c, fetcher, SETUP_ORG_ID))

      .get("/consent", async (c) => {
        return c.json({ ...consentScreen(), capabilities: capabilities(c.env), current: await processingState(c.get("db")) });
      })

      .put("/processing", async (c) => {
        const parsed = processingSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          return c.json(
            bad("Switch each group on or off: { localFilters, reputationLookups, ai } must each be true or false, with a provider when AI is on.", "processing_choice_required"),
            400,
          );
        }
        try {
          await updateProcessing(c.get("db"), c.env, parsed.data, fetcher);
          log.info("setup_processing_set", { ...parsed.data });
          return c.json({ processing: await processingState(c.get("db")) });
        } catch (err) {
          const e = cfError(err);
          return c.json(e.body, e.status);
        }
      })

      .post("/test-send", async (c) => {
        if (isFree(c.env)) return c.json(bad("Sending is unavailable in the Free inbox profile.", "feature_unavailable"), 403);
        const parsed = testSendSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json(bad("Expected { from, to } email addresses"), 400);
        const { from, to } = parsed.data;
        const db = c.get("db");
        const fromDomain = from.split("@")[1]!;
        const domain = await db.query.domains.findFirst({
          where: and(eq(domains.organizationId, SETUP_ORG_ID), eq(domains.name, fromDomain)),
        });
        if (!domain?.sendingEnabled) {
          return c.json(bad(`${fromDomain} isn't set up for sending yet. Onboard it first.`, "domain_not_onboarded"), 409);
        }
        try {
          const { messageId } = await c.env.EMAIL.send({
            from,
            to,
            subject: "Box Ox test email",
            text: `This is a test from your Box Ox setup, sent from ${from}.\n\nReply to it to check that receiving works too.`,
          });
          return c.json({
            messageId,
            note: "Delivery events arrive through the cf-email-events queue. No event within a few minutes means unknown, not delivered.",
          });
        } catch (err) {
          const code = (err as { code?: string }).code ?? "send_failed";
          log.warn("setup_test_send_failed", { code });
          return c.json(bad((err as Error).message || "Send failed", code), 502);
        }
      })

      .post("/complete", async (c) => {
        const db = c.get("db");
        const choices = await processingState(db);
        const missing = missingChoices(isFree(c.env) ? { ...choices, ai: false } : choices);
        if (missing.length) {
          return c.json(
            {
              ...bad("Choose on or off for each processing group before finishing setup.", "processing_choice_required"),
              missing,
            },
            409,
          );
        }
        const now = new Date();
        await db
          .insert(appSettings)
          .values({ id: 1, setupCompletedAt: now, updatedAt: now })
          .onConflictDoUpdate({ target: appSettings.id, set: { setupCompletedAt: now, updatedAt: now } });
        return c.json({
          completed: true,
          completedAt: now.toISOString(),
          advice: "You can now remove the Cloudflare API token: wrangler secret delete CF_API_TOKEN. The app works without it; add it again to onboard more domains.",
        });
      })
  );
}

export const setupRoutes = createSetupRoutes();
