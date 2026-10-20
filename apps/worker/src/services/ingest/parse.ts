import PostalMime, { type Address, type Email } from "postal-mime";
import { isAuthenticated } from "./auth";

/**
 * Parser limits. Inbound mail is capped at 25 MiB by Cloudflare; the rest
 * bound what a hostile message can make the parser allocate. Real mail sits
 * far below every one of them.
 */
export const MIME_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxNestingDepth: 32,
  maxPartCount: 500,
  maxHeadersSize: 256 * 1024,
  maxHeaderCount: 1000,
  maxRfc822NestingDepth: 3,
  maxForwardedAddresses: 500,
} as const;

const MAX_RECIPIENTS = 200;
const MAX_SUBJECT = 998;
const MAX_REFERENCES = 100;

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  contentId: string | null;
  inline: boolean;
  content: Uint8Array;
}

export interface ParsedMail {
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  /** Bracketed Message-ID, or null when absent or malformed. */
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  authenticated: boolean;
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
}

export type ParseOutcome = { ok: true; mail: ParsedMail } | { ok: false; reason: string };

function mailboxes(list: Address[] | Address | undefined): { email: string; name: string | null }[] {
  const flat = (Array.isArray(list) ? list : list ? [list] : []).flatMap((a) => (a.group ? a.group : [a]));
  return flat
    .map((m) => ({ email: (m.address ?? "").trim().toLowerCase(), name: m.name?.trim() || null }))
    .filter((m) => m.email.includes("@"));
}

function emails(list: Address[] | undefined): string[] {
  return [...new Set(mailboxes(list).map((m) => m.email))].slice(0, MAX_RECIPIENTS);
}

/** Sender-controlled, so only a single well-formed `<id>` is kept. */
function messageIdOf(value: string | undefined): string | null {
  const m = value?.trim().match(/^<?([^<>\s]{1,500})>?$/);
  return m ? `<${m[1]}>` : null;
}

function idList(value: string | undefined): string | null {
  const ids = [...(value ?? "").matchAll(/<[^<>\s]{1,500}>/g)].map((m) => m[0]).slice(-MAX_REFERENCES);
  return ids.length ? ids.join(" ") : null;
}

function bytesOf(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function toParsed(email: Email): ParsedMail {
  const from = mailboxes(email.from)[0] ?? { email: "", name: null };
  return {
    fromEmail: from.email,
    fromName: from.name,
    toEmails: emails(email.to),
    ccEmails: emails(email.cc),
    subject: (email.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, MAX_SUBJECT),
    rfcMessageId: messageIdOf(email.messageId),
    inReplyTo: idList(email.inReplyTo)?.split(" ")[0] ?? null,
    references: idList(email.references),
    authenticated: isAuthenticated(email.headers, from.email),
    text: email.text ?? null,
    html: email.html ?? null,
    attachments: email.attachments.map((a) => ({
      filename: (a.filename ?? "").replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 255) || "attachment",
      contentType: a.mimeType || "application/octet-stream",
      contentId: a.contentId ?? null,
      inline: a.disposition === "inline" || !!a.related,
      content: bytesOf(a.content),
    })),
  };
}

/**
 * postal-mime under MIME_LIMITS. Never throws: a message the parser can't or
 * won't handle comes back as `ok: false` with the reason, so the caller
 * quarantines it instead of retrying a parse that will fail the same way.
 */
export async function parseMessage(raw: ArrayBuffer | Uint8Array): Promise<ParseOutcome> {
  if (raw.byteLength > MIME_LIMITS.maxBytes) {
    return { ok: false, reason: `message is ${raw.byteLength} bytes, over the ${MIME_LIMITS.maxBytes}-byte limit` };
  }
  let email: Email;
  try {
    email = await PostalMime.parse(raw, {
      maxNestingDepth: MIME_LIMITS.maxNestingDepth,
      maxPartCount: MIME_LIMITS.maxPartCount,
      maxHeadersSize: MIME_LIMITS.maxHeadersSize,
      maxRfc822NestingDepth: MIME_LIMITS.maxRfc822NestingDepth,
      maxForwardedAddresses: MIME_LIMITS.maxForwardedAddresses,
    });
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err).slice(0, 300) };
  }
  if (email.headers.length > MIME_LIMITS.maxHeaderCount) {
    return { ok: false, reason: `${email.headers.length} headers, over the ${MIME_LIMITS.maxHeaderCount}-header limit` };
  }
  try {
    return { ok: true, mail: toParsed(email) };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err).slice(0, 300) };
  }
}
