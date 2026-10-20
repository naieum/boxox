import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { messages, threads } from "@boxox/db";
import { normalizeSubject } from "@boxox/shared";
import type { Db } from "../db";

/**
 * Authserv-ids whose Authentication-Results we trust — v1's receiving MTA,
 * until phase 3 switches to Cloudflare's. Exact or subdomain match; any
 * other authserv-id was stamped before the message reached us and is
 * sender-forgeable.
 */
export const TRUSTED_AUTHSERV_DOMAINS = ["resend.com", "amazonses.com"] as const;

/** RFC 8601: authserv-id is the first token before ';' (optional version after it). */
function hasTrustedAuthservId(headerVal: string): boolean {
  const id = headerVal.split(";", 1)[0]?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return TRUSTED_AUTHSERV_DOMAINS.some((d) => id === d || id.endsWith(`.${d}`));
}

/**
 * Gate on the RFC 8601 `Authentication-Results` headers. True only when
 * exactly ONE such header exists, its authserv-id is the receiving MTA's
 * (anything else — including a forged header the sender attached to a spoofed
 * message — is untrusted), and it asserts DMARC pass or aligned SPF pass AND
 * DKIM pass. Anything absent, duplicated, ambiguous, or unparseable → false
 * (fail closed). This is the security signal that gates whether a counterparty
 * counts as "known" for reply-only agent send — a spoofed inbound From must
 * never read as authentic.
 */
export function isAuthenticated(authResults: string[]): boolean {
  if (authResults.length !== 1) return false;
  const header = authResults[0]!;
  if (!hasTrustedAuthservId(header)) return false;
  const v = header.toLowerCase();
  if (/\bdmarc=pass\b/.test(v)) return true;
  return /\bspf=pass\b/.test(v) && /\bdkim=pass\b/.test(v);
}

/**
 * Deterministic dedupe id (FIX C): the real RFC Message-ID when present, else a
 * synthetic `syn:` fallback from immutable job identity so at-least-once retries
 * dedupe instead of inserting + re-metering. `email_id` is stable across Resend
 * re-deliveries; `rawKey` is stable across queue retries. Always non-null.
 */
export function dedupeKeyFor(args: {
  rfcMessageId: string | null;
  emailId: string | null | undefined;
  rawKey: string;
}): string {
  return args.rfcMessageId ?? `syn:${args.emailId ?? args.rawKey}`;
}

/**
 * Delivery-scope half of the idempotency key `(organizationId, dedupeScope,
 * rfcMessageId)` enforced by the messages_dedupe_idx unique index.
 *
 * One inbound email legitimately yields several rows — one per routed mailbox,
 * one per held recipient — so the message id alone cannot be unique. Routed
 * copies scope to the address; held copies have no address yet and scope to the
 * recipient they were addressed to. Held mail could NOT be covered by a plain
 * address_id index: Postgres treats NULLs as distinct, so every retry would
 * insert again.
 */
export function dedupeScopeFor(target: { addressId: string } | { heldRecipient: string }): string {
  return "addressId" in target ? target.addressId : `held:${target.heldRecipient}`;
}

/**
 * Thrown inside a delivery transaction when the unique index reports the row
 * already exists. Rolling the transaction back (rather than just skipping the
 * insert) is what keeps a redelivery from leaving behind an orphan thread that
 * the just-created-then-abandoned thread insert would otherwise commit.
 */
class DuplicateDelivery extends Error {
  constructor() {
    super("duplicate delivery");
    this.name = "DuplicateDelivery";
  }
}

/**
 * Total inbound attachment bytes stored per message.
 *
 * Matched to Resend's ~40MB maximum message size ON PURPOSE: a lower cap would
 * silently discard attachments that Resend already accepted and delivered, so
 * the sender sees success while the content is destroyed. The cap exists to
 * bound Worker memory and storage, not to second-guess the provider — so it
 * should track the provider ceiling, never sit below it.
 */
export const TOTAL_ATTACHMENT_LIMIT_BYTES = 40 * 1024 * 1024;

/**
 * Partition attachments against the byte budget using sizes REPORTED BY THE
 * PROVIDER, rather than estimated from an inline base64 blob. Greedy in order:
 * each is stored only if it keeps the running total within budget; a skipped
 * one consumes no budget, so a later small attachment can still fit. Pure.
 */
export function planAttachmentsBySize(
  atts: { filename: string; contentType: string; size: number }[],
  limitBytes: number,
): { filename: string; contentType: string; size: number; store: boolean }[] {
  let total = 0;
  return atts.map((att) => {
    const size = Math.max(0, att.size);
    const store = total + size <= limitBytes;
    if (store) total += size;
    return { filename: att.filename, contentType: att.contentType, size, store };
  });
}

/** Attachment metadata as persisted on messages.attachmentsMeta. */
export interface StoredAttachment {
  filename: string;
  contentType: string;
  size: number;
  r2Key: string | null;
  truncated: boolean;
}

/**
 * Estimate a base64 payload's decoded byte length WITHOUT decoding it, so an
 * oversized attachment can be skipped before it is materialized in memory.
 * floor(len * 3 / 4) minus one byte per `=` padding char.
 */
export function base64DecodedSize(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.charCodeAt(len - 1) === 61) padding++; // '='
  if (len > 1 && b64.charCodeAt(len - 2) === 61) padding++;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Partition a message's attachments against a total byte budget. Greedy in
 * order: each attachment is stored only if its estimated decoded size keeps the
 * running total within `limitBytes`; otherwise it is marked to skip (never
 * decoded or stored). Skipped attachments do not consume budget, so a later
 * small one can still fit. Pure — the caller does the R2 writes and logging.
 */
export function planAttachments(
  atts: { filename: string; contentType: string; content: string }[],
  limitBytes: number,
): { filename: string; contentType: string; size: number; store: boolean }[] {
  let total = 0;
  return atts.map((att) => {
    const size = base64DecodedSize(att.content);
    const store = total + size <= limitBytes;
    if (store) total += size;
    return { filename: att.filename, contentType: att.contentType, size, store };
  });
}

/** R2 key for a message's original RFC822 source. */
export function originalMimeKey(orgId: string, day: string, emailId: string): string {
  return `originals/${orgId}/${day}/${emailId}.eml`;
}

/** R2 key for one stored attachment. */
export function attachmentKey(
  orgId: string,
  day: string,
  emailId: string,
  attachmentId: string,
  filename: string,
): string {
  // Filename is sender-controlled, so this is a security boundary, not cosmetics.
  //
  // An explicit ALLOWLIST rather than a "strip the bad characters" range: an
  // earlier version used a character class whose hyphen parsed as a literal
  // instead of a range, so it stripped the slash but left the dot intact and a
  // ../../x filename survived as .._.._x. A deny-list that looks correct and
  // silently is not is exactly the failure mode to avoid on a path boundary.
  //
  // Dots are kept (extensions are useful) but runs of two or more collapse, and
  // a leading dot or dash is neutralised so the name can neither traverse nor
  // masquerade as a flag.
  const safe =
    filename
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^[.\-]+/, "_")
      .slice(0, 120) || "file";
  return `attachments/${orgId}/${day}/${emailId}/${attachmentId}-${safe}`;
}

/** Upper bound on the searchable body projection stored per message. */
export const SEARCH_TEXT_LIMIT = 32 * 1024;

export function searchTextLimit(value?: string): number {
  const limit = Number(value);
  return value !== undefined && /^\d+$/.test(value) && Number.isInteger(limit) && limit <= 65536 ? limit : SEARCH_TEXT_LIMIT;
}

/**
 * Flatten a message into the text users actually search by: subject,
 * participants, and the leading body.
 *
 * Truncated on purpose. The goal is a mailbox that finds things, not a second
 * full-text copy of every body in the database — and an unbounded
 * column here would make a single large newsletter dominate an org's row size.
 * Participants are included because "everything from Ada" is at least as common
 * a search as any word in a body.
 */
export function buildSearchText(input: {
  subject: string;
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  text: string | null;
  html: string | null;
}, limit = SEARCH_TEXT_LIMIT): string {
  const body = input.text ?? input.html?.replace(/<[^>]+>/g, " ") ?? "";
  return [
    input.subject,
    input.fromName ?? "",
    input.fromEmail,
    ...input.toEmails,
    ...input.ccEmails,
    body,
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Number.isInteger(limit) && limit >= 0 && limit <= 65536 ? limit : SEARCH_TEXT_LIMIT);
}

/**
 * Message-IDs from a References (or In-Reply-To) header, oldest first.
 *
 * The header is a space-separated list of angle-bracketed ids, but real clients
 * emit folded lines, stray commas, and occasional unbracketed ids, so this
 * extracts every `<...>` token rather than trusting the separator.
 */
export function parseReferences(header: string | null | undefined, max = 200): string[] {
  if (!header) return [];
  // Capped: this header is SENDER-CONTROLLED. Uncapped it feeds an unbounded
  // list into inArray(), and past Postgres's 65535-bind-parameter ceiling the
  // statement errors — which is not a DuplicateDelivery, so the queue retries
  // identically five times and dead-letters the message. A hostile or merely
  // enormous References header could stop mail being delivered at all.
  const out: string[] = [];
  for (const m of header.matchAll(/<[^<>\s]+>/g)) {
    out.push(m[0]);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The ancestry a reply should claim: the parent's own chain plus the parent
 * itself, deduped and capped.
 *
 * RFC 5322 says to append the parent's Message-ID to its References. The cap
 * exists because a long-running thread grows this header without bound and some
 * MTAs reject oversized headers — dropping from the MIDDLE keeps the root (which
 * anchors the thread) and the recent ancestors (which do the actual matching).
 */
export function buildReferences(
  parentReferences: string | null,
  parentMessageId: string | null,
  max = 20,
): string | null {
  const chain = parseReferences(parentReferences);
  if (parentMessageId) chain.push(parentMessageId);
  const unique = [...new Set(chain)];
  if (unique.length === 0) return null;
  if (unique.length <= max) return unique.join(" ");
  return [unique[0], ...unique.slice(unique.length - (max - 1))].join(" ");
}

/** A Db or an open transaction on one — the write paths run inside the latter. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Find or create the thread for an inbound message. */
export async function resolveThread(
  db: DbOrTx,
  orgId: string,
  addressId: string,
  subject: string,
  counterparty: { email: string; name: string | null },
  inReplyTo: string | null,
  references: string | null,
  occurredAt: Date,
): Promise<string> {
  // Ancestry, most recent first: the immediate parent, then every id in
  // References working backwards. In-Reply-To alone fragments a thread whenever
  // the immediate parent never reached this mailbox — a participant added late,
  // a branch forwarded in — while an older ancestor is right there in References.
  // Nearest 20 ancestors only. The loop below returns on the first match, so a
  // longer list cannot change the outcome — it only widens the query.
  const ancestry = [inReplyTo, ...parseReferences(references).reverse()]
    .filter((id): id is string => !!id)
    .slice(0, 20);
  if (ancestry.length > 0) {
    // SECURITY: scoped to this MAILBOX, not just the org. Matching org-wide
    // would attach the reply to whatever thread referenced that Message-ID even
    // if it belongs to a different address — and grants are per-address
    // (services/access.ts), so a holder of a grant on only that other address
    // would then be able to read mail delivered here. An attacker who learns a
    // Message-ID (they are echoed in References on any thread they participate
    // in) could otherwise steer replies across mailbox boundaries. Widening the
    // match from one id to a chain makes that scoping MORE load-bearing, not
    // less: every candidate is attacker-visible.
    const parent = await db
      .select({ threadId: messages.threadId, rfcMessageId: messages.rfcMessageId })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, orgId),
          eq(messages.addressId, addressId),
          inArray(messages.rfcMessageId, [...new Set(ancestry)]),
        ),
      );
    if (parent.length > 0) {
      // Prefer the nearest ancestor we actually hold, so a reply joins the most
      // specific branch rather than whichever row the planner returned first.
      const byId = new Map(parent.map((p) => [p.rfcMessageId, p.threadId]));
      for (const id of ancestry) {
        const hit = byId.get(id);
        if (hit) return hit;
      }
    }
  }
  const subjectNorm = normalizeSubject(subject);
  if (subjectNorm) {
    const cutoff = new Date(occurredAt.getTime() - 30 * 24 * 3600 * 1000);
    const match = await db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.addressId, addressId),
          eq(threads.subjectNorm, subjectNorm),
          eq(threads.counterpartyEmail, counterparty.email),
          gt(threads.lastMessageAt, cutoff),
        ),
      )
      .orderBy(desc(threads.lastMessageAt))
      .limit(1);
    if (match[0]) return match[0].id;
  }
  const id = crypto.randomUUID();
  await db.insert(threads).values({
    id,
    organizationId: orgId,
    addressId,
    subject,
    subjectNorm,
    counterpartyEmail: counterparty.email,
    counterpartyName: counterparty.name,
    folder: "inbox",
    lastMessageAt: occurredAt,
  });
  return id;
}
