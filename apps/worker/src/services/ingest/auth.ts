/**
 * The authserv-id Cloudflare's receiving MTA stamps on mail routed to the
 * Worker (docs/spikes/email.md). Any other id was written before the message
 * reached Cloudflare and is sender-forgeable.
 */
export const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

export interface AuthResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

/** RFC 8601 comments are parenthesised and may nest; they carry no verdicts. */
function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/** "mx.cloudflare.net; dkim=pass header.d=a.com; dmarc=pass" → id + one entry per resinfo. */
export function parseAuthenticationResults(value: string): { authservId: string; results: AuthResult[] } {
  const [head = "", ...rest] = stripComments(value).split(";");
  const authservId = head.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const results: AuthResult[] = [];
  for (const resinfo of rest) {
    const [first, ...tokens] = resinfo.trim().split(/\s+/);
    const m = first?.match(/^([a-z0-9_-]+)=([a-z0-9_-]+)$/i);
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const t of tokens) {
      const eq = t.indexOf("=");
      if (eq > 0) props[t.slice(0, eq).toLowerCase()] = t.slice(eq + 1).toLowerCase();
    }
    results.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props });
  }
  return { authservId, results };
}

/** Relaxed alignment: the DKIM domain is the From domain or one of its parents. */
function aligned(signingDomain: string | undefined, fromDomain: string): boolean {
  if (!signingDomain || !fromDomain) return false;
  return fromDomain === signingDomain || fromDomain.endsWith(`.${signingDomain}`);
}

/**
 * Sender authentication from the message's Authentication-Results headers,
 * in document order. Cloudflare prepends its own, so only the topmost header
 * counts, and only when its authserv-id is Cloudflare's. A second header
 * claiming that id is a forgery attempt and fails the whole check. Verdict:
 * DMARC pass for the From domain, or a DKIM pass aligned with it. Fails closed.
 */
export function isAuthenticated(headers: { key: string; value: string }[], fromEmail: string): boolean {
  const ars = headers.filter((h) => h.key.toLowerCase() === "authentication-results").map((h) => parseAuthenticationResults(h.value));
  const top = ars[0];
  if (!top || top.authservId !== CLOUDFLARE_AUTHSERV_ID) return false;
  if (ars.filter((a) => a.authservId === CLOUDFLARE_AUTHSERV_ID).length !== 1) return false;

  const at = fromEmail.lastIndexOf("@");
  const fromDomain = at < 0 ? "" : fromEmail.slice(at + 1).toLowerCase();
  if (!fromDomain) return false;
  return top.results.some(
    (r) =>
      r.result === "pass" &&
      ((r.method === "dmarc" && (r.props["header.from"] ?? fromDomain) === fromDomain) ||
        (r.method === "dkim" && aligned(r.props["header.d"], fromDomain))),
  );
}
