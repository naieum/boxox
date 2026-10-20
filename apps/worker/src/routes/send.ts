import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { addresses, attachments, domains, messages, shareLinks, threads } from "@boxox/db";
import { base64Size, makeSnippet } from "@boxox/shared";
import { writeAudit } from "../audit";
import type { Db } from "../db";
import { htmlToText, MAX_MESSAGE_BYTES, MAX_RECIPIENTS, MAX_SCHEDULE_MS } from "../dev/messages";
import type { Env } from "../env";
import { requireOrgMember, type AppContext } from "../middleware";
import { accessibleAddressIds, type Accessor } from "../services/access";
import { organizationSendLimit, rateLimitHit } from "../services/agent-rate-limit";
import { buildReferences } from "../services/ingest";
import { queueOutbound } from "../services/outbound";
import { createShareLink, DEFAULT_LINK_DAYS, MAX_LINK_DAYS, publicOrigin } from "./share-links";

/**
 * Compose: new mail, replies, reply-all and forwards (inline, or the original
 * as a .eml). Every send is persisted first and handed to SendWorkflow, which
 * also gives scheduled send. A message may be at most 5 MiB including base64
 * overhead and 50 recipients; over the size limit, files go out as expiring
 * download links instead of attachments.
 */

export { MAX_MESSAGE_BYTES, MAX_RECIPIENTS };
export const MAX_ATTACHMENTS = 50;
export const COMPOSE_MODES = ["new", "reply", "reply_all", "forward", "forward_eml"] as const;
export type ComposeMode = (typeof COMPOSE_MODES)[number];

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** MIME base64: 57 bytes become a 76-character line plus CRLF. */
export const encodedSize = (bytes: number) => Math.ceil(bytes / 57) * 78;

export function messageSize(parts: { subject: string; text: string; html?: string | null }, attachmentBytes: number[]): number {
  const enc = new TextEncoder();
  return (
    enc.encode(parts.subject).length +
    enc.encode(parts.text).length +
    (parts.html ? enc.encode(parts.html).length : 0) +
    attachmentBytes.reduce((n, b) => n + encodedSize(b), 0)
  );
}

/**
 * Which attachments to send as links so the message fits: the largest first,
 * until it does. Null when even the bare message is too large.
 */
export function attachmentsToLink(bodyBytes: number, sizes: number[], limit = MAX_MESSAGE_BYTES): number[] | null {
  let total = bodyBytes + sizes.reduce((n, b) => n + encodedSize(b), 0);
  const order = sizes.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
  const linked: number[] = [];
  for (const [size, i] of order) {
    if (total <= limit) break;
    total -= encodedSize(size);
    linked.push(i);
  }
  return total <= limit ? linked : null;
}

const lower = (e: string) => e.trim().toLowerCase();

/**
 * Reply-all as Gmail does it: answering someone else's message goes To its
 * sender plus its other To recipients, and Cc keeps its Cc; answering your own
 * sent message goes back to the same people. The user's own addresses are
 * dropped, and nobody appears twice.
 */
export function replyAllRecipients(
  msg: { direction: "inbound" | "outbound"; fromEmail: string; toEmails: string[]; ccEmails: string[] },
  ownAddresses: string[],
): { to: string[]; cc: string[] } {
  const own = new Set(ownAddresses.map(lower));
  const seen = new Set<string>();
  const keep = (list: string[]) =>
    list.filter((e) => {
      const k = lower(e);
      if (!k || own.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const to = keep(msg.direction === "inbound" ? [msg.fromEmail, ...msg.toEmails] : msg.toEmails);
  const cc = keep(msg.ccEmails);
  return to.length ? { to, cc } : { to: cc, cc: [] };
}

export function replySubject(subject: string, mode: ComposeMode): string {
  const s = subject.trim();
  if (mode === "forward" || mode === "forward_eml") return /^(fwd?|fw):/i.test(s) ? s : `Fwd: ${s}`;
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** Attachment input before the size check: bytes either in hand (base64) or already in R2. */
export type ComposeFile =
  | { filename: string; contentType: string; size: number; content: string }
  | { filename: string; contentType: string; size: number; r2Key: string };

export interface ComposeInput {
  fromAddressId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string | null;
  threadId?: string | null;
  replyToMessageId?: string | null;
  mode: ComposeMode;
  /** Base64 uploads, and files already in R2 (draft uploads; never caller-supplied keys). */
  files: ComposeFile[];
  /** Forwards carry the original's attachments, reusing the stored R2 objects. */
  includeOriginalAttachments: boolean;
  sendAt?: string | null;
  /** "link" turns attachments into download links when the message is over 5 MiB; "fail" refuses it. */
  attachmentsMode: "link" | "fail";
  linkExpiresInDays?: number;
}

export interface ComposeActor {
  env: Pick<Env, "DB" | "MAIL_STORE" | "SEND_WORKFLOW" | "PUBLIC_URL" | "AGENT_SEND_LIMIT_PER_15_MIN">;
  db: Db;
  orgId: string;
  accessor: Accessor;
  origin: string;
}

export type ComposeResult =
  | {
      ok: true;
      threadId: string;
      messageId: string;
      scheduled: boolean;
      links: { id: string; filename: string; url: string; expiresAt: string }[];
      linkedR2Keys: string[];
    }
  | { ok: false; status: 400 | 403 | 404 | 413 | 422 | 429 | 502; code: string; message: string; messageId?: string; threadId?: string };

const fail = (status: Extract<ComposeResult, { ok: false }>["status"], code: string, message: string): ComposeResult => ({
  ok: false,
  status,
  code,
  message,
});

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Can the accessor read the mailbox this message is in? */
async function readableMessage(db: Db, orgId: string, accessor: Accessor, messageId: string) {
  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.organizationId, orgId)))
    .limit(1);
  if (!msg) return null;
  const readable = await accessibleAddressIds(db, orgId, accessor, "read");
  if (readable !== null && (!msg.addressId || !readable.includes(msg.addressId))) return null;
  return msg;
}

/** Addresses the user sends as: every address for admins, their send grants otherwise. */
async function ownAddresses(db: Db, orgId: string, accessor: Accessor): Promise<string[]> {
  const ids = await accessibleAddressIds(db, orgId, accessor, "send");
  if (ids !== null && ids.length === 0) return [accessor.email];
  const rows = await db
    .select({ localPart: addresses.localPart, domain: domains.name })
    .from(addresses)
    .innerJoin(domains, eq(addresses.domainId, domains.id))
    .where(ids === null ? eq(addresses.organizationId, orgId) : and(eq(addresses.organizationId, orgId), inArray(addresses.id, ids)));
  return [accessor.email, ...rows.map((r) => `${r.localPart}@${r.domain}`)];
}

/** Files carried over by a forward: stored inbound objects, or the sent payload of our own mail. */
async function originalFiles(env: ComposeActor["env"], db: Db, msg: typeof messages.$inferSelect): Promise<ComposeFile[]> {
  if (msg.direction === "inbound") {
    const rows = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.messageId, msg.id), eq(attachments.inline, false)));
    return rows.map((a) => ({ filename: a.filename, contentType: a.detectedType, size: a.size, r2Key: `att/${a.sha256}` }));
  }
  const obj = await env.MAIL_STORE.get(msg.r2Key);
  if (!obj) return [];
  const body = (await obj.json()) as { attachments?: { filename: string; content: string; contentType?: string }[] };
  return (body.attachments ?? []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType ?? "application/octet-stream",
    size: base64Size(a.content),
    content: a.content,
  }));
}

function forwardHeader(msg: typeof messages.$inferSelect): string {
  const from = msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail;
  return [
    "---------- Forwarded message ---------",
    `From: ${from}`,
    `Date: ${msg.occurredAt.toUTCString()}`,
    `Subject: ${msg.subject}`,
    `To: ${msg.toEmails.join(", ")}`,
    ...(msg.ccEmails.length ? [`Cc: ${msg.ccEmails.join(", ")}`] : []),
  ].join("\n");
}

/**
 * Validate, resolve threading and attachments, apply the size and recipient
 * limits, then persist and queue through SendWorkflow. Nothing is written
 * unless every check passes.
 */
export async function composeAndQueue(actor: ComposeActor, input: ComposeInput): Promise<ComposeResult> {
  const { env, db, orgId, accessor } = actor;
  const to = input.to.map((e) => e.trim()).filter(Boolean);
  const cc = input.cc.map((e) => e.trim()).filter(Boolean);
  const bcc = input.bcc.map((e) => e.trim()).filter(Boolean);
  if (!to.length) return fail(400, "bad_request", "Add at least one recipient");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    return fail(422, "too_many_recipients", `At most ${MAX_RECIPIENTS} recipients across To, Cc and Bcc`);
  }
  const bad = [...to, ...cc, ...bcc].find((e) => !EMAIL_RE.test(e));
  if (bad) return fail(400, "bad_request", `${bad} is not an email address`);
  if (!input.subject.trim()) return fail(400, "bad_request", "Add a subject");

  let scheduledAt: Date | null = null;
  if (input.sendAt) {
    scheduledAt = new Date(input.sendAt);
    if (Number.isNaN(scheduledAt.getTime())) return fail(400, "bad_request", "sendAt is not a date");
    if (scheduledAt.getTime() - Date.now() > MAX_SCHEDULE_MS) return fail(422, "bad_request", "sendAt is more than a year away");
  }

  const [addr] = await db
    .select({ id: addresses.id, localPart: addresses.localPart, displayName: addresses.displayName, status: addresses.status, domain: domains.name })
    .from(addresses)
    .innerJoin(domains, eq(addresses.domainId, domains.id))
    .where(and(eq(addresses.id, input.fromAddressId), eq(addresses.organizationId, orgId)))
    .limit(1);
  const sendIds = addr ? await accessibleAddressIds(db, orgId, accessor, "send") : [];
  if (!addr || addr.status !== "active" || (sendIds !== null && !sendIds.includes(addr.id))) {
    return fail(403, "forbidden", "No send permission on this address");
  }
  const fromEmail = `${addr.localPart}@${addr.domain}`;

  const replying = input.mode === "reply" || input.mode === "reply_all";
  const forwarding = input.mode === "forward" || input.mode === "forward_eml";
  let original: typeof messages.$inferSelect | null = null;
  if (input.replyToMessageId) {
    original = await readableMessage(db, orgId, accessor, input.replyToMessageId);
    if (!original) return fail(404, "not_found", "No such message");
  } else if (forwarding) {
    return fail(400, "bad_request", "A forward needs the message being forwarded");
  }

  let threadId = forwarding ? null : (input.threadId ?? (replying ? original?.threadId : null) ?? null);
  let inReplyTo: string | null = null;
  let references: string | null = null;
  if (threadId) {
    const [thread] = await db
      .select({ id: threads.id, addressId: threads.addressId })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.organizationId, orgId)))
      .limit(1);
    if (!thread) return fail(404, "not_found", "No such thread");
    // SECURITY: a send grant on one address must not append to, or learn the
    // Message-IDs of, another mailbox's thread.
    if (thread.addressId !== addr.id) {
      return fail(403, "thread_address_mismatch", "That thread belongs to a different address than the one you're sending from");
    }
    let parent: { rfcMessageId: string | null; references: string | null } | undefined;
    if (original && original.threadId === threadId) {
      parent = original;
    } else {
      [parent] = await db
        .select({ rfcMessageId: messages.rfcMessageId, references: messages.references })
        .from(messages)
        .where(and(eq(messages.threadId, threadId), eq(messages.direction, "inbound")))
        .orderBy(desc(messages.occurredAt))
        .limit(1);
    }
    inReplyTo = parent?.rfcMessageId ?? null;
    references = buildReferences(parent?.references ?? null, parent?.rfcMessageId ?? null, 100);
  }

  const files: ComposeFile[] = [];
  for (const f of input.files) {
    if ("content" in f && !BASE64_RE.test(f.content)) return fail(400, "bad_request", `${f.filename} is not base64`);
    files.push(f);
  }
  if (original && forwarding) {
    if (input.mode === "forward_eml") {
      if (!original.rawMimeKey) return fail(422, "no_original", "This message has no original to attach; forward it inline");
      const head = await env.MAIL_STORE.head(original.rawMimeKey);
      if (!head) return fail(422, "no_original", "The original message is no longer stored");
      const name = original.subject.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 100) || "message";
      files.push({ filename: `${name}.eml`, contentType: "message/rfc822", size: head.size, r2Key: original.rawMimeKey });
    } else if (input.includeOriginalAttachments) {
      files.push(...(await originalFiles(env, db, original)));
    }
  }
  if (files.length > MAX_ATTACHMENTS) return fail(422, "too_many_attachments", `At most ${MAX_ATTACHMENTS} attachments`);

  let text = input.text;
  let html = input.html ?? null;
  if (!text.trim() && html) text = htmlToText(html);
  const bodyBytes = messageSize({ subject: input.subject, text, html }, []);
  const sizes = files.map((f) => f.size);
  let linkIdx: number[] = [];
  if (bodyBytes + sizes.reduce((n, b) => n + encodedSize(b), 0) > MAX_MESSAGE_BYTES) {
    const plan = input.attachmentsMode === "link" ? attachmentsToLink(bodyBytes + 4096, sizes) : null;
    if (!plan) {
      return fail(413, "message_too_large", `The message is over ${MAX_MESSAGE_BYTES / 1024 / 1024} MB; send large files as links`);
    }
    linkIdx = plan;
  }

  // Over budget writes nothing and never calls the send binding; shared with agent sends.
  if (!(await rateLimitHit(db, `send:org:${orgId}`, organizationSendLimit(env))).allowed) {
    return fail(429, "rate_limited", "Send rate limit exceeded");
  }

  const links: Awaited<ReturnType<typeof createShareLink>>[] = [];
  for (const i of linkIdx) {
    const f = files[i]!;
    let r2Key: string;
    if ("r2Key" in f) {
      r2Key = f.r2Key;
    } else {
      r2Key = `files/${orgId}/${crypto.randomUUID()}`;
      const bytes = Uint8Array.from(atob(f.content), (ch) => ch.charCodeAt(0));
      await env.MAIL_STORE.put(r2Key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    }
    links.push(
      await createShareLink(db, actor.origin, {
        r2Key,
        filename: f.filename,
        contentType: f.contentType,
        size: f.size,
        createdBy: accessor.userId,
        expiresInDays: input.linkExpiresInDays,
      }),
    );
  }
  if (links.length) {
    const until = links[0]!.expiresAt.toUTCString();
    text += `\n\nFiles (download links, available until ${until}):\n${links.map((l) => `${l.filename} (${formatSize(l.size)}): ${l.url}`).join("\n")}\n`;
    if (html) {
      html += `<p>Files (download links, available until ${escapeHtml(until)}):</p><ul>${links
        .map((l) => `<li><a href="${escapeHtml(l.url)}">${escapeHtml(l.filename)}</a> (${formatSize(l.size)})</li>`)
        .join("")}</ul>`;
    }
  }
  const outgoing: { filename: string; content: string; contentType: string }[] = [];
  for (const [i, f] of files.entries()) {
    if (linkIdx.includes(i)) continue;
    if ("content" in f) {
      outgoing.push({ filename: f.filename, content: f.content, contentType: f.contentType });
      continue;
    }
    const obj = await env.MAIL_STORE.get(f.r2Key);
    if (!obj) return fail(422, "attachment_missing", `${f.filename} is no longer stored`);
    outgoing.push({ filename: f.filename, content: toBase64(new Uint8Array(await obj.arrayBuffer())), contentType: f.contentType });
  }

  const queued = await queueOutbound(env, {
    organizationId: orgId,
    address: { id: addr.id, email: fromEmail, displayName: addr.displayName },
    threadId,
    to,
    cc,
    bcc,
    subject: input.subject,
    text,
    html,
    attachments: outgoing,
    inReplyTo,
    references,
    scheduledAt,
  });
  if (links.length) {
    await db
      .update(shareLinks)
      .set({ messageId: queued.messageId })
      .where(inArray(shareLinks.id, links.map((l) => l.id)));
  }
  await writeAudit(db, {
    organizationId: orgId,
    actorType: "user",
    actorId: accessor.userId,
    action: queued.ok ? "message.sent" : "message.send_failed",
    targetType: "message",
    targetId: queued.messageId,
    metadata: { from: fromEmail, to, mode: input.mode, links: links.length, scheduled: queued.ok && queued.scheduled },
  });
  if (!queued.ok) {
    return { ok: false, status: 502, code: "send_failed", message: queued.error, messageId: queued.messageId, threadId: queued.threadId };
  }
  threadId = queued.threadId;
  return {
    ok: true,
    threadId,
    messageId: queued.messageId,
    scheduled: queued.scheduled,
    links: links.map((l) => ({ id: l.id, filename: l.filename, url: l.url, expiresAt: l.expiresAt.toISOString() })),
    linkedR2Keys: linkIdx.map((i) => files[i]!).flatMap((f) => ("r2Key" in f ? [f.r2Key] : [])),
  };
}

export function actorOf(c: Context<AppContext>): ComposeActor {
  const user = c.get("user");
  return {
    env: c.env,
    db: c.get("db"),
    orgId: c.get("orgId"),
    accessor: { userId: user.id, email: user.email, role: c.get("orgRole") },
    origin: publicOrigin(c.env, c.req.url),
  };
}

export function composeResponse(c: Context<AppContext>, result: ComposeResult) {
  if (!result.ok) {
    const { status, code, message, ...rest } = result;
    return c.json({ error: { code, message }, ...(status === 502 ? { ...rest, saved: true } : {}) }, status);
  }
  const { ok, linkedR2Keys: _keys, ...body } = result;
  return c.json({ ok, ...body });
}

const recipientList = z.array(z.string().max(320)).max(200).default([]);

export const composeSchema = z.object({
  fromAddressId: z.string(),
  to: z.array(z.string().max(320)).min(1).max(200),
  cc: recipientList,
  bcc: recipientList,
  subject: z.string().min(1).max(998),
  text: z.string().max(500_000),
  html: z.string().max(2_000_000).optional(),
  threadId: z.string().optional(),
  replyToMessageId: z.string().optional(),
  mode: z.enum(COMPOSE_MODES).default("new"),
  attachments: z
    .array(z.object({ filename: z.string().min(1).max(255), content: z.string().min(1), contentType: z.string().max(255).optional() }))
    .max(MAX_ATTACHMENTS)
    .default([]),
  includeOriginalAttachments: z.boolean().default(true),
  sendAt: z.string().datetime({ offset: true }).optional(),
  attachmentsMode: z.enum(["link", "fail"]).default("link"),
  linkExpiresInDays: z.number().int().min(1).max(MAX_LINK_DAYS).default(DEFAULT_LINK_DAYS),
});

export const sendRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember)

  .post("/", async (c) => {
    const parsed = composeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid message" } }, 400);
    }
    const { attachments: uploads, ...input } = parsed.data;
    const result = await composeAndQueue(actorOf(c), {
      ...input,
      files: uploads.map((a) => ({
        filename: a.filename,
        contentType: a.contentType ?? "application/octet-stream",
        content: a.content.replace(/\s+/g, ""),
        size: base64Size(a.content.replace(/\s+/g, "")),
      })),
    });
    return composeResponse(c, result);
  })

  // Prefill for reply, reply-all and forward: recipients, subject and the quoted original.
  .get("/context/:messageId", async (c) => {
    const actor = actorOf(c);
    const mode = z.enum(COMPOSE_MODES).catch("reply").parse(c.req.query("mode"));
    const msg = await readableMessage(actor.db, actor.orgId, actor.accessor, c.req.param("messageId"));
    if (!msg) return c.json({ error: { code: "not_found", message: "No such message" } }, 404);
    const own = await ownAddresses(actor.db, actor.orgId, actor.accessor);
    const recipients =
      mode === "reply_all"
        ? replyAllRecipients(msg, own)
        : mode === "reply"
          ? { to: msg.direction === "inbound" ? [msg.fromEmail] : msg.toEmails, cc: [] }
          : { to: [], cc: [] };
    const obj = await c.env.MAIL_STORE.get(msg.r2Key);
    const raw = obj ? ((await obj.json().catch(() => null)) as { text?: string | null; data?: { text?: string | null } } | null) : null;
    const originalText = raw?.data?.text ?? raw?.text ?? msg.snippet;
    const from = msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail;
    const forwarding = mode === "forward" || mode === "forward_eml";
    const files = forwarding && mode === "forward" ? await originalFiles(c.env, actor.db, msg) : [];
    return c.json({
      mode,
      replyToMessageId: msg.id,
      fromAddressId: msg.addressId,
      threadId: forwarding ? null : msg.threadId,
      to: recipients.to,
      cc: recipients.cc,
      subject: replySubject(msg.subject, mode),
      quote:
        mode === "forward_eml"
          ? ""
          : mode === "forward"
            ? `\n\n${forwardHeader(msg)}\n\n${originalText}`
            : `\n\nOn ${msg.occurredAt.toUTCString()}, ${from} wrote:\n${originalText.split("\n").map((l) => `> ${l}`).join("\n")}`,
      snippet: makeSnippet(originalText),
      attachments: [
        ...files.map((f) => ({ filename: f.filename, size: f.size })),
        ...(mode === "forward_eml" && msg.rawMimeKey ? [{ filename: `${msg.subject || "message"}.eml`, size: msg.storedBytes }] : []),
      ],
      canForwardEml: !!msg.rawMimeKey,
    });
  });
