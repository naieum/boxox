import { z } from "zod";

export const localPartSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    "Lowercase letters, digits, dot, underscore and hyphen; must start and end alphanumeric",
  );

// ---------- Address model ----------

export const ADDRESS_KINDS = ["personal", "role", "agent", "disposable"] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

export const ADDRESS_STATUSES = ["active", "paused", "archived"] as const;
export type AddressStatus = (typeof ADDRESS_STATUSES)[number];

/**
 * For agent principals `send` is reply-only (recipient must already be a thread
 * counterparty on a granted address); `send_new` additionally allows net-new
 * recipients and is off by default — Cloudflare can suspend sending on complaint/bounce
 * spikes, so cold sends need an explicit human grant.
 */
export const GRANT_PERMISSIONS = ["read", "send", "send_new", "webhook", "classify"] as const;
export type GrantPermission = (typeof GRANT_PERMISSIONS)[number];

export const THREAD_FOLDERS = ["inbox", "sent", "archive", "trash", "unrouted", "spam"] as const;
export type ThreadFolder = (typeof THREAD_FOLDERS)[number];

export const addressCreateSchema = z.object({
  localPart: localPartSchema.optional(),
  /** When true (or no localPart), the server generates a disposable-style local part. */
  generate: z.boolean().optional(),
  kind: z.enum(ADDRESS_KINDS).default("role"),
  displayName: z.string().max(120).optional(),
  /** Optional person to attach immediately, by email. */
  grantEmail: z.string().email().optional(),
});

export const addressPatchSchema = z.object({
  kind: z.enum(ADDRESS_KINDS).optional(),
  status: z.enum(ADDRESS_STATUSES).optional(),
  displayName: z.string().max(120).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const grantCreateSchema = z.object({
  email: z.string().email(),
  permissions: z.array(z.enum(GRANT_PERMISSIONS)).min(1).default(["read", "send"]),
});

export const UNKNOWN_MAIL_POLICIES = ["hold", "catch_all", "drop"] as const;
export type UnknownMailPolicy = (typeof UNKNOWN_MAIL_POLICIES)[number];

export const domainPatchSchema = z.object({
  unknownMailPolicy: z.enum(UNKNOWN_MAIL_POLICIES).optional(),
  catchAllAddressId: z.string().nullable().optional(),
});

/**
 * Outbound attachment as submitted by a client: base64 content, because JSON
 * cannot carry bytes. The 40MB ceiling matches Resend's maximum message size —
 * see TOTAL_ATTACHMENT_LIMIT_BYTES on the inbound side. Base64 inflates by ~4/3,
 * so the encoded bound is set accordingly and the real decoded total is checked
 * server-side where it can be enforced rather than merely declared.
 */
export const OUTBOUND_ATTACHMENT_LIMIT_BYTES = 40 * 1024 * 1024;

/**
 * Base64 inflates by 4/3, so this is the encoded ceiling for a single
 * attachment at the decoded limit, plus padding.
 *
 * Bounding it HERE matters: the decoded-total check in the send route runs after
 * the JSON body has already been parsed, so without a per-string cap a hostile
 * or accidental multi-hundred-megabyte payload exhausts the isolate before the
 * 413 can be returned. Zod rejects it first.
 */
export const MAX_ENCODED_ATTACHMENT_CHARS = Math.ceil((OUTBOUND_ATTACHMENT_LIMIT_BYTES * 4) / 3) + 4;

export const outboundAttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  /** Base64-encoded bytes. */
  content: z.string().min(1).max(MAX_ENCODED_ATTACHMENT_CHARS),
  contentType: z.string().max(255).optional(),
});

export const sendMessageSchema = z.object({
  fromAddressId: z.string(),
  to: z.array(z.string().email()).min(1).max(50),
  cc: z.array(z.string().email()).max(50).default([]),
  subject: z.string().min(1).max(500),
  text: z.string().max(500_000),
  /** Optional rich body sent alongside text as a MIME alternative. */
  html: z.string().max(2_000_000).optional(),
  attachments: z.array(outboundAttachmentSchema).max(20).default([]),
  threadId: z.string().optional(),
});

/**
 * Decoded byte length of a base64 string, computed WITHOUT decoding it, so an
 * oversized payload is rejected before it is materialised in Worker memory.
 */
export function base64Size(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.charCodeAt(len - 1) === 61) padding++;
  if (len > 1 && b64.charCodeAt(len - 2) === 61) padding++;
  return Math.floor((len * 3) / 4) - padding;
}

export const threadClaimSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    /** Kind for the newly minted address; local part comes from the original recipient. */
    kind: z.enum(ADDRESS_KINDS).default("role"),
  }),
  z.object({
    mode: z.literal("redirect"),
    addressId: z.string(),
  }),
]);

export const threadActionSchema = z.object({
  action: z.enum([
    "read",
    "unread",
    "star",
    "unstar",
    "archive",
    "trash",
    "restore",
    "spam",
    "not_spam",
    "block_sender",
  ]),
});

// ---------- Pure mail helpers (unit-tested) ----------

/** Strip reply/forward prefixes and collapse whitespace for fallback threading. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function makeSnippet(text: string | null | undefined, max = 140): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Random, unambiguous local part for disposable addresses, e.g. "x7k2q9". */
export function generateLocalPart(random: () => number = Math.random): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(random() * alphabet.length)]!;
  return s;
}

export interface RoutableAddress {
  id: string;
  localPart: string;
  status: AddressStatus;
  expiresAt: Date | null;
}

export interface RoutingDomain {
  unknownMailPolicy: UnknownMailPolicy;
  catchAllAddressId: string | null;
}

export type RouteResult =
  | { kind: "deliver"; addressId: string; via: "exact" | "catch_all" }
  | { kind: "hold" }
  | { kind: "drop" };

/**
 * Route an inbound local-part.
 * Exact active match delivers; otherwise the domain's unknown-mail policy
 * decides: catch_all delivers to the designated mailbox, hold parks the
 * message in the Unrouted view, drop discards (with an operational event).
 * A missing/paused/expired catch-all target degrades to hold, never drop —
 * mail should not vanish because a mailbox was paused.
 */
export function routeLocalPart(
  localPart: string,
  domain: RoutingDomain,
  candidates: RoutableAddress[],
  now: Date,
): RouteResult {
  const lp = localPart.toLowerCase();
  const exact = candidates.find((a) => a.localPart.toLowerCase() === lp);
  if (
    exact &&
    exact.status === "active" &&
    (!exact.expiresAt || exact.expiresAt > now)
  ) {
    return { kind: "deliver", addressId: exact.id, via: "exact" };
  }
  if (domain.unknownMailPolicy === "catch_all" && domain.catchAllAddressId) {
    const ca = candidates.find((a) => a.id === domain.catchAllAddressId);
    if (ca && ca.status === "active" && (!ca.expiresAt || ca.expiresAt > now)) {
      return { kind: "deliver", addressId: ca.id, via: "catch_all" };
    }
    return { kind: "hold" };
  }
  if (domain.unknownMailPolicy === "drop") return { kind: "drop" };
  return { kind: "hold" };
}

/**
 * Spam v1: folder for a delivered inbound message. Blocked senders always land
 * in spam, even when authenticated — the user's explicit block outranks DMARC.
 * Otherwise unauthenticated mail is spam only on the wide-open surfaces
 * (catch-all delivery, role addresses); personal/agent/disposable mailboxes
 * keep unauthenticated mail in the inbox so a strict filter can't hide real
 * correspondence from small senders without DMARC.
 */
export function decideInboundFolder(args: {
  senderBlocked: boolean;
  authenticated: boolean;
  via: "exact" | "catch_all";
  addressKind: AddressKind;
}): "inbox" | "spam" {
  if (args.senderBlocked) return "spam";
  if (!args.authenticated && (args.via === "catch_all" || args.addressKind === "role")) {
    return "spam";
  }
  return "inbox";
}

/** Parse "Name <a@b.c>" | "a@b.c" | {email,name} into parts. */
export function parseAddress(input: unknown): { email: string; name: string | null } {
  if (input && typeof input === "object") {
    const o = input as { email?: string; name?: string };
    if (o.email) return { email: o.email.toLowerCase(), name: o.name ?? null };
  }
  if (typeof input === "string") {
    const m = input.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
    if (m) return { email: m[2]!.trim().toLowerCase(), name: m[1]?.trim() || null };
    return { email: input.trim().toLowerCase(), name: null };
  }
  return { email: "", name: null };
}
