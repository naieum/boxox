import { log } from "../log";
import { copyRecentApiSentMessages } from "../services/api-sent-copy";
import { and, desc, eq, exists, gte, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { addresses, blockedSenders, domains, labels, messages, threadLabels, threads } from "@boxox/db";
import { THREAD_FOLDERS, threadActionSchema, threadClaimSchema } from "@boxox/shared";
import { writeAudit } from "../audit";
import { batch } from "../db";
import { requireOrgAdmin, requireOrgMember, type AppContext } from "../middleware";
import { accessibleAddressIds } from "../services/access";
import { rewriteMessageCids } from "../services/attachments";
import { mailAiDeps } from "../services/ai/runtime";
import { hybridSearch } from "../services/search";
import { summarizeThread, suggestReplies } from "../services/assist";
import { CATEGORIES } from "../services/spam/classifier";
import { trainThreadFeedback } from "../services/spam/feedback";
import { prepareMailHtml, type LinkMode } from "./link";

function accessorOf(c: { get: (k: "user" | "orgRole") => unknown }) {
  const user = c.get("user") as { id: string; email: string };
  return { userId: user.id, email: user.email, role: c.get("orgRole") as string };
}

const ASSIST_ERRORS: Record<string, string> = {
  "ai-off": "AI assistance is off. The owner can enable it in Settings.",
  "address-opted-out": "AI assistance is off for this address.",
  "provider-not-consented": "This model needs the owner's provider consent.",
  "budget-spent": "The daily AI budget has been reached. Try again tomorrow.",
  "no-model": "Choose an AI assistant model in Settings first.",
  empty: "There are no messages to summarize or reply to.",
};

function assistResponse(c: Context<AppContext>, result: Awaited<ReturnType<typeof summarizeThread>> | Awaited<ReturnType<typeof suggestReplies>>) {
  if (result.ok) return c.json(result);
  return c.json({ error: { code: result.reason, message: ASSIST_ERRORS[result.reason] ?? "AI assistance could not finish. Try again." } }, 409);
}

/**
 * Content-Disposition value for an attachment download. The ASCII fallback
 * strips CR/LF, quotes, backslashes, and control chars (header-injection
 * vectors) plus non-ASCII; the RFC 5987 form carries the full name
 * UTF-8 percent-encoded. Empty results fall back to "file".
 */
export function attachmentContentDisposition(filename: string): string {
  const stripped = filename.replace(/[\u0000-\u001F\u007F"\\]/g, "").trim();
  const ascii = stripped.replace(/[^\u0020-\u007E]/g, "").trim() || "file";
  const encoded = encodeURIComponent(stripped || "file").replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface ThreadCursor {
  lastMessageAt: Date;
  id: string;
}

/** Opaque `<epochMillis>.<threadId>` cursor for the keyset thread list. */
export function encodeThreadCursor(c: ThreadCursor): string {
  return `${c.lastMessageAt.getTime()}.${c.id}`;
}

/**
 * Parse a client-supplied cursor. Returns null for anything malformed so a
 * junk/hostile value degrades to "first page" rather than erroring or, worse,
 * reaching the query as an unvalidated fragment. The id is carried as a bound
 * parameter, never interpolated.
 */
export function parseThreadCursor(raw: string | undefined): ThreadCursor | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const millis = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (!Number.isSafeInteger(millis) || millis < 0 || !id) return null;
  return { lastMessageAt: new Date(millis), id };
}

const HTML_QUOTE_MARKERS = [
  /<(?:div|blockquote)\b[^>]*\bclass\s*=\s*["']?[^"'>]*\bgmail_(?:quote|signature)\b/i,
  /<blockquote\b[^>]*\btype\s*=\s*["']?cite\b/i,
  /<div\b[^>]*\bid\s*=\s*["']?(?:divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)\b/i,
  /<div\b[^>]*\bclass\s*=\s*["']?[^"'>]*\b(?:yahoo_quoted|moz-cite-prefix)\b/i,
];
const HTML_ATTRIBUTION = /\bOn\s(?:[^<]|<[^>]*>){4,300}?\swrote:/i;

const hasVisibleText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "").length > 0;

/**
 * Splits a message into what the sender wrote and the quoted history or
 * signature under it (Gmail's gmail_quote, blockquote type=cite, Outlook's
 * reply header, "On … wrote:"). The cut is at the earliest marker; nothing is
 * folded when it would leave the message empty.
 */
export function splitQuotedHtml(html: string): { body: string; quoted: string | null } {
  let cut = -1;
  for (const marker of HTML_QUOTE_MARKERS) {
    const at = html.search(marker);
    if (at >= 0 && (cut < 0 || at < cut)) cut = at;
  }
  const attribution = html.search(HTML_ATTRIBUTION);
  if (attribution >= 0 && (cut < 0 || attribution < cut)) {
    // Fold from the block that holds the attribution line, not mid-sentence.
    const before = html.slice(0, attribution);
    const open = Math.max(before.search(/<(?:div|p)\b[^>]*>(?:(?!<(?:div|p)\b)[\s\S])*$/i), before.search(/<br\b[^>]*>\s*$/i));
    cut = open >= 0 ? open : attribution;
  }
  if (cut < 0 || !hasVisibleText(html.slice(0, cut))) return { body: html, quoted: null };
  return { body: html.slice(0, cut), quoted: html.slice(cut) };
}

export function splitQuotedText(text: string): { body: string; quoted: string | null } {
  const lines = text.split(/\r?\n/);
  const isQuote = (l: string) => /^\s*>/.test(l);
  let cut = -1;
  for (let i = 0; i < lines.length && cut < 0; i++) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? "";
    if (
      /^\s*On\s.+\swrote:\s*$/i.test(line) ||
      (/^\s*On\s/i.test(line) && /\swrote:\s*$/i.test(next)) ||
      /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
      (/^\s*_{10,}\s*$/.test(line) && /^\s*From:/i.test(next)) ||
      line === "-- " ||
      (isQuote(line) && lines.slice(i).every((l) => !l.trim() || isQuote(l)))
    ) {
      cut = i;
    }
  }
  const body = cut < 0 ? text : lines.slice(0, cut).join("\n").trimEnd();
  if (cut < 0 || !body.trim()) return { body: text, quoted: null };
  return { body, quoted: lines.slice(cut).join("\n") };
}

const muteSchema = z.object({ muted: z.boolean() });
const snoozeSchema = z.object({ until: z.string().datetime({ offset: true }).nullable() });
const MAX_SNOOZE_MS = 366 * 24 * 3600 * 1000;

/** The thread, when it exists in this org and the caller can read its mailbox. */
async function readableThread(c: Context<AppContext>, threadId: string) {
  const db = c.get("db");
  const orgId = c.get("orgId");
  const [thread] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.organizationId, orgId)))
    .limit(1);
  if (!thread) return { denied: c.json({ error: { code: "not_found", message: "No such thread" } }, 404) } as const;
  const readable = await accessibleAddressIds(db, orgId, accessorOf(c), "read");
  if (readable !== null && (!thread.addressId || !readable.includes(thread.addressId))) {
    return { denied: c.json({ error: { code: "forbidden", message: "No access to this mailbox" } }, 403) } as const;
  }
  return { thread } as const;
}

async function labelsOf(db: AppContext["Variables"]["db"], threadIds: string[]) {
  const byThread = new Map<string, { id: string; name: string; color: string | null }[]>();
  if (!threadIds.length) return byThread;
  const rows = await db
    .select({ threadId: threadLabels.threadId, id: labels.id, name: labels.name, color: labels.color })
    .from(threadLabels)
    .innerJoin(labels, eq(threadLabels.labelId, labels.id))
    .where(inArray(threadLabels.threadId, threadIds))
    .orderBy(sql`lower(${labels.name})`);
  for (const { threadId, ...label } of rows) byThread.set(threadId, [...(byThread.get(threadId) ?? []), label]);
  return byThread;
}

type AttachmentMeta = {
  filename: string;
  size: number;
  r2Key?: string | null;
  truncated?: boolean;
};

export const threadRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember)

  // List threads. folder: inbox|archive|trash|starred|sent|snoozed|label, optional addressId + unread filter.
  .get("/", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const folder = c.req.query("folder") ?? "inbox";
    if (c.get("user").role === "owner" && (folder === "inbox" || folder === "sent")) {
      await copyRecentApiSentMessages(c.env, orgId).catch(error => log.warn("api_sent_copy_failed", { error }));
    }
    const addressId = c.req.query("addressId");
    const unreadOnly = c.req.query("unread") === "true";

    const readable = await accessibleAddressIds(db, orgId, accessorOf(c), "read");
    if (readable !== null && readable.length === 0) return c.json({ threads: [] });

    const conds: SQL[] = [eq(threads.organizationId, orgId)];
    if (readable !== null) conds.push(inArray(threads.addressId, readable));
    if (addressId) conds.push(eq(threads.addressId, addressId));
    if (unreadOnly) conds.push(eq(threads.unread, true));

    if (folder === "starred") {
      conds.push(eq(threads.starred, true), sql`${threads.folder} != 'trash'`);
    } else if (folder === "priority") {
      conds.push(eq(threads.folder, "inbox"), gte(threads.priority, 2));
    } else if (folder === "category") {
      const category = c.req.query("category");
      if (!category || !(CATEGORIES as readonly string[]).includes(category)) {
        return c.json({ error: { code: "bad_request", message: "Choose a valid mail category" } }, 400);
      }
      conds.push(eq(threads.category, category), sql`${threads.folder} != 'trash'`);
    } else if (folder === "sent") {
      conds.push(
        sql`${threads.folder} != 'trash'`,
        exists(
          db
            .select({ one: sql`1` })
            .from(messages)
            .where(and(eq(messages.threadId, threads.id), eq(messages.direction, "outbound"))),
        ),
      );
    } else if (folder === "snoozed") {
      conds.push(isNotNull(threads.snoozedUntil), eq(threads.folder, "archive"));
    } else if (folder === "label") {
      const labelId = c.req.query("labelId");
      if (!labelId) return c.json({ threads: [], nextCursor: null });
      conds.push(
        sql`${threads.folder} NOT IN ('trash', 'spam')`,
        exists(
          db
            .select({ one: sql`1` })
            .from(threadLabels)
            .where(and(eq(threadLabels.threadId, threads.id), eq(threadLabels.labelId, labelId))),
        ),
      );
    } else if ((THREAD_FOLDERS as readonly string[]).includes(folder)) {
      conds.push(eq(threads.folder, folder as (typeof THREAD_FOLDERS)[number]));
    } else {
      return c.json({ threads: [] }); // drafts/scheduled arrive later
    }

    // Keyset pagination. The previous hard `limit(100)` with no cursor did not
    // merely make old mail slow to reach — it made it unreachable: past 100
    // threads in a folder there was no way to ask for the next page at all.
    //
    // Keyset, not OFFSET: the sort key is lastMessageAt, which inbound mail
    // mutates constantly, so OFFSET would skip and repeat rows as threads move.
    // `id` breaks ties so the order is total and the cursor can never stall on
    // a group of threads sharing a timestamp.
    const PAGE_SIZE = 100;
    const cursor = parseThreadCursor(c.req.query("cursor"));
    if (cursor) {
      // Bound as epoch millis, the column's storage form: in a raw `sql`
      // fragment drizzle has no column type to encode a Date with.
      conds.push(
        sql`(${threads.lastMessageAt}, ${threads.id}) < (${cursor.lastMessageAt.getTime()}, ${cursor.id})`,
      );
    }

    const rows = await db
      .select({
        id: threads.id,
        subject: threads.subject,
        snippet: threads.snippet,
        folder: threads.folder,
        starred: threads.starred,
        unread: threads.unread,
        priority: threads.priority,
        category: threads.category,
        muted: threads.muted,
        snoozedUntil: threads.snoozedUntil,
        messageCount: threads.messageCount,
        lastMessageAt: threads.lastMessageAt,
        counterpartyEmail: threads.counterpartyEmail,
        counterpartyName: threads.counterpartyName,
        addressId: threads.addressId,
        originalRecipient: threads.originalRecipient,
        addressLocal: addresses.localPart,
        domainName: domains.name,
      })
      .from(threads)
      .leftJoin(addresses, eq(threads.addressId, addresses.id))
      .leftJoin(domains, eq(addresses.domainId, domains.id))
      .where(and(...conds))
      .orderBy(desc(threads.lastMessageAt), desc(threads.id))
      .limit(PAGE_SIZE + 1); // one extra row tells us whether a next page exists

    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const pageLabels = await labelsOf(db, page.map((t) => t.id));
    return c.json({
      threads: page.map((t) => ({
        ...t,
        lastMessageAt: t.lastMessageAt.toISOString(),
        snoozedUntil: t.snoozedUntil?.toISOString() ?? null,
        labels: pageLabels.get(t.id) ?? [],
        address: t.addressLocal ? `${t.addressLocal}@${t.domainName}` : (t.originalRecipient ?? "unrouted"),
      })),
      nextCursor:
        rows.length > PAGE_SIZE && last
          ? encodeThreadCursor({ lastMessageAt: last.lastMessageAt, id: last.id })
          : null,
    });
  })

  /** FTS5 plus consented semantic search, hydrated in rank order within the caller's mailboxes. */
  .get("/search", async (c) => {
    c.header("cache-control", "no-store, private");
    const db = c.get("db");
    const orgId = c.get("orgId");
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ threads: [], query: "" });

    const readable = await accessibleAddressIds(db, orgId, accessorOf(c), "read");
    if (readable !== null && readable.length === 0) return c.json({ threads: [], query: q });

    const result = await hybridSearch(await mailAiDeps(c.env, db), { query: q, addressIds: readable, orgId });
    if (!result.hits.length) return c.json({ threads: [], query: q, mode: result.mode });
    const conds: SQL[] = [
      eq(threads.organizationId, orgId),
      inArray(threads.id, result.hits.map((h) => h.threadId)),
    ];
    if (readable !== null) conds.push(inArray(threads.addressId, readable));

    const rows = await db
      .select({
        id: threads.id,
        subject: threads.subject,
        snippet: threads.snippet,
        folder: threads.folder,
        starred: threads.starred,
        unread: threads.unread,
        priority: threads.priority,
        category: threads.category,
        muted: threads.muted,
        snoozedUntil: threads.snoozedUntil,
        messageCount: threads.messageCount,
        lastMessageAt: threads.lastMessageAt,
        counterpartyEmail: threads.counterpartyEmail,
        counterpartyName: threads.counterpartyName,
        addressId: threads.addressId,
        originalRecipient: threads.originalRecipient,
        addressLocal: addresses.localPart,
        domainName: domains.name,
      })
      .from(threads)
      .leftJoin(addresses, eq(threads.addressId, addresses.id))
      .leftJoin(domains, eq(addresses.domainId, domains.id))
      .where(and(...conds));

    const ranks = new Map(result.hits.map((h, i) => [h.threadId, i]));
    rows.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
    const pageLabels = await labelsOf(db, rows.map((t) => t.id));

    return c.json({
      query: q,
      mode: result.mode,
      threads: rows.map((t) => ({
        ...t,
        lastMessageAt: t.lastMessageAt.toISOString(),
        snoozedUntil: t.snoozedUntil?.toISOString() ?? null,
        labels: pageLabels.get(t.id) ?? [],
        address: t.addressLocal
          ? `${t.addressLocal}@${t.domainName}`
          : (t.originalRecipient ?? "unrouted"),
      })),
    });
  })

  // AI never runs while loading a thread. These explicit POST actions re-check its read grant first.
  .post("/:threadId/summary", async (c) => {
    const found = await readableThread(c, c.req.param("threadId"));
    if (found.denied) return found.denied;
    c.header("cache-control", "no-store, private");
    const result = await summarizeThread(await mailAiDeps(c.env, c.get("db")), found.thread.id);
    return assistResponse(c, result);
  })
  .post("/:threadId/replies", async (c) => {
    const found = await readableThread(c, c.req.param("threadId"));
    if (found.denied) return found.denied;
    c.header("cache-control", "no-store, private");
    const result = await suggestReplies(await mailAiDeps(c.env, c.get("db")), found.thread.id);
    return assistResponse(c, result);
  })

  // Thread detail with message bodies (fetched from R2).
  .get("/:threadId", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const threadId = c.req.param("threadId");

    const found = await readableThread(c, threadId);
    if (found.denied) return found.denied;
    const { thread } = found;
    const links: LinkMode = thread.folder === "quarantine" ? "disabled" : thread.folder === "spam" ? "warn" : "direct";

    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(messages.occurredAt);

    const withBodies = await Promise.all(
      msgs.map(async (m) => {
        let html: string | null = null;
        let text: string | null = null;
        let quotedHtml: string | null = null;
        let quotedText: string | null = null;
        const obj = await c.env.MAIL_STORE.get(m.r2Key);
        if (obj) {
          try {
            const raw = (await obj.json()) as {
              data?: { html?: string | null; text?: string | null };
              html?: string | null;
              text?: string | null;
            };
            html = raw.data?.html ?? raw.html ?? null;
            if (html) html = await rewriteMessageCids(db, orgId, m.id, html);
            text = raw.data?.text ?? raw.text ?? null;
            if (html) ({ body: html, quoted: quotedHtml } = splitQuotedHtml(html));
            if (html) html = await prepareMailHtml(c.env, html, { links });
            if (quotedHtml) quotedHtml = await prepareMailHtml(c.env, quotedHtml, { links });
            if (text) ({ body: text, quoted: quotedText } = splitQuotedText(text));
          } catch {
            // body unreadable; metadata still renders
          }
        }
        return {
          id: m.id,
          direction: m.direction,
          fromEmail: m.fromEmail,
          fromName: m.fromName,
          toEmails: m.toEmails,
          ccEmails: m.ccEmails,
          subject: m.subject,
          snippet: m.snippet,
          authenticated: m.authenticated,
          newParticipant: m.newParticipant,
          spamVerdict: m.direction === "inbound" ? m.spamVerdict : null,
          html,
          text,
          quotedHtml,
          quotedText,
          attachments: (m.attachmentsMeta as AttachmentMeta[]).map((a, index) => ({
            filename: a.filename,
            size: a.size,
            index,
            messageId: m.id,
            truncated: a.truncated === true,
          })),
          occurredAt: m.occurredAt.toISOString(),
        };
      }),
    );

    return c.json({
      thread: {
        id: thread.id,
        subject: thread.subject,
        folder: thread.folder,
        starred: thread.starred,
        unread: thread.unread,
        priority: thread.priority,
        category: thread.category,
        addressId: thread.addressId,
        domainId: thread.domainId,
        originalRecipient: thread.originalRecipient,
        counterpartyEmail: thread.counterpartyEmail,
        counterpartyName: thread.counterpartyName,
        participants: thread.participants,
        muted: thread.muted,
        snoozedUntil: thread.snoozedUntil?.toISOString() ?? null,
        labels: (await labelsOf(db, [thread.id])).get(thread.id) ?? [],
      },
      messages: withBodies,
    });
  })

  // Stream one attachment. Always octet-stream + attachment disposition —
  // serving the stored contentType would let hostile HTML/SVG render on our origin.
  .get("/:threadId/attachments/:messageId/:index", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const threadId = c.req.param("threadId");
    const messageId = c.req.param("messageId");

    const trow = await db
      .select({ addressId: threads.addressId })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.organizationId, orgId)))
      .limit(1);
    if (!trow[0]) {
      return c.json({ error: { code: "not_found", message: "No such thread" } }, 404);
    }
    const readable = await accessibleAddressIds(db, orgId, accessorOf(c), "read");
    if (readable !== null && (!trow[0].addressId || !readable.includes(trow[0].addressId))) {
      return c.json({ error: { code: "forbidden", message: "No access to this mailbox" } }, 403);
    }

    const mrow = await db
      .select({ attachmentsMeta: messages.attachmentsMeta })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.threadId, threadId)))
      .limit(1);
    if (!mrow[0]) {
      return c.json({ error: { code: "not_found", message: "No such message" } }, 404);
    }

    const index = Number(c.req.param("index"));
    const meta = mrow[0].attachmentsMeta as AttachmentMeta[];
    const att = Number.isInteger(index) && index >= 0 ? meta[index] : undefined;
    if (!att || !att.r2Key || att.truncated) {
      return c.json({ error: { code: "not_found", message: "No such attachment" } }, 404);
    }

    const obj = await c.env.MAIL_STORE.get(att.r2Key);
    if (!obj) {
      return c.json({ error: { code: "not_found", message: "Attachment data missing" } }, 404);
    }

    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(obj.size),
        "Content-Disposition": attachmentContentDisposition(att.filename),
        "X-Content-Type-Options": "nosniff",
      },
    });
  })

  // Claim an unrouted thread: mint the typo'd address, or deliver to an existing one.
  .post("/:threadId/claim", requireOrgAdmin, async (c) => {
    const parsed = threadClaimSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: "Invalid claim" } }, 400);
    }
    const db = c.get("db");
    const orgId = c.get("orgId");
    const threadId = c.req.param("threadId");
    const trow = await db
      .select()
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.organizationId, orgId)))
      .limit(1);
    const thread = trow[0];
    if (!thread || thread.folder !== "unrouted") {
      return c.json({ error: { code: "not_found", message: "No such unrouted thread" } }, 404);
    }

    let targetAddressId: string;
    let mintedAddress: string | null = null;
    if (parsed.data.mode === "create") {
      if (!thread.domainId || !thread.originalRecipient) {
        return c.json({ error: { code: "bad_state", message: "Thread has no origin domain" } }, 409);
      }
      const localPart = thread.originalRecipient.split("@")[0]!.toLowerCase();
      const existing = await db
        .select({ id: addresses.id })
        .from(addresses)
        .where(and(eq(addresses.domainId, thread.domainId), eq(addresses.localPart, localPart)))
        .limit(1);
      if (existing[0]) {
        targetAddressId = existing[0].id;
      } else {
        targetAddressId = crypto.randomUUID();
        await db.insert(addresses).values({
          id: targetAddressId,
          domainId: thread.domainId,
          organizationId: orgId,
          localPart,
          kind: parsed.data.kind,
          createdBy: c.get("user").id,
        });
        mintedAddress = thread.originalRecipient;
      }
    } else {
      const target = await db
        .select({ id: addresses.id })
        .from(addresses)
        .where(and(eq(addresses.id, parsed.data.addressId), eq(addresses.organizationId, orgId)))
        .limit(1);
      if (!target[0]) {
        return c.json({ error: { code: "not_found", message: "No such address" } }, 404);
      }
      targetAddressId = target[0].id;
    }

    // One atomic unit: the thread's routing and its messages' routing must move
    // together. Split across two statements, a failure between them left the
    // thread in `inbox` while its messages still had addressId NULL — visible
    // in the mailbox list but excluded from every address-scoped query.
    //
    // dedupeScope deliberately does NOT move. It is the historical identity of
    // how the message was received, not where it now lives. Rewriting it to the
    // claimed address would collide with messages_dedupe_idx whenever one email
    // reached both a routed and a held recipient on the same domain (same
    // Message-ID, and after the rewrite the same scope) — turning an ordinary
    // claim into a 500. The rows keep their `held:<recipient>` key, which stays
    // unique and still describes what actually happened.
    const now = new Date();
    await batch(db, [
      db
        .update(threads)
        .set({ addressId: targetAddressId, folder: "inbox", updatedAt: now })
        .where(eq(threads.id, threadId)),
      db
        .update(messages)
        .set({ addressId: targetAddressId })
        .where(eq(messages.threadId, threadId)),
    ]);

    await writeAudit(db, {
      organizationId: orgId,
      actorType: "user",
      actorId: c.get("user").id,
      action: "thread.claimed",
      targetType: "thread",
      targetId: threadId,
      metadata: {
        mode: parsed.data.mode,
        addressId: targetAddressId,
        originalRecipient: thread.originalRecipient,
        mintedAddress,
      },
    });
    if (mintedAddress) {
      await writeAudit(db, {
        organizationId: orgId,
        actorType: "user",
        actorId: c.get("user").id,
        action: "address.created",
        targetType: "address",
        targetId: targetAddressId,
        metadata: { address: mintedAddress, kind: parsed.data.mode === "create" ? parsed.data.kind : "role", via: "claim" },
      });
    }
    return c.json({ ok: true, addressId: targetAddressId });
  })

  // Thread actions: read/unread/star/unstar/archive/trash/restore.
  .post("/:threadId/actions", async (c) => {
    const parsed = threadActionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: "Invalid action" } }, 400);
    }
    const db = c.get("db");
    const orgId = c.get("orgId");
    const threadId = c.req.param("threadId");

    const trow = await db
      .select({
        addressId: threads.addressId,
        counterpartyEmail: threads.counterpartyEmail,
        outgoingOnly: sql<boolean>`EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.direction = 'outbound') AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.direction = 'inbound')`,
      })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.organizationId, orgId)))
      .limit(1);
    if (!trow[0]) {
      return c.json({ error: { code: "not_found", message: "No such thread" } }, 404);
    }
    const readable = await accessibleAddressIds(db, orgId, accessorOf(c), "read");
    const actAddressId = trow[0].addressId;
    if (readable !== null && (!actAddressId || !readable.includes(actAddressId))) {
      return c.json({ error: { code: "forbidden", message: "No access to this mailbox" } }, 403);
    }

    if ((c.get("orgRole") === "owner" || c.get("orgRole") === "admin") &&
        ["spam", "not_spam"].includes(parsed.data.action)) {
      await trainThreadFeedback(db, c.env.MAIL_STORE, orgId, threadId, parsed.data.action === "not_spam" ? "ham" : "spam");
    }

    if (parsed.data.action === "block_sender") {
      // This affects SMTP delivery for every mailbox, not only this thread.
      if (c.get("orgRole") !== "owner") {
        return c.json({ error: { code: "forbidden", message: "Installation owner required" } }, 403);
      }
      const sender = trow[0].counterpartyEmail?.toLowerCase();
      if (!sender) {
        return c.json({ error: { code: "bad_state", message: "Thread has no sender to block" } }, 409);
      }
      if (c.get("orgRole") === "owner" || c.get("orgRole") === "admin") {
        await trainThreadFeedback(db, c.env.MAIL_STORE, orgId, threadId, "spam");
      }
      await db
        .insert(blockedSenders)
        .values({
          id: crypto.randomUUID(),
          organizationId: orgId,
          email: sender,
          createdBy: c.get("user").id,
        })
        .onConflictDoNothing({ target: [blockedSenders.organizationId, blockedSenders.email] });
      await db
        .update(threads)
        .set({ folder: "spam", updatedAt: new Date() })
        .where(eq(threads.id, threadId));
      await writeAudit(db, {
        organizationId: orgId,
        actorType: "user",
        actorId: c.get("user").id,
        action: "sender.blocked",
        targetType: "sender",
        targetId: sender,
        metadata: { threadId },
      });
      return c.json({ ok: true });
    }

    // not_spam also unblocks the sender: ingest re-runs the folder decision on
    // every inbound message, so a lingering blocklist row would re-file the
    // very next message into spam with no recovery path.
    if (parsed.data.action === "not_spam" && c.get("orgRole") === "owner") {
      const sender = trow[0].counterpartyEmail?.toLowerCase();
      if (sender) {
        const removed = await db
          .delete(blockedSenders)
          .where(and(eq(blockedSenders.organizationId, orgId), eq(blockedSenders.email, sender)))
          .returning({ id: blockedSenders.id });
        if (removed.length > 0) {
          await writeAudit(db, {
            organizationId: orgId,
            actorType: "user",
            actorId: c.get("user").id,
            action: "sender.unblocked",
            targetType: "sender",
            targetId: sender,
            metadata: { threadId },
          });
        }
      }
    }

    const patch: Partial<typeof threads.$inferInsert> = { updatedAt: new Date() };
    switch (parsed.data.action) {
      case "read":
        patch.unread = false;
        break;
      case "unread":
        patch.unread = true;
        break;
      case "star":
        patch.starred = true;
        break;
      case "unstar":
        patch.starred = false;
        break;
      case "archive":
        patch.folder = "archive";
        break;
      case "trash":
        patch.folder = "trash";
        patch.snoozedUntil = null;
        break;
      case "restore":
        patch.folder = trow[0].outgoingOnly ? "sent" : "inbox";
        patch.snoozedUntil = null;
        break;
      case "spam":
        patch.folder = "spam";
        break;
      case "not_spam":
        patch.folder = "inbox";
        break;
    }
    await db.update(threads).set(patch).where(eq(threads.id, threadId));
    return c.json({ ok: true });
  })

  // Mute: the conversation leaves the inbox and later replies stay out of it.
  .post("/:threadId/mute", async (c) => {
    const parsed = muteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: "Invalid mute" } }, 400);
    }
    const found = await readableThread(c, c.req.param("threadId"));
    if (found.denied) return found.denied;
    const { muted } = parsed.data;
    await c
      .get("db")
      .update(threads)
      .set({
        muted,
        ...(muted && found.thread.folder === "inbox" ? { folder: "archive" as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(threads.id, found.thread.id));
    return c.json({ ok: true, muted });
  })

  // Snooze: out of the inbox until `until`, when SnoozeWorkflow brings it back. null unsnoozes.
  .post("/:threadId/snooze", async (c) => {
    const parsed = snoozeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: "Invalid snooze" } }, 400);
    }
    const found = await readableThread(c, c.req.param("threadId"));
    if (found.denied) return found.denied;
    const { thread } = found;
    const db = c.get("db");

    if (parsed.data.until === null) {
      if (thread.snoozedUntil) {
        await db
          .update(threads)
          .set({ snoozedUntil: null, ...(thread.folder === "archive" ? { folder: "inbox" as const } : {}), updatedAt: new Date() })
          .where(eq(threads.id, thread.id));
      }
      return c.json({ ok: true, snoozedUntil: null });
    }

    const until = new Date(parsed.data.until);
    const ahead = until.getTime() - Date.now();
    if (ahead <= 0 || ahead > MAX_SNOOZE_MS) {
      return c.json({ error: { code: "bad_request", message: "Snooze must end in the future, within a year" } }, 400);
    }
    if (thread.folder !== "inbox" && thread.folder !== "archive") {
      return c.json({ error: { code: "bad_state", message: "Only inbox and archived threads can be snoozed" } }, 409);
    }
    // The instance first: a thread archived with nothing to wake it would be lost.
    const instanceId = `snooze-${thread.id}-${until.getTime()}`;
    try {
      await c.env.SNOOZE_WORKFLOW.create({ id: instanceId, params: { threadId: thread.id, until: until.toISOString() } });
    } catch (err) {
      // The same snooze asked for twice: its instance already exists.
      await c.env.SNOOZE_WORKFLOW.get(instanceId).catch(() => {
        throw err;
      });
    }
    await db.update(threads).set({ snoozedUntil: until, folder: "archive", updatedAt: new Date() }).where(eq(threads.id, thread.id));
    return c.json({ ok: true, snoozedUntil: until.toISOString() });
  })

  .put("/:threadId/labels/:labelId", async (c) => {
    const found = await readableThread(c, c.req.param("threadId"));
    if (found.denied) return found.denied;
    const db = c.get("db");
    const [label] = await db.select({ id: labels.id }).from(labels).where(eq(labels.id, c.req.param("labelId"))).limit(1);
    if (!label) return c.json({ error: { code: "not_found", message: "No such label" } }, 404);
    await db.insert(threadLabels).values({ threadId: found.thread.id, labelId: label.id }).onConflictDoNothing();
    return c.json({ ok: true });
  })

  .delete("/:threadId/labels/:labelId", async (c) => {
    const found = await readableThread(c, c.req.param("threadId"));
    if (found.denied) return found.denied;
    await c
      .get("db")
      .delete(threadLabels)
      .where(and(eq(threadLabels.threadId, found.thread.id), eq(threadLabels.labelId, c.req.param("labelId"))));
    return c.json({ ok: true });
  });
