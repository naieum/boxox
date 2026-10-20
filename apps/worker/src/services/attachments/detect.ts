/**
 * Attachment types from magic bytes. The sender's Content-Type and filename
 * are never trusted; the filename only picks between members of one container
 * family (an OLE2 file is .doc, .xls or .ppt) and marks plain text as CSV.
 * Zips are read by their directory alone: entry names and flags, never data.
 */

const OOXML = {
  word: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-word.document.macroEnabled.12"],
  xl: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel.sheet.macroEnabled.12"],
  ppt: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.ms-powerpoint.presentation.macroEnabled.12"],
} as const;

const OLE2_BY_EXTENSION: Record<string, string> = {
  doc: "application/msword",
  dot: "application/msword",
  xls: "application/vnd.ms-excel",
  xlt: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  pps: "application/vnd.ms-powerpoint",
  msi: "application/x-msi",
  msg: "application/vnd.ms-outlook",
};

const MAX_ZIP_ENTRIES = 10_000;
const TEXT_SNIFF_BYTES = 4096;

export interface ZipDirectory {
  names: string[];
  encrypted: boolean;
}

const u16 = (b: Uint8Array, i: number) => (i + 2 <= b.length ? b[i]! | (b[i + 1]! << 8) : -1);
const u32 = (b: Uint8Array, i: number) => (i + 4 <= b.length ? (u16(b, i) | (u16(b, i + 2) << 16)) >>> 0 : -1);
const has = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
const latin1 = new TextDecoder("latin1");

/** A zip's entry names and whether any entry is encrypted, from the central directory (or local headers). */
export function readZipDirectory(b: Uint8Array): ZipDirectory | null {
  if (!has(b, [0x50, 0x4b])) return null;
  const names: string[] = [];
  let encrypted = false;

  // End of central directory: 22 bytes plus up to 64 KiB of comment, from the end.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd >= 0) {
    let at = u32(b, eocd + 16);
    const count = Math.min(u16(b, eocd + 10), MAX_ZIP_ENTRIES);
    for (let n = 0; n < count && u32(b, at) === 0x02014b50; n++) {
      if (u16(b, at + 8) & 1) encrypted = true;
      const nameLen = u16(b, at + 28);
      names.push(latin1.decode(b.subarray(at + 46, at + 46 + nameLen)));
      at += 46 + nameLen + u16(b, at + 30) + u16(b, at + 32);
    }
    if (names.length) return { names, encrypted };
  }

  // No usable directory: walk the local headers while their sizes are known.
  let at = 0;
  while (names.length < MAX_ZIP_ENTRIES && u32(b, at) === 0x04034b50) {
    const flags = u16(b, at + 6);
    if (flags & 1) encrypted = true;
    const nameLen = u16(b, at + 26);
    names.push(latin1.decode(b.subarray(at + 30, at + 30 + nameLen)));
    const size = u32(b, at + 18);
    if (flags & 8 && size === 0) break;
    at += 30 + nameLen + u16(b, at + 28) + size;
  }
  return names.length || has(b, [0x50, 0x4b, 0x05, 0x06]) ? { names, encrypted } : null;
}

function zipType(b: Uint8Array, dir: ZipDirectory): string {
  const names = new Set(dir.names);
  // ODF stores its type uncompressed as the first entry, "mimetype".
  if (dir.names[0] === "mimetype" && ascii(b, 30, 8) === "mimetype") {
    const declared = ascii(b, 38 + u16(b, 28), Math.min(u32(b, 18), 80));
    if (/^application\/vnd\.oasis\.opendocument\.[a-z.-]+$/.test(declared)) return declared;
  }
  if (names.has("[Content_Types].xml")) {
    const macro = dir.names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n));
    for (const [dirName, [plain, macroType]] of Object.entries(OOXML)) {
      if (dir.names.some((n) => n.startsWith(`${dirName}/`))) return macro ? macroType : plain;
    }
  }
  if (names.has("AndroidManifest.xml") && names.has("classes.dex")) return "application/vnd.android.package-archive";
  if (names.has("META-INF/MANIFEST.MF")) return "application/java-archive";
  return "application/zip";
}

function textType(b: Uint8Array, extension: string): string {
  let head = b.subarray(0, TEXT_SNIFF_BYTES);
  if (has(head, [0xef, 0xbb, 0xbf])) head = head.subarray(3);
  if (head.includes(0)) return "application/octet-stream";
  let text: string;
  try {
    // A cut may land inside a multi-byte character; stream mode tolerates that.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(head, { stream: head.length < b.length });
  } catch {
    return "application/octet-stream";
  }
  if (/[\u0001-\u0008\u000e-\u001a\u001c-\u001f]/.test(text)) return "application/octet-stream";
  const start = text.trimStart().toLowerCase();
  const markup = start.replace(/^(<\?xml[^>]*>|<!--[\s\S]*?-->|\s)*/, "");
  if (/^<svg[\s>]/.test(markup) || (/^<!doctype svg/.test(markup) && markup.includes("<svg"))) return "image/svg+xml";
  if (/^(<!doctype html|<html|<head|<body|<script|<iframe|<meta|<title|<style|<form|<div|<table|<a\s|<img|<p[\s>]|<br|<h[1-6][\s>])/.test(markup)) {
    return "text/html";
  }
  if (start.startsWith("<?xml")) return markup.includes("<svg") ? "image/svg+xml" : markup.includes("<html") ? "application/xhtml+xml" : "application/xml";
  if (start.startsWith("{\\rtf")) return "application/rtf";
  if (start.startsWith("#!")) return "text/x-shellscript";
  if (start.startsWith("%pdf-")) return "application/pdf";
  return extension === "csv" ? "text/csv" : "text/plain";
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** The type the bytes are, whatever the sender said. Unknown binary is application/octet-stream. */
export function detectType(b: Uint8Array, filename = ""): string {
  const ext = extensionOf(filename);
  if (has(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (has(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (has(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF") {
    const form = ascii(b, 8, 4);
    if (form === "WEBP") return "image/webp";
    if (form === "WAVE") return "audio/wav";
    if (form === "AVI ") return "video/x-msvideo";
  }
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (/^(heic|heix|heim|heis|mif1|msf1)$/.test(brand)) return "image/heic";
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("M4A")) return "audio/mp4";
    return "video/mp4";
  }
  if (has(b, [0x00, 0x00, 0x01, 0x00]) && b.length > 6) return "image/x-icon";
  if (has(b, [0x49, 0x49, 0x2a, 0x00]) || has(b, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (ascii(b, 0, 2) === "BM" && b.length >= 26 && u32(b, 14) >= 12 && u32(b, 14) <= 124) return "image/bmp";
  if (ascii(b, 0, 3) === "ID3" || has(b, [0xff, 0xfb]) || has(b, [0xff, 0xf3]) || has(b, [0xff, 0xf2])) return "audio/mpeg";
  if (ascii(b, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(b, 0, 4) === "fLaC") return "audio/flac";
  if (has(b, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";

  if (has(b, [0x50, 0x4b, 0x03, 0x04]) || has(b, [0x50, 0x4b, 0x05, 0x06])) {
    const dir = readZipDirectory(b);
    return dir ? zipType(b, dir) : "application/zip";
  }
  if (has(b, [0x1f, 0x8b])) return "application/gzip";
  if (has(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "application/x-7z-compressed";
  if (ascii(b, 0, 6) === "Rar!\u001a\u0007") return "application/vnd.rar";
  if (ascii(b, 0, 3) === "BZh") return "application/x-bzip2";
  if (has(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "application/x-xz";
  if (ascii(b, 257, 5) === "ustar") return "application/x-tar";
  if (has(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return OLE2_BY_EXTENSION[ext] ?? "application/x-ole-storage";

  if (ascii(b, 0, 2) === "MZ") return "application/x-msdownload";
  if (has(b, [0x7f, 0x45, 0x4c, 0x46])) return "application/x-elf";
  if ([[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((s) => has(b, s))) {
    return "application/x-mach-binary";
  }
  if (ascii(b, 0, 4) === "\0asm") return "application/wasm";
  if (ascii(b, 0, 4) === "L\0\0\0" && has(b, [0x01, 0x14, 0x02, 0x00], 4)) return "application/x-ms-shortcut";
  if (ascii(b, 0x8001, 5) === "CD001" || ascii(b, 0x8801, 5) === "CD001" || ascii(b, 0x9001, 5) === "CD001") {
    return "application/x-iso9660-image";
  }
  if (b.length >= 512 && ascii(b, b.length - 512, 4) === "koly") return "application/x-apple-diskimage";
  if (ascii(b, 0, 8) === "conectix" || ascii(b, 0, 8) === "vhdxfile") return "application/x-virtualdisk";

  return b.length ? textType(b, ext) : "application/octet-stream";
}
