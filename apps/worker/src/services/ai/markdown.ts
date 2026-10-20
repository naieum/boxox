import { DEFAULT_GATEWAY_ID, type AiConsent, type AiRefusal } from "./run";

/**
 * toMarkdown for documents only. It picks its converter from the Blob's MIME
 * type, and images go to models off the allow-list (docs/spikes/ai.md), so the
 * Blob's type always comes from this table, keyed by the detected type, and
 * never from the attachment's own Content-Type. Anything not listed, images
 * and SVG included, is never sent.
 */
const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "application/pdf",
  "text/html": "text/html",
  "application/xhtml+xml": "text/html",
  "text/csv": "text/csv",
  "application/xml": "application/xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroEnabled.12": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12": "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel": "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.text": "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet": "application/vnd.oasis.opendocument.spreadsheet",
};

/** Documents bigger than this aren't converted; the download still works. */
export const MARKDOWN_MAX_BYTES = 10 * 1024 * 1024;

export function markdownTypeFor(detectedType: string): string | null {
  return DOCUMENT_TYPES[detectedType] ?? null;
}

export interface MarkdownDeps {
  ai: Pick<Ai, "toMarkdown">;
  consent: AiConsent;
  gatewayId?: string;
}

export type MarkdownResult =
  | { ok: true; text: string }
  | { ok: false; reason: AiRefusal | "unsupported-type" | "too-large" | "conversion-failed" };

export async function documentToMarkdown(
  deps: MarkdownDeps,
  doc: { name: string; detectedType: string; bytes: Uint8Array; address?: string },
): Promise<MarkdownResult> {
  if (!deps.consent.enabled || !deps.consent.provider) return { ok: false, reason: "ai-off" };
  if (doc.address && deps.consent.disabledAddresses?.includes(doc.address.toLowerCase())) return { ok: false, reason: "address-opted-out" };
  const type = markdownTypeFor(doc.detectedType);
  if (!type) return { ok: false, reason: "unsupported-type" };
  if (doc.bytes.byteLength > MARKDOWN_MAX_BYTES) return { ok: false, reason: "too-large" };

  const result = await deps.ai.toMarkdown(
    { name: doc.name, blob: new Blob([doc.bytes], { type }) },
    { gateway: { id: deps.gatewayId ?? DEFAULT_GATEWAY_ID, skipCache: true, collectLog: false } },
  );
  if (result.format !== "markdown") return { ok: false, reason: "conversion-failed" };
  return { ok: true, text: result.data };
}
