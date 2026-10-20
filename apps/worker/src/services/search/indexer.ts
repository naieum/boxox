import { eq } from "drizzle-orm";
import { addresses, attachments, domains, messages } from "@boxox/db";
import type { Db } from "../../db";
import type { AiDeps } from "../ai";
import { attachmentKey, attachmentText } from "../attachments";
import { embedTexts, type EmbedResult } from "./embed";

/**
 * Attachment text joins the message's search_text after this marker, so the
 * FTS5 triggers index it and a reindex can replace it. unicode61 treats the
 * private-use character as a separator, so it never forms part of a token.
 */
export const ATTACHMENT_MARK = "";
/** Attachment text kept in search_text, on top of the message's own SEARCH_TEXT_LIMIT. */
export const ATTACHMENT_SEARCH_LIMIT = 32 * 1024;

export interface IndexDeps extends AiDeps {
  ai: Pick<Ai, "run" | "toMarkdown">;
  db: Db;
  bucket: R2Bucket;
  /** Null when the Vectorize index isn't bound; keyword indexing still runs. */
  vectors?: Vectorize | null;
  /** Embedding model override from ai_settings.models.embed. */
  model?: string | null;
  /** False skips conversion while preserving previously indexed attachment text. */
  indexAttachmentText?: boolean;
}

export interface IndexResult {
  attachments: number;
  vectors: { ok: true; count: number } | Extract<EmbedResult, { ok: false }> | { ok: false; reason: "no-index" };
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Vector ids: the message itself, then one per attachment with text. */
export const vectorId = (messageId: string, part?: number) => (part === undefined ? messageId : `${messageId}#${part}`);

/**
 * Makes a stored message findable by its attachments' text (keyword) and by
 * meaning (Vectorize). Safe to rerun: the attachment part of search_text is
 * replaced, and vectors are upserted under stable ids.
 */
export async function indexMessage(deps: IndexDeps, messageId: string): Promise<IndexResult | null> {
  const [msg] = await deps.db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      addressId: messages.addressId,
      subject: messages.subject,
      searchText: messages.searchText,
      snippet: messages.snippet,
      localPart: addresses.localPart,
      domain: domains.name,
    })
    .from(messages)
    .leftJoin(addresses, eq(addresses.id, messages.addressId))
    .leftJoin(domains, eq(domains.id, addresses.domainId))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!msg) return null;
  const address = msg.localPart && msg.domain ? `${msg.localPart}@${msg.domain}`.toLowerCase() : undefined;

  const rows = deps.indexAttachmentText === false ? [] : await deps.db
    .select({
      sha256: attachments.sha256,
      filename: attachments.filename,
      detectedType: attachments.detectedType,
      textR2Key: attachments.textR2Key,
    })
    .from(attachments)
    .where(eq(attachments.messageId, messageId));
  const texts: { filename: string; text: string }[] = [];
  for (const row of rows) {
    const result = await attachmentText(deps, { ...row, r2Key: attachmentKey(row.sha256) }, address);
    if (result.ok && collapse(result.text)) texts.push({ filename: row.filename, text: collapse(result.text) });
  }

  const own = (msg.searchText ?? msg.snippet ?? "").split(ATTACHMENT_MARK)[0]!.trimEnd();
  const extra = texts.map((t) => `${t.filename} ${t.text}`).join(" ").slice(0, ATTACHMENT_SEARCH_LIMIT);
  const searchText = deps.indexAttachmentText === false ? (msg.searchText ?? own) : extra ? `${own} ${ATTACHMENT_MARK} ${extra}` : own;
  if (searchText !== (msg.searchText ?? "")) {
    await deps.db.update(messages).set({ searchText }).where(eq(messages.id, messageId));
  }

  const result: IndexResult = { attachments: texts.length, vectors: { ok: false, reason: "no-index" } };
  if (!deps.vectors || !msg.threadId) return result;
  const docs = [collapse(`${msg.subject ?? ""} ${own}`), ...texts.map((t) => `${t.filename}\n${t.text}`)];
  const embedded = await embedTexts(deps, docs, { feature: "search-index", address });
  if (!embedded.ok) return { ...result, vectors: embedded };

  const metadata = { messageId, threadId: msg.threadId, addressId: msg.addressId ?? "" };
  await deps.vectors.upsert(
    embedded.vectors.map((values, i) => ({ id: vectorId(messageId, i === 0 ? undefined : i - 1), values, metadata })),
  );
  return { ...result, vectors: { ok: true, count: embedded.vectors.length } };
}
