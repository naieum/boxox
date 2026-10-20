export const DOH_URL = "https://cloudflare-dns.com/dns-query";
/** Email Sending's selector and return path, from the email spike. */
const DEFAULT_DKIM_SELECTOR = "cf-bounce";
const CF_SPF_INCLUDE = "include:_spf.mx.cloudflare.net";
const CF_MX_SUFFIX = ".mx.cloudflare.net";
const RR_TYPES = { TXT: 16, MX: 15 } as const;

export type HealthStatus = "ok" | "missing" | "invalid" | "unknown";

export interface HealthCheck {
  name: "dkim" | "spf" | "dmarc" | "mx" | "bimi";
  host: string;
  type: keyof typeof RR_TYPES;
  required: boolean;
  status: HealthStatus;
  found: string[];
  detail?: string;
}

export interface DomainHealth {
  healthy: boolean;
  checks: HealthCheck[];
  checkedAt: string;
  alerts?: { at: string; kind: "problem" | "recovered"; checks: string[] }[];
  reputation?: { status: "clear" | "listed" | "unknown" | "off"; lastKnown?: "clear" | "listed"; detail: string };
}

/** TXT data arrives quoted and may be split into several strings. */
const joinTxt = (data: string) => data.replace(/"\s+"/g, "").replace(/^"|"$/g, "");

async function dohLookup(fetcher: typeof fetch, name: string, type: keyof typeof RR_TYPES): Promise<string[]> {
  const res = await fetcher(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`DoH ${type} ${name}: HTTP ${res.status}`);
  const body = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
  // 3 = NXDOMAIN: the name doesn't exist, so the record is missing.
  if (body.Status === 3) return [];
  if (body.Status !== 0) throw new Error(`DoH ${type} ${name}: status ${body.Status}`);
  return (body.Answer ?? [])
    .filter((a) => a.type === RR_TYPES[type])
    .map((a) => (type === "TXT" ? joinTxt(a.data) : a.data));
}

async function runCheck(
  fetcher: typeof fetch,
  base: Omit<HealthCheck, "status" | "found" | "detail">,
  judge: (found: string[]) => Pick<HealthCheck, "status" | "detail">,
): Promise<HealthCheck> {
  try {
    const found = await dohLookup(fetcher, base.host, base.type);
    return { ...base, found, ...judge(found) };
  } catch (err) {
    return { ...base, found: [], status: "unknown", detail: (err as Error).message };
  }
}

/**
 * Looks up the records Email Sending (and, when receiving, Email Routing)
 * depend on through public DNS-over-HTTPS, so the result is what other mail
 * servers see rather than what the zone's DNS settings say.
 */
export async function checkDomainHealth(
  domain: string,
  opts: { selector?: string; returnPath?: string; receiving?: boolean; bimi?: boolean; sending?: boolean },
  fetcher: typeof fetch,
): Promise<DomainHealth> {
  const selector = opts.selector ?? DEFAULT_DKIM_SELECTOR;
  const returnPath = opts.returnPath ?? `${DEFAULT_DKIM_SELECTOR}.${domain}`;
  const checks = await Promise.all([
    ...(opts.sending === false ? [] : [runCheck(fetcher, { name: "dkim", host: `${selector}._domainkey.${domain}`, type: "TXT", required: true }, (found) => {
      const rec = found.find((t) => /^v=DKIM1\b/i.test(t));
      if (!rec) return { status: "missing", detail: "No DKIM key published; receivers can't verify your signature" };
      return /(^|;)\s*p=[A-Za-z0-9+/=]+/.test(rec)
        ? { status: "ok" }
        : { status: "invalid", detail: "DKIM record has an empty public key (p=)" };
    }),
    runCheck(fetcher, { name: "spf", host: returnPath, type: "TXT", required: true }, (found) => {
      const rec = found.find((t) => /^v=spf1(\s|$)/i.test(t));
      if (!rec) return { status: "missing", detail: `No SPF record on ${returnPath}` };
      return rec.toLowerCase().includes(CF_SPF_INCLUDE)
        ? { status: "ok" }
        : { status: "invalid", detail: `SPF on ${returnPath} doesn't include _spf.mx.cloudflare.net` };
    }),
    runCheck(fetcher, { name: "dmarc", host: `_dmarc.${domain}`, type: "TXT", required: true }, judgeDmarc)]),
    runCheck(fetcher, { name: "mx", host: domain, type: "MX", required: !!opts.receiving }, (found) => {
      if (!found.length) return { status: "missing", detail: "No MX records; this domain can't receive mail" };
      const foreign = found.filter((d) => !d.replace(/\.$/, "").toLowerCase().endsWith(CF_MX_SUFFIX));
      return foreign.length
        ? { status: "invalid", detail: `MX points away from Cloudflare: ${foreign.join(", ")}` }
        : { status: "ok" };
    }),
  ]);
  if (opts.bimi && opts.sending !== false) {
    const dmarc = checks.find(c => c.name === "dmarc");
    checks.push(await runCheck(fetcher, { name: "bimi", host: `default._bimi.${domain}`, type: "TXT", required: false }, found => judgeBimi(found, dmarc)));
  }
  return {
    healthy: checks.every((c) => !c.required || c.status === "ok"),
    checks,
    checkedAt: new Date().toISOString(),
  };
}


/** Duplicate policy tags and duplicate records are invalid, rather than silently selecting one. */
function tags(record: string): Map<string, string> | null {
  const result = new Map<string, string>();
  for (const part of record.split(";").map(s => s.trim()).filter(Boolean)) {
    const pair = /^([a-z]+)\s*=\s*(.*)$/i.exec(part);
    if (!pair || result.has(pair[1]!.toLowerCase())) return null;
    result.set(pair[1]!.toLowerCase(), pair[2]!.trim());
  }
  return result;
}

export function judgeDmarc(found: string[]): Pick<HealthCheck, "status" | "detail"> {
  const records = found.filter(t => /^v=DMARC1(?:\s*;|$)/i.test(t));
  if (!records.length) return { status: "missing", detail: "Publish a DMARC policy for this domain." };
  const policy = records.length === 1 ? tags(records[0]!) : null;
  if (!policy || !["none", "quarantine", "reject"].includes(policy.get("p") ?? "")
    || (policy.has("pct") && (!/^\d{1,3}$/.test(policy.get("pct")!) || Number(policy.get("pct")) > 100))
    || (policy.has("sp") && !["none", "quarantine", "reject"].includes(policy.get("sp")!))) {
    return { status: "invalid", detail: "Publish one DMARC record with a valid p policy and no duplicate tags." };
  }
  return { status: "ok", detail: policy.get("p") === "none" ? "Monitoring only. Review all senders before enforcing quarantine or reject." : `DMARC policy: ${policy.get("p")}.` };
}

function httpsUrl(value: string | undefined): boolean {
  try { const u = new URL(value ?? ""); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
}

export function judgeBimi(found: string[], dmarc?: HealthCheck): Pick<HealthCheck, "status" | "detail"> {
  const records = found.filter(t => /^v=BIMI1(?:\s*;|$)/i.test(t));
  if (!records.length) return { status: "missing", detail: "Optional: publish a BIMI record for your brand logo. See the deliverability guide." };
  const record = records.length === 1 ? tags(records[0]!) : null;
  if (!record || !httpsUrl(record.get("l")) || (record.get("a") && !httpsUrl(record.get("a")))) {
    return { status: "invalid", detail: "Use one BIMI1 record with an HTTPS logo URL and an HTTPS certificate URL when present." };
  }
  const policy = dmarc?.status === "ok" ? tags(dmarc.found.find(t => /^v=DMARC1/i.test(t)) ?? "") : null;
  if (!policy || !["quarantine", "reject"].includes(policy.get("p") ?? "") || policy.get("sp") === "none"
    || (policy.has("pct") && Number(policy.get("pct")) !== 100)) {
    return { status: "invalid", detail: "BIMI needs DMARC enforcement at 100%. Review legitimate senders before changing policy." };
  }
  return { status: "ok", detail: "BIMI DNS format checked. Logo files, certificates, parent-domain policy, and inbox display still need verification." };
}
