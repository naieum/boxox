import { and, eq, inArray } from "drizzle-orm";
import { addresses, blockedSenders, domains } from "@boxox/db";
import { parseAddress, routeLocalPart } from "@boxox/shared";
import { createDb } from "./db";
import type { Env } from "./env";
import { log } from "./log";
import { recordIngestJob, submitIngest } from "./services/ingest-dispatch";

/** Thrown (not setReject) so the sending server backs off and retries later. */
export class InboundRateLimited extends Error {
  constructor() {
    super("inbound rate limit exceeded");
    this.name = "InboundRateLimited";
  }
}

/**
 * R2 key of a raw inbound message. It doubles as the IngestWorkflow instance
 * id, so it must match the id rules: [A-Za-z0-9_-], at most 100 characters.
 */
export function inboundRawKey(now: Date, uuid: string = crypto.randomUUID()): string {
  return `inbound-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${uuid}`;
}

/** "me+tag@Example.com" → { localPart: "me", domain: "example.com" }. */
export function splitRecipient(to: string): { localPart: string; domain: string } {
  const at = to.lastIndexOf("@");
  const local = to.slice(0, at).toLowerCase();
  return { localPart: local.split("+", 1)[0]!, domain: to.slice(at + 1).toLowerCase() };
}

/**
 * The envelope sender is often a VERP return path that changes per message,
 * so the From header identifies the sender for blocking and rate limits.
 */
function senderOf(message: Pick<ForwardableEmailMessage, "from" | "headers">): { header: string | null; envelope: string } {
  const header = parseAddress(message.headers.get("from") ?? "").email;
  return { header: header.includes("@") ? header : null, envelope: message.from.toLowerCase() };
}

type Verdict = { reject: string } | { accept: true };

/** The only SMTP-time rejections: blocked senders, and unknown addresses on drop domains. */
async function screen(env: Env, message: Pick<ForwardableEmailMessage, "to">, senders: string[]): Promise<Verdict> {
  const db = createDb(env);
  const { localPart, domain } = splitRecipient(message.to);
  const dom = await db.query.domains.findFirst({ where: eq(domains.name, domain) });
  if (!dom) return { accept: true };

  const blocked = await db
    .select({ id: blockedSenders.id })
    .from(blockedSenders)
    .where(and(eq(blockedSenders.organizationId, dom.organizationId), inArray(blockedSenders.email, senders)))
    .limit(1);
  if (blocked.length) return { reject: "550 5.7.1 Sender blocked by recipient" };

  // Inactive domains follow the hold policy, so only an active drop domain rejects.
  if (dom.active && dom.unknownMailPolicy === "drop") {
    const candidates = await db
      .select({ id: addresses.id, localPart: addresses.localPart, status: addresses.status, expiresAt: addresses.expiresAt })
      .from(addresses)
      .where(eq(addresses.domainId, dom.id));
    if (routeLocalPart(localPart, dom, candidates, new Date()).kind === "drop") {
      return { reject: "550 5.1.1 No such mailbox" };
    }
  }
  return { accept: true };
}

/**
 * Rate limit and screen, journal a staging job, store raw MIME, then mark the
 * job ready. Queue/Workflow outages do not bounce durable mail. An interrupted
 * R2-to-ready transition is recovered directly from the staging ledger.
 */
export async function handleEmail(message: Pick<ForwardableEmailMessage, "from" | "to" | "headers" | "raw" | "setReject">, env: Env): Promise<void> {
  const global = await env.INBOUND_GLOBAL_RATE_LIMIT.limit({ key: "all-inbound" });
  if (!global.success) {
    log.warn("inbound_global_rate_limited");
    throw new InboundRateLimited();
  }
  const { header, envelope } = senderOf(message);
  const sender = header ?? envelope;

  const { success } = await env.INBOUND_RATE_LIMIT.limit({ key: `sender:${sender}` });
  if (!success) {
    log.warn("inbound_rate_limited", { sender });
    throw new InboundRateLimited();
  }

  const verdict = await screen(env, message, [...new Set([sender, envelope])]);
  if ("reject" in verdict) {
    log.info("inbound_rejected", { to: message.to, sender, reason: verdict.reject });
    message.setReject(verdict.reject);
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  const receivedAt = new Date();
  const rawKey = inboundRawKey(receivedAt);
  // Journal first: a crash after R2 succeeds leaves a directly recoverable
  // staging row. A failed journal write asks SMTP to retry before saving MIME.
  await recordIngestJob(env, { rawKey, receivedAt: receivedAt.toISOString() }, receivedAt.getTime(), "staging");
  await env.MAIL_STORE.put(rawKey, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { to: message.to, from: envelope, ingestVersion: "2", receivedAt: receivedAt.toISOString() },
  });

  await submitIngest(env, { rawKey, receivedAt: receivedAt.toISOString() });
}
