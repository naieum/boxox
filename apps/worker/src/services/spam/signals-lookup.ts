import type { Signal } from "./signals";

/**
 * Reputation lookups for layer 1. These send link domains (and, for Spamhaus,
 * the sending IP) outside the account, so they only run when the owner has
 * turned on "reputation lookups". Every lookup fails open: an error or a
 * timeout is recorded, never treated as a listing.
 */

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Cloudflare's malware-blocking resolver (1.1.1.2); blocked names answer 0.0.0.0. */
export const SECURE_DOH = "https://security.cloudflare-dns.com/dns-query";
/** Plain 1.1.1.1, for Spamhaus DQS queries (the key is in the name, so a public resolver is fine). */
export const PLAIN_DOH = "https://cloudflare-dns.com/dns-query";
export const OPENPHISH_KV_KEY = "spam:openphish";

export const MAX_LOOKUP_DOMAINS = 10;
const LOOKUP_TIMEOUT_MS = 2000;

interface DohAnswer {
  status: number;
  answers: string[];
}

async function doh(fetcher: Fetcher, endpoint: string, name: string, type: "A" | "AAAA" = "A"): Promise<DohAnswer> {
  const res = await fetcher(`${endpoint}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`doh http ${res.status}`);
  const body = (await res.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
  const want = type === "A" ? 1 : 28;
  return { status: body.Status ?? -1, answers: (body.Answer ?? []).filter((a) => a.type === want).map((a) => a.data) };
}

export interface LookupResult {
  signals: Signal[];
  /** Lookups that errored or timed out, by source. */
  errors: string[];
}

/** 1.1.1.2 over DoH: a domain Cloudflare classes as malware or phishing resolves to 0.0.0.0. */
export async function checkSecureResolver(domains: string[], fetcher: Fetcher = fetch): Promise<LookupResult> {
  const out: LookupResult = { signals: [], errors: [] };
  await Promise.all(
    domains.slice(0, MAX_LOOKUP_DOMAINS).map(async (d) => {
      try {
        const r = await doh(fetcher, SECURE_DOH, d);
        if (r.status === 0 && r.answers.includes("0.0.0.0")) out.signals.push({ id: "cf_security_blocked", weight: 6, detail: d });
      } catch {
        out.errors.push(`1.1.1.2:${d}`);
      }
    }),
  );
  return out;
}

/** "https://Evil.example/a/b?x" → "evil.example/a/b": the form OpenPhish entries and links are compared in. */
export function normalizePhishUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/** A link matches when an OpenPhish entry is its host, or its host plus a leading run of path segments. */
export function matchOpenPhish(hrefs: string[], feed: Set<string>): Signal[] {
  if (!feed.size) return [];
  const hits = new Set<string>();
  for (const href of hrefs) {
    const norm = normalizePhishUrl(href);
    if (!norm) continue;
    const [host, ...segs] = norm.split("/");
    let prefix = host!;
    if (feed.has(prefix)) hits.add(host!);
    for (const seg of segs.slice(0, 8)) {
      prefix += `/${seg}`;
      if (feed.has(prefix)) hits.add(host!);
    }
  }
  return [...hits].map((h) => ({ id: "openphish_listed", weight: 8, detail: h }));
}

export interface OpenPhishFeed {
  updatedAt: string;
  entries: string[];
}

export async function loadOpenPhish(kv: KVNamespace): Promise<Set<string>> {
  const feed = await kv.get<OpenPhishFeed>(OPENPHISH_KV_KEY, { type: "json", cacheTtl: 300 });
  return new Set(feed?.entries ?? []);
}

// --- Spamhaus DQS (optional, the owner's own key) ---

export interface SpamhausAnswer {
  name: string;
  /** Listing codes (127.0.0.x for ZEN, 127.0.1.x for DBL). */
  listed: string[];
  /** 127.255.255.x answers: typing error, public-resolver or rate-limit refusals. Not listings. */
  error: string | null;
}

const SPAMHAUS_ERRORS: Record<string, string> = {
  "127.255.255.252": "typing error in DNSBL name",
  "127.255.255.254": "query via public resolver refused",
  "127.255.255.255": "excessive number of queries",
};

/** Classify one Spamhaus A answer set: 127.255.255.x is always an error code, never a listing. */
export function classifySpamhaus(name: string, answers: string[]): SpamhausAnswer {
  const errs = answers.filter((a) => a.startsWith("127.255.255."));
  const listed = answers.filter((a) => /^127\.0\.[01]\.\d{1,3}$/.test(a));
  const error = errs.length ? SPAMHAUS_ERRORS[errs[0]!] ?? `spamhaus error ${errs[0]}` : null;
  return { name, listed: error ? [] : listed, error };
}

function reverseIpv4(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reverse().join(".");
}

const ZEN_WEIGHTS: Record<string, number> = {
  "127.0.0.2": 5, // SBL
  "127.0.0.3": 4, // SBL CSS
  "127.0.0.4": 5, // XBL
  "127.0.0.9": 5, // DROP
  "127.0.0.10": 1, // PBL (ISP)
  "127.0.0.11": 1, // PBL (Spamhaus)
};

/** ZEN for the sending IP and DBL for the link domains, through the owner's DQS key. */
export async function checkSpamhaus(
  opts: { key: string; ip: string | null; domains: string[] },
  fetcher: Fetcher = fetch,
): Promise<LookupResult> {
  const out: LookupResult = { signals: [], errors: [] };
  const key = opts.key.trim();
  if (!/^[a-z0-9]{10,64}$/i.test(key)) return { signals: [], errors: ["spamhaus:bad key"] };
  const queries: { kind: "zen" | "dbl"; subject: string; name: string }[] = [];
  const rev = opts.ip ? reverseIpv4(opts.ip) : null;
  if (rev) queries.push({ kind: "zen", subject: opts.ip!, name: `${rev}.${key}.zen.dq.spamhaus.net` });
  for (const d of opts.domains.slice(0, MAX_LOOKUP_DOMAINS)) queries.push({ kind: "dbl", subject: d, name: `${d}.${key}.dbl.dq.spamhaus.net` });

  await Promise.all(
    queries.map(async (q) => {
      try {
        const r = await doh(fetcher, PLAIN_DOH, q.name);
        if (r.status === 3) return;
        if (r.status !== 0) { out.errors.push(`spamhaus:${q.kind}:dns failure`); return; }
        const c = classifySpamhaus(q.subject, r.answers);
        if (c.error) {
          out.errors.push(`spamhaus:${q.kind}:${c.error}`);
          return;
        }
        if (!c.listed.length) return;
        const weight = q.kind === "zen" ? Math.max(...c.listed.map((code) => ZEN_WEIGHTS[code] ?? 3)) : 6;
        out.signals.push({ id: q.kind === "zen" ? "spamhaus_zen" : "spamhaus_dbl", weight, detail: `${q.subject} ${c.listed.join(",")}` });
      } catch {
        out.errors.push(`spamhaus:${q.kind}:${q.subject}`);
      }
    }),
  );
  return out;
}
