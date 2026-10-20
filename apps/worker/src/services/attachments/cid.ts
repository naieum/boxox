import { eq } from "drizzle-orm";
import { attachments } from "@boxox/db";
import type { Db } from "../../db";
import { canServeInline } from "./headers";
import type { AttachmentRisk } from "./risk";
import { normalizeContentId } from "./store";

export interface CidPart {
  id: string;
  contentId: string | null;
  detectedType: string;
  risk: AttachmentRisk;
}

const CID_REF = /(^|["'(\s=,])cid:([^"'()\s<>,]+)/gi;

/**
 * Points `cid:` references in message HTML at the authenticated attachment
 * route. Only parts that may be shown inline are linked; any other reference
 * is left as a dead `cid:` URL, which loads nothing.
 */
export function rewriteCidImages(html: string, parts: readonly CidPart[], urlFor: (attachmentId: string) => string): string {
  const byCid = new Map<string, string>();
  for (const part of parts) {
    if (part.contentId && part.detectedType.startsWith("image/") && canServeInline(part)) byCid.set(part.contentId, part.id);
  }
  if (!byCid.size) return html;
  return html.replace(CID_REF, (whole, lead: string, ref: string) => {
    const id = byCid.get(normalizeContentId(ref) ?? "");
    return id ? `${lead}${escapeAttr(urlFor(id))}` : whole;
  });
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function attachmentUrl(orgId: string, attachmentId: string, opts: { inline?: boolean } = {}): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/attachments/${encodeURIComponent(attachmentId)}${opts.inline ? "?inline=1" : ""}`;
}

/** A stored message's HTML with its inline images pointed at the attachment route. */
export async function rewriteMessageCids(db: Db, orgId: string, messageId: string, html: string): Promise<string> {
  if (!/cid:/i.test(html)) return html;
  const parts = await db
    .select({ id: attachments.id, contentId: attachments.contentId, detectedType: attachments.detectedType, risk: attachments.risk })
    .from(attachments)
    .where(eq(attachments.messageId, messageId));
  return rewriteCidImages(html, parts, (id) => attachmentUrl(orgId, id, { inline: true }));
}
