/**
 * What a send_email error means for the message (docs/spikes/email.md). The
 * binding has no idempotency, so only errors raised before anything was sent
 * may be retried; anything unrecognised might have gone out and is never
 * retried automatically.
 */
export type SendErrorKind = "permanent" | "retryable" | "ambiguous";

/** Rejected before sending: nothing went out. */
const PERMANENT_CODES = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_CONTENT_TOO_LARGE",
]);

/** Rejected before sending, and worth trying again later. */
const RETRYABLE_CODES = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"]);

export function sendErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export function classifySendError(err: unknown): SendErrorKind {
  // A missing field throws a plain TypeError with no code, before sending.
  if (err instanceof TypeError) return "permanent";
  const code = sendErrorCode(err);
  if (!code) return "ambiguous";
  if (PERMANENT_CODES.has(code) || code.startsWith("E_HEADER_")) return "permanent";
  if (RETRYABLE_CODES.has(code)) return "retryable";
  return "ambiguous";
}

export function sendErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = sendErrorCode(err);
  // Bounded: send errors are shown to users and stored indefinitely.
  return (code ? `${code}: ${message}` : message).slice(0, 500);
}
