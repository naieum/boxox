import { INLINE_TYPES, type AttachmentRisk } from "./risk";

/**
 * Content-Disposition with an ASCII fallback stripped of CR/LF, quotes,
 * backslashes and control characters, and the full name in RFC 5987 form.
 */
export function contentDisposition(kind: "attachment" | "inline", filename: string): string {
  const stripped = filename.replace(/[\u0000-\u001f\u007f"\\]/g, "").trim();
  const ascii = stripped.replace(/[^\u0020-\u007e]/g, "").trim() || "file";
  const encoded = encodeURIComponent(stripped || "file").replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface ServedAttachment {
  filename: string;
  detectedType: string;
  risk: AttachmentRisk;
  size: number;
}

export function canServeInline(att: Pick<ServedAttachment, "detectedType" | "risk">): boolean {
  return att.risk === "safe" && INLINE_TYPES.has(att.detectedType);
}

/**
 * Every attachment response: the detected type (never the sender's), nosniff,
 * a sandbox CSP so HTML or SVG can't run script on our origin, and
 * `attachment` unless an inline view was asked for and the type allows it.
 */
export function attachmentHeaders(att: ServedAttachment, opts: { inline?: boolean } = {}): Headers {
  const inline = !!opts.inline && canServeInline(att);
  return new Headers({
    "Content-Type": att.detectedType,
    "Content-Length": String(att.size),
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", att.filename),
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
}
