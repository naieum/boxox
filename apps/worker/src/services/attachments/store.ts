import { detectType, readZipDirectory } from "./detect";
import { cleanFilename } from "./filename";
import { classifyRisk, type AttachmentRisk } from "./risk";

/** Bytes live once in R2 under their SHA-256; every message that carries them points at the same object. */
export const attachmentKey = (sha256: string) => `att/${sha256}`;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IncomingAttachment {
  filename: string | null;
  contentType: string | null;
  content: Uint8Array;
  contentId?: string | null;
  inline?: boolean;
}

/** What D1 keeps about one attachment; the bytes are at attachmentKey(sha256). */
export interface AttachmentFacts {
  sha256: string;
  r2Key: string;
  filename: string;
  declaredType: string | null;
  detectedType: string;
  size: number;
  risk: AttachmentRisk;
  contentId: string | null;
  inline: boolean;
}

export async function describeAttachment(att: IncomingAttachment): Promise<AttachmentFacts> {
  const filename = cleanFilename(att.filename);
  const detectedType = detectType(att.content, filename);
  // Zip flags are read from its directory; the entries themselves are never inflated.
  const encrypted = detectedType === "application/zip" && !!readZipDirectory(att.content)?.encrypted;
  const sha256 = await sha256Hex(att.content);
  return {
    sha256,
    r2Key: attachmentKey(sha256),
    filename,
    declaredType: att.contentType?.split(";")[0]?.trim().toLowerCase() || null,
    detectedType,
    size: att.content.byteLength,
    risk: classifyRisk({ filename, detectedType, encrypted }),
    contentId: normalizeContentId(att.contentId),
    inline: !!att.inline,
  };
}

/** "<Logo@Example>" and "cid:Logo%40Example" name the same part. */
export function normalizeContentId(cid: string | null | undefined): string | null {
  if (!cid) return null;
  let value = cid.trim().replace(/^cid:/i, "").replace(/^<|>$/g, "").trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // not percent-encoded
  }
  return value.toLowerCase() || null;
}

/**
 * Writes the bytes unless an object with this hash is already there.
 * `created` is false for a repeat, so callers count stored bytes once.
 */
export async function putAttachment(bucket: R2Bucket, facts: Pick<AttachmentFacts, "r2Key" | "detectedType">, content: Uint8Array): Promise<{ created: boolean }> {
  if (await bucket.head(facts.r2Key)) return { created: false };
  await bucket.put(facts.r2Key, content, { httpMetadata: { contentType: facts.detectedType } });
  return { created: true };
}

export async function storeAttachment(bucket: R2Bucket, att: IncomingAttachment): Promise<AttachmentFacts & { created: boolean }> {
  const facts = await describeAttachment(att);
  const { created } = await putAttachment(bucket, facts, att.content);
  return { ...facts, created };
}
