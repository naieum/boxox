import { eq } from "drizzle-orm";
import { attachments } from "@boxox/db";
import type { Db } from "../../db";
import { documentToMarkdown, type MarkdownDeps, type MarkdownResult } from "../ai/markdown";

/** One text object per hash, like the bytes: the same file converts once. */
export const attachmentTextKey = (sha256: string) => `att-text/${sha256}.md`;

/** Search, spam checks and agents only need the start of a long document. */
export const MAX_ATTACHMENT_TEXT_CHARS = 200_000;

export interface TextSource {
  sha256: string;
  r2Key: string;
  filename: string;
  detectedType: string;
  textR2Key: string | null;
}

/**
 * The attachment's toMarkdown text, from R2 when it was converted before.
 * Archives, images and other non-documents are never converted, and nothing
 * here unpacks or inflates anything.
 */
export async function attachmentText(
  deps: MarkdownDeps & { db: Db; bucket: R2Bucket },
  att: TextSource,
  address?: string,
): Promise<MarkdownResult> {
  const key = attachmentTextKey(att.sha256);
  const cached = await deps.bucket.get(att.textR2Key ?? key);
  if (cached) {
    if (!att.textR2Key) await deps.db.update(attachments).set({ textR2Key: key }).where(eq(attachments.sha256, att.sha256));
    return { ok: true, text: await cached.text() };
  }

  const obj = await deps.bucket.get(att.r2Key);
  if (!obj) return { ok: false, reason: "conversion-failed" };
  const result = await documentToMarkdown(deps, {
    name: att.filename,
    detectedType: att.detectedType,
    bytes: new Uint8Array(await obj.arrayBuffer()),
    address,
  });
  if (!result.ok) return result;

  const text = result.text.slice(0, MAX_ATTACHMENT_TEXT_CHARS);
  await deps.bucket.put(key, text, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  await deps.db.update(attachments).set({ textR2Key: key }).where(eq(attachments.sha256, att.sha256));
  return { ok: true, text };
}
