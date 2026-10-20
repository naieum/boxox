import { isFree } from "../capabilities";
import { eq, sql } from "drizzle-orm";
import PostalMime from "postal-mime";
import { aiSettings, domains, messages, threads } from "@boxox/db";
import { createDb, type Db } from "../../db";
import type { Env } from "../../env";
import { kvBudgetStore } from "../ai";
import { MIME_LIMITS } from "../ingest/parse";
import { score } from "./bayes";
import { loadClassifierConfig } from "./classifier";
import { isBlockedSender, recordVerdict, scanMessage, type SenderHistory } from "./combine";
import { collectSignals, signalMailFrom } from "./signals-run";

/** Authoritative history: the reputation cache is not updated by every send/label path. */
async function historyFromMessages(db: Db, orgId: string, email: string): Promise<SenderHistory> {
  const recipient = sql`(
    EXISTS (SELECT 1 FROM json_each(m.to_emails) WHERE lower(value) = ${email}) OR
    EXISTS (SELECT 1 FROM json_each(m.cc_emails) WHERE lower(value) = ${email}) OR
    EXISTS (SELECT 1 FROM json_each(m.bcc_emails) WHERE lower(value) = ${email})
  )`;
  const row = await db.get<SenderHistory>(sql`
    SELECT
      coalesce(sum(m.direction = 'inbound' AND lower(m.from_email) = ${email}), 0) AS inbound,
      coalesce(sum(m.direction = 'outbound' AND ${recipient}), 0) AS outbound,
      coalesce(sum(m.direction = 'inbound' AND lower(m.from_email) = ${email} AND st.label = 'spam'), 0) AS spam,
      coalesce(sum(m.direction = 'inbound' AND lower(m.from_email) = ${email} AND st.label = 'ham'), 0) AS ham
    FROM messages m LEFT JOIN spam_training st ON st.message_id = m.id
    WHERE m.organization_id = ${orgId}
  `);
  return row ?? { inbound: 0, outbound: 0, spam: 0, ham: 0 };
}

async function knownContactsFromMessages(db: Db, orgId: string): Promise<string[]> {
  const rows = await db.all<{ email: string }>(sql`
    SELECT lower(j.value) AS email FROM messages m, json_each(m.to_emails) j
      WHERE m.organization_id = ${orgId} AND m.direction = 'outbound'
    UNION SELECT lower(j.value) FROM messages m, json_each(m.cc_emails) j
      WHERE m.organization_id = ${orgId} AND m.direction = 'outbound'
    UNION SELECT lower(j.value) FROM messages m, json_each(m.bcc_emails) j
      WHERE m.organization_id = ${orgId} AND m.direction = 'outbound'
  `);
  return rows.map((r) => r.email).filter((email) => email.includes("@"));
}

export type SpamIngestEnv = Pick<Env, "DB" | "MAIL_STORE" | "KV" | "AI" | "SPAMHAUS_DQS_KEY" | "BOXOX_EDITION">;

/**
 * Durable workflow adapter for persisted inbound mail. Consent and per-address
 * opt-outs come from D1, and AI failures retain the AI-free verdict. A recorded
 * combiner result is the replay marker: completed scans do not call a model again.
 */
export async function scanStoredMessage(env: SpamIngestEnv, messageId: string, opts: { rescan?: boolean; timeoutMs?: number } = {}): Promise<string | null> {
  const db = createDb(env);
  const row = await db.select({ message: messages, folder: threads.folder })
    .from(messages).innerJoin(threads, eq(threads.id, messages.threadId)).where(eq(messages.id, messageId)).get();
  if (!row || row.message.direction !== "inbound") return row?.folder ?? null;
  const message = row.message;
  // Held and parse-quarantined mail is not sent to a model. The owner must
  // first route held mail; malformed MIME retains its parse quarantine.
  if (!message.addressId || (row.folder === "quarantine" && !message.spamVerdict?.combiner) || !message.rawMimeKey) return row.folder;
  if (message.spamVerdict?.combiner && !opts.rescan) return row.folder;

  const [settings, config, ownedDomains, history, blockedSender, knownContacts] = await Promise.all([
    db.query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) }),
    loadClassifierConfig(db, message.addressId),
    db.select({ name: domains.name }).from(domains).where(eq(domains.organizationId, message.organizationId)),
    historyFromMessages(db, message.organizationId, message.fromEmail.toLowerCase()),
    isBlockedSender(db, message.organizationId, message.fromEmail),
    knownContactsFromMessages(db, message.organizationId),
  ]);
  if (isFree(env)) config.consent = { ...config.consent, enabled: false };
  // An attacker can forge a correspondent's From. Only a verified identity
  // may use outbound history to skip every remaining spam/injection check.
  const sender = message.authenticated ? history : { ...history, outbound: 0 };
  const source = await env.MAIL_STORE.get(message.rawMimeKey);
  if (!source) throw new Error("spam scan: original MIME missing from R2");
  const raw = new Uint8Array(await source.arrayBuffer());
  if (raw.byteLength > MIME_LIMITS.maxBytes) return row.folder;
  const parsed = await PostalMime.parse(raw, {
    maxNestingDepth: MIME_LIMITS.maxNestingDepth, maxPartCount: MIME_LIMITS.maxPartCount,
    maxHeadersSize: MIME_LIMITS.maxHeadersSize, maxRfc822NestingDepth: MIME_LIMITS.maxRfc822NestingDepth,
    maxForwardedAddresses: MIME_LIMITS.maxForwardedAddresses,
  });
  if (parsed.headers.length > MIME_LIMITS.maxHeaderCount) return row.folder;
  const mail = signalMailFrom(parsed);
  const layer1 = await collectSignals(env, db, mail, { ownerDomains: ownedDomains.map((d) => d.name), now: message.occurredAt, knownContacts });
  const bayes = layer1.ran ? await score(db, { subject: message.subject, fromEmail: message.fromEmail, text: mail.text, html: mail.html }) : null;
  // Preserve the signals even when the classifier fails, so the why panel and
  // nightly refit see the exact non-AI input that was used.
  await db.update(messages).set({ spamVerdict: { ...(message.spamVerdict ?? {}), layer1, bayes } }).where(eq(messages.id, messageId));
  const previousAi = message.spamVerdict?.ai as { attempt?: number } | undefined;
  const result = await scanMessage({
    db, ai: env.AI, budget: kvBudgetStore(env.KV), config,
    onlyWhenUncertain: settings?.onlyWhenUncertain ?? true, timeoutMs: opts.timeoutMs,
  }, {
    layer1, bayes, sender, blockedSender, attempt: opts.rescan ? previousAi?.attempt ?? 0 : 0,
    classifier: {
      address: config.address!, fromEmail: message.fromEmail, fromName: mail.fromName, replyTo: mail.replyTo,
      to: message.toEmails, subject: message.subject, date: mail.date, auth: layer1.auth,
      signals: layer1.signals, linkDomains: layer1.linkDomains,
      attachmentNames: mail.attachments.map((a) => a.filename).filter(Boolean), sender, text: mail.text, html: mail.html,
    },
  });
  await recordVerdict(db, messageId, result);
  // recordVerdict respects a folder the owner already chose. Notify the actual
  // persisted folder, rather than the classifier's requested destination.
  return (await db.select({ folder: threads.folder }).from(threads).where(eq(threads.id, message.threadId)).get())?.folder ?? row.folder;
}
