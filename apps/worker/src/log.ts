/**
 * The only logger the Worker uses. Message bodies, headers and credentials never
 * reach Workers Logs: sensitive fields are dropped by name, and anything that
 * looks like a token is scrubbed from the strings that remain.
 */

type Level = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const REDACTED = "[redacted]";
const MAX_STRING = 300;
const MAX_DEPTH = 4;

const SENSITIVE_WORDS = new Set([
  "body", "bodies", "html", "text", "raw", "content", "subject", "snippet", "attachment", "attachments",
  "header", "headers", "cookie", "cookies", "authorization", "bearer", "assertion",
  "token", "tokens", "jwt", "secret", "secrets", "password", "credential", "credentials",
  "key", "keys", "signature", "pairing", "otp",
]);

const TOKEN_PATTERNS = [
  /\bBearer\s+\S+/gi,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g,
  /\b(?:bx[mk]|whsec|re|sk|pk|rk)_[\w+/=-]{8,}/g,
  /\bsk-(?:ant-)?[\w-]{16,}/g,
];

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  return words(key).some((w) => SENSITIVE_WORDS.has(w));
}

function scrub(s: string): string {
  // Drizzle includes SQL parameters in Error.message. Those parameters can be
  // subjects/snippets or secrets, with no recognizable token shape to scrub.
  if (/\bFailed query:|\bD1_ERROR:|\nparams:/i.test(s)) return "[database error details redacted]";
  // These URL segments are bearer credentials even without a key-like prefix.
  // Redact in both request paths and exception strings before truncation.
  let out = s.replace(/(\/(?:f|api\/(?:link|image-proxy)|t\/[oc])\/)[^/?#\s"'<>]+/g, `$1${REDACTED}`);
  for (const p of TOKEN_PATTERNS) out = out.replace(p, REDACTED);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrub(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: scrub(value.message) };
  if (value instanceof Headers || value instanceof Request || value instanceof Response) return REDACTED;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return REDACTED;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: LogFields = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ...(redact(fields) as LogFields), level, event: scrub(event) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};
