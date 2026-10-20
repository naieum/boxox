/**
 * Attachment filenames as shown and as offered on download. Bidirectional
 * overrides and invisible characters go, so "invoice‮fdp.exe" shows its
 * real ending; path parts, control characters and the trailing dots and
 * spaces Windows ignores go too, so the last extension is the one that runs.
 */

const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
const INVISIBLE = /[­͏ᅟᅠ឴឵᠎​-‍⁠-⁤ㅤ﻿ﾠ]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const RESERVED = /[<>:"|?*]/g;
const MAX_LENGTH = 200;

export const FALLBACK_FILENAME = "attachment";

export function cleanFilename(raw: string | null | undefined): string {
  let name = (raw ?? "").normalize("NFC").replace(BIDI, "").replace(INVISIBLE, "").replace(CONTROL, "");
  name = name.split(/[/\\]/).pop() ?? "";
  name = name
    .replace(RESERVED, "_")
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if ([...name].length > MAX_LENGTH) {
    const chars = [...name];
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? [...name.slice(dot)] : [];
    name = chars.slice(0, MAX_LENGTH - ext.length).join("") + ext.join("");
  }
  return name || FALLBACK_FILENAME;
}

/** Everything after the first dot, lowercased: "a.tar.gz" → ["tar", "gz"]. */
export function extensionsOf(filename: string): string[] {
  return filename.toLowerCase().split(".").slice(1).filter(Boolean);
}

const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "docm", "xls", "xlsx", "xlsm", "ppt", "pptx", "pptm", "odt", "ods", "odp", "rtf",
  "txt", "csv", "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "mp3", "mp4", "mov",
  "wav", "zip", "rar", "7z", "eml", "html", "htm",
]);

const COMPRESSED = new Set(["zip", "gz", "bz2", "xz", "7z", "rar"]);

/**
 * "invoice.pdf.exe": a familiar document extension in front of another one,
 * so a viewer that hides the last extension shows a harmless name.
 * "backup.tar.gz" and "data.csv.zip" are how those are named, not a disguise.
 */
export function hasDoubleExtension(filename: string): boolean {
  const exts = extensionsOf(filename);
  if (exts.length < 2) return false;
  const [inner, outer] = exts.slice(-2) as [string, string];
  if (inner === "tar" || inner === outer || COMPRESSED.has(outer)) return false;
  return DOCUMENT_EXTENSIONS.has(inner);
}
