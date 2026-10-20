import { and, eq } from "drizzle-orm";
import { domains } from "@boxox/db";
import { z } from "zod";
import type { Context } from "hono";
import type { AppContext } from "../middleware";
import { writeAudit } from "../audit";
import { isFree } from "./capabilities";
import { bad, cfError } from "./processing";
import { cloudflareClient, type CloudflareClient, type DnsRecord, type Zone } from "./cloudflare";

const onboardSchema = z.object({
  domain: z.string().trim().toLowerCase().min(3).max(253),
  receive: z.boolean(),
  confirmMxReplacement: z.boolean().optional(),
});

const isDmarc = (r: DnsRecord) => /^"?v=DMARC1/i.test(r.content);

/**
 * What switching a domain would change: the apex MX records (replaced by
 * Email Routing) and any existing DMARC record (which sending onboarding keeps,
 * per the email spike). Read before anything is changed.
 */
export async function domainPreview(cf: CloudflareClient, zone: Zone) {
  const [mx, dmarcTxt, plan, routing] = await Promise.all([
    cf.listDnsRecords(zone.id, { type: "MX", name: zone.name }),
    cf.listDnsRecords(zone.id, { type: "TXT", name: `_dmarc.${zone.name}` }),
    cf.planMxReplacement(zone),
    cf.getRoutingSettings(zone.id).catch(() => null),
  ]);
  const dmarc = dmarcTxt.filter(isDmarc);
  const show = (r: DnsRecord) => ({ name: r.name, type: r.type, content: r.content, priority: r.priority ?? null });
  return {
    zone,
    mx: mx.filter((r) => r.name === zone.name).map(show),
    dmarc: dmarc.map(show),
    foreignSpf: plan.foreignSpf ? show(plan.foreignSpf) : null,
    routingEnabled: routing?.enabled ?? false,
    mxWarning: plan.warning,
    dmarcWarning: dmarc.length
      ? `${zone.name} already has a DMARC record (${dmarc[0]!.content}). Box Ox keeps it; check it allows mail sent through Cloudflare (SPF and DKIM on cf-bounce.${zone.name}).`
      : null,
    needsConfirmation: plan.foreignMx.length > 0 || !!plan.foreignSpf,
  };
}

/** Shared by initial setup and the admin-only Domains screen. */
export async function onboardDomain(c: Context<AppContext>, fetcher: typeof fetch, orgId: string, suppliedClient?: CloudflareClient) {
  const parsed = onboardSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(bad("Expected { domain, receive, confirmMxReplacement? }"), 400);
  const { domain, receive, confirmMxReplacement } = parsed.data;
  const sendingEnabled = !isFree(c.env);
  if (!sendingEnabled && !receive) return c.json(bad("The Free profile receives mail only. Select receiving to connect this domain.", "receiving_required"), 400);
  const db = c.get("db");
  const client = suppliedClient ?? cloudflareClient(c.env, fetcher);
  try {
    const result = await client.onboardZone(domain, { routing: receive, confirmMxReplacement, sending: sendingEnabled });
    if (result.status === "needs-confirmation") {
      // Nothing has changed yet: show what would be replaced and ask.
      return c.json(
        {
          ...bad(result.plan.warning ?? `Turning on routing changes the DNS of ${domain}.`, "mx_confirmation_required"),
          preview: await domainPreview(client, result.zone),
        },
        409,
      );
    }

    const warnings: string[] = [];
    if (receive) {
      await client.setCatchAllToWorker(result.zone.id, c.env.WORKER_NAME ?? "boxox");
      await client.setSubaddressing(result.zone.id, true);
      if (result.routing?.status !== "ready") {
        warnings.push(
          `Email Routing for ${domain} is "${result.routing?.status ?? "unknown"}", not ready yet. Wait for it before testing inbound mail.`,
        );
      }
    }
    let subscriptionId: string | null = null;
    if (sendingEnabled) {
    const queue = await client.findQueue(c.env.EVENTS_QUEUE ?? "cf-email-events");
    const subscription = await client.subscribeDeliveryEvents({
      zoneId: result.zone.id,
      domain: result.zone.name,
      queueId: queue.queue_id,
    });

    subscriptionId = subscription.id;
    }

    const status = receive ? (result.routing?.status ?? "pending") : "sending-only";
    const existing = await db.query.domains.findFirst({
      where: and(eq(domains.organizationId, orgId), eq(domains.name, result.zone.name)),
    });
    const now = new Date();
    let domainId = existing?.id;
    if (existing) {
      await db
        .update(domains)
        .set({
          status,
          sendingEnabled,
          receivingEnabled: existing.receivingEnabled || receive,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(domains.id, existing.id));
    } else {
      domainId = crypto.randomUUID();
      await db.insert(domains).values({
        id: domainId,
        organizationId: orgId,
        name: result.zone.name,
        status,
        sendingEnabled,
        receivingEnabled: receive,
        lastSyncedAt: now,
      });
    }
    await writeAudit(db, {
      organizationId: orgId,
      actorType: "user",
      actorId: c.get("user").id,
      action: "domain.reconfigured",
      targetType: "domain",
      targetId: domainId,
      metadata: {
        domain: result.zone.name,
        receive,
        removedMx: result.removedMx.map((r) => `${r.content} (${r.priority ?? 0})`),
        replacedSpf: result.replacedSpf ? { from: result.replacedSpf.from, to: result.replacedSpf.to } : null,
      },
    });

    return c.json({
      domain: { id: domainId, name: result.zone.name, status, sendingEnabled, receivingEnabled: existing?.receivingEnabled || receive },
      routingStatus: result.routing?.status ?? null,
      sending: result.sending ? { returnPathDomain: result.sending.return_path_domain, dkimSelector: result.sending.dkim_selector } : null,
      subscriptionId,
      removedMx: result.removedMx.map((r) => ({ content: r.content, priority: r.priority ?? null })),
      replacedSpf: result.replacedSpf,
      warnings,
    });
  } catch (err) {
    const e = cfError(err);
    return c.json(e.body, e.status);
  }

}
