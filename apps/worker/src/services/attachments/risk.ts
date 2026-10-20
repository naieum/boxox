import type { ATTACHMENT_RISKS } from "@boxox/db";
import { extensionOf } from "./detect";
import { hasDoubleExtension } from "./filename";

/**
 * safe: an image or PDF that may be shown inline.
 * previewable: no inline render; a text preview where one can be made, otherwise a plain download.
 * dangerous: download only, behind a warning, and a spam signal.
 */
export type AttachmentRisk = (typeof ATTACHMENT_RISKS)[number];

/** The only types ever served inline. SVG is not among them: it carries script. */
export const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

const DANGEROUS_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/x-shellscript",
  "application/x-msdownload",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-msi",
  "application/x-ms-shortcut",
  "application/wasm",
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/x-iso9660-image",
  "application/x-apple-diskimage",
  "application/x-virtualdisk",
  // rar and 7z can be encrypted without saying so up front; zip says so in its entry flags.
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/vnd.ms-word.document.macroEnabled.12",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
]);

const DANGEROUS_EXTENSIONS = new Set([
  // executables and installers
  "exe", "com", "scr", "pif", "cpl", "msi", "msp", "mst", "dll", "sys", "drv", "ocx", "appx", "msix", "appxbundle",
  "app", "pkg", "dmg", "deb", "rpm", "apk", "ipa", "jar", "elf", "run", "gadget", "application",
  // scripts
  "bat", "cmd", "js", "jse", "mjs", "vbs", "vbe", "vb", "wsf", "wsh", "wsc", "ps1", "psm1", "psd1", "ps1xml",
  "sh", "bash", "zsh", "csh", "ksh", "command", "py", "pyw", "pl", "rb", "php", "hta", "sct", "scf", "reg",
  "inf", "ins", "isp", "msc", "mshxml", "chm", "lnk", "url", "website", "desktop", "settingcontent-ms",
  "library-ms", "searchconnector-ms", "appref-ms", "iqy", "slk", "xll", "wll", "one",
  // markup that runs script when opened
  "html", "htm", "xhtml", "shtml", "mht", "mhtml", "svg", "svgz", "xml", "xsl", "xslt",
  // macro-enabled Office
  "docm", "dotm", "xlsm", "xltm", "xlam", "xlsb", "pptm", "potm", "ppam", "ppsm", "sldm",
  // disk images
  "iso", "img", "vhd", "vhdx", "vmdk",
]);

/** Extensions that promise an inline type; bytes of any other type behind one are a disguise. */
const INLINE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

export interface RiskInput {
  filename: string;
  detectedType: string;
  /** An encrypted zip entry: its contents can't be checked. */
  encrypted?: boolean;
}

export function classifyRisk({ filename, detectedType, encrypted }: RiskInput): AttachmentRisk {
  const ext = extensionOf(filename);
  if (encrypted || DANGEROUS_TYPES.has(detectedType) || DANGEROUS_EXTENSIONS.has(ext) || hasDoubleExtension(filename)) return "dangerous";
  const promised = INLINE_EXTENSIONS[ext];
  if (promised && promised !== detectedType) return "dangerous";
  return INLINE_TYPES.has(detectedType) ? "safe" : "previewable";
}
