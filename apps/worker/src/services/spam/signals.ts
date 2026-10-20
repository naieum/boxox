import { CLOUDFLARE_AUTHSERV_ID, parseAuthenticationResults } from "../ingest/auth";

/**
 * Spam layer 1: local checks that run on every message, free and without
 * anything leaving the account. Header and structure rules are ported from
 * rspamd/SpamAssassin (Apache-2.0). Each hit is a named signal with a weight;
 * the combiner (layer 3) learns how much each one is worth.
 */

export interface Signal {
  id: string;
  weight: number;
  /** Domains, extensions or header values; never body text. */
  detail?: string;
}

export interface SignalAttachment {
  filename: string;
  contentType: string;
  content?: Uint8Array;
}

export interface SignalMail {
  headers: { key: string; value: string }[];
  fromEmail: string;
  fromName: string | null;
  replyTo: string[];
  rfcMessageId: string | null;
  date: string | null;
  text: string | null;
  html: string | null;
  attachments: SignalAttachment[];
}

export interface SignalContext {
  /** Domains this install receives mail for. */
  ownerDomains: string[];
  /** Addresses the owner has written to. */
  knownContacts?: string[];
  now?: Date;
}

export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy";

export interface AuthSummary {
  /** False when the topmost Authentication-Results isn't Cloudflare's, or another header claims its id. */
  trusted: boolean;
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
  arc: AuthVerdict;
  /** Cloudflare's own spam hint (docs/spikes/email.md), when present. */
  cfSpamScore: number | null;
}

export interface Link {
  href: string;
  host: string;
  /** Visible anchor text, tags stripped; null for bare URLs in the text part. */
  text: string | null;
}

const PROTECTED_BRANDS = [
  "paypal", "apple", "icloud", "microsoft", "outlook", "office365", "google", "gmail", "amazon", "netflix",
  "facebook", "instagram", "whatsapp", "linkedin", "dropbox", "docusign", "chase", "wellsfargo",
  "bankofamerica", "citibank", "coinbase", "binance", "stripe", "cloudflare", "github", "adobe", "dhl", "fedex", "ups", "usps",
];

const URL_SHORTENERS = new Set([
  "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly",
  "shorturl.at", "tiny.cc", "rb.gy", "s.id", "t.ly", "v.gd", "shorte.st", "adf.ly", "bl.ink", "lnkd.in", "qrco.de",
]);

const DANGEROUS_EXTENSIONS = new Set([
  "exe", "scr", "com", "pif", "bat", "cmd", "cpl", "msi", "msp", "jar", "js", "jse", "vbs", "vbe", "wsf", "wsh", "ps1",
  "hta", "html", "htm", "shtml", "svg", "iso", "img", "vhd", "vhdx", "lnk", "reg", "chm", "one", "xll", "docm", "xlsm", "pptm",
]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "jpg", "jpeg", "png", "gif", "zip", "rtf", "csv"]);

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "ne", "or", "go", "gob", "mil"]);

const MAX_LINKS = 200;
const HOUR = 3600_000;

/** "Mail.Example.co.uk." → "example.co.uk": the last two labels, or three under a common second level. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const sld = labels[labels.length - 2]!;
  const tld = labels[labels.length - 1]!;
  const n = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-n).join(".");
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase().replace(/>$/, "");
}

const sameOrg = (a: string, b: string) => !!a && !!b && registrableDomain(a) === registrableDomain(b);

// --- Punycode (RFC 3492 decode only) and confusable skeletons ---

const BASE = 36, T_MIN = 1, T_MAX = 26, SKEW = 38, DAMP = 700;

function adapt(delta: number, points: number, first: boolean): number {
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / points);
  let k = 0;
  while (delta > ((BASE - T_MIN) * T_MAX) >> 1) {
    delta = Math.floor(delta / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

/** "xn--pypal-4ve" → "pаypal"; null when the label is not valid punycode. */
export function decodePunycodeLabel(label: string): string | null {
  if (!label.startsWith("xn--")) return label;
  const input = label.slice(4);
  const out: number[] = [];
  const dash = input.lastIndexOf("-");
  for (let j = 0; j < Math.max(dash, 0); j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    out.push(c);
  }
  let n = 128, i = 0, bias = 72;
  for (let pos = dash > 0 ? dash + 1 : 0; pos < input.length; ) {
    const old = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (pos >= input.length) return null;
      const c = input.charCodeAt(pos++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : c >= 65 && c <= 90 ? c - 65 : BASE;
      if (digit >= BASE) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
      if (i > 0x10ffff * (out.length + 1)) return null;
    }
    bias = adapt(i - old, out.length + 1, old === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

const CONFUSABLES: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ԁ: "d", ѕ: "s", ԛ: "q", ԝ: "w", һ: "h", ӏ: "l",
  α: "a", ο: "o", ν: "v", ρ: "p", τ: "t", ι: "i", κ: "k", ɡ: "g", ո: "n", ս: "u", "0": "o", "1": "l", "3": "e", "5": "s", "|": "l",
};

/** A lowercase Latin look-alike of a label: accents dropped, confusable letters folded, "rn" → "m", "vv" → "w". */
export function skeleton(label: string): string {
  const folded = [...label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()].map((c) => CONFUSABLES[c] ?? c).join("");
  return folded.replaceAll("rn", "m").replaceAll("vv", "w").replace(/[^a-z0-9]/g, "");
}

/**
 * Look-alike checks for one domain: any punycode label, and a label whose
 * skeleton matches an owner domain or protected brand without being it.
 */
export function lookalikeSignals(host: string, ownerDomains: string[]): Signal[] {
  const h = host.toLowerCase();
  const labels = h.split(".");
  const out: Signal[] = [];
  const decoded = labels.map(decodePunycodeLabel);
  if (labels.some((l) => l.startsWith("xn--"))) {
    out.push({ id: "punycode_domain", weight: 1.5, detail: h });
  }
  if (decoded.some((l) => l === null)) return out;
  const reg = registrableDomain(decoded.join("."));
  const name = reg.split(".")[0] ?? "";
  const nameSkel = skeleton(name);
  for (const owner of ownerDomains) {
    const ownerReg = registrableDomain(owner);
    if (reg === ownerReg) continue;
    const ownerName = ownerReg.split(".")[0] ?? "";
    if (nameSkel && nameSkel === skeleton(ownerName)) {
      out.push({ id: "lookalike_owner_domain", weight: 5, detail: `${h} ~ ${ownerReg}` });
      return out;
    }
  }
  for (const brand of PROTECTED_BRANDS) {
    if (name !== brand && nameSkel === brand) {
      out.push({ id: "lookalike_brand_domain", weight: 4, detail: `${h} ~ ${brand}` });
      break;
    }
  }
  return out;
}

// --- Authentication results ---

const VERDICTS = new Set<AuthVerdict>(["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"]);
const asVerdict = (r: string | undefined): AuthVerdict => (r && VERDICTS.has(r as AuthVerdict) ? (r as AuthVerdict) : "none");

/** SPF/DKIM/DMARC/ARC from the topmost Cloudflare Authentication-Results; untrusted headers count as nothing. */
export function authSummary(headers: SignalMail["headers"], fromEmail: string): AuthSummary {
  const ars = headers.filter((h) => h.key.toLowerCase() === "authentication-results").map((h) => parseAuthenticationResults(h.value));
  const top = ars[0];
  const trusted = !!top && top.authservId === CLOUDFLARE_AUTHSERV_ID && ars.filter((a) => a.authservId === CLOUDFLARE_AUTHSERV_ID).length === 1;
  const cf = headers.find((h) => h.key.toLowerCase() === "x-cf-spamh-score");
  const cfScore = cf ? Number.parseFloat(cf.value) : NaN;
  const summary: AuthSummary = {
    trusted,
    spf: "none",
    dkim: "none",
    dmarc: "none",
    arc: "none",
    cfSpamScore: Number.isFinite(cfScore) ? cfScore : null,
  };
  if (!trusted || !top) return summary;

  const fromDomain = domainOf(fromEmail);
  const pick = (method: string, prefer: (p: Record<string, string>) => boolean) => {
    const all = top.results.filter((r) => r.method === method);
    return asVerdict((all.find((r) => r.result === "pass" && prefer(r.props)) ?? all.find((r) => prefer(r.props)) ?? all.find((r) => r.result !== "none") ?? all[0])?.result);
  };
  summary.dmarc = pick("dmarc", (p) => (p["header.from"] ?? fromDomain) === fromDomain);
  summary.dkim = pick("dkim", (p) => !!p["header.d"] && sameOrg(p["header.d"], fromDomain));
  summary.spf = pick("spf", (p) => !!p["smtp.mailfrom"]);
  summary.arc = pick("arc", () => true);
  return summary;
}

export function authSignals(auth: AuthSummary): Signal[] {
  const out: Signal[] = [];
  if (!auth.trusted) out.push({ id: "auth_untrusted", weight: 2 });
  if (auth.dmarc === "fail") out.push({ id: "dmarc_fail", weight: 4 });
  else if (auth.dmarc === "none" && auth.trusted) out.push({ id: "dmarc_none", weight: 0.5 });
  if (auth.dkim === "fail") out.push({ id: "dkim_fail", weight: 1.5 });
  if (auth.spf === "fail") out.push({ id: "spf_fail", weight: 1.5 });
  else if (auth.spf === "softfail") out.push({ id: "spf_softfail", weight: 0.7 });
  if (auth.arc === "fail") out.push({ id: "arc_fail", weight: 1 });
  if (auth.dmarc === "pass") out.push({ id: "dmarc_pass", weight: -1 });
  if (auth.cfSpamScore !== null && auth.cfSpamScore > 1) out.push({ id: "cf_spam_score", weight: Math.min(auth.cfSpamScore, 5), detail: String(auth.cfSpamScore) });
  return out;
}

// --- Links ---

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function hostOf(href: string): string | null {
  try {
    const u = new URL(href.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Anchors from the HTML part and bare http(s) URLs from the text part, at most MAX_LINKS. */
export function extractLinks(html: string | null, text: string | null): Link[] {
  const links: Link[] = [];
  if (html) {
    const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
    for (const m of html.matchAll(re)) {
      if (links.length >= MAX_LINKS) break;
      const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
      const host = hostOf(href);
      if (!host) continue;
      const visible = decodeEntities((m[4] ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
      links.push({ href, host, text: visible });
    }
  }
  if (text) {
    for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
      if (links.length >= MAX_LINKS) break;
      const host = hostOf(m[0]);
      if (host) links.push({ href: m[0], host, text: null });
    }
  }
  return links;
}

const DOMAIN_IN_TEXT = /(?:https?:\/\/)?((?:[a-z0-9¡-￿](?:[a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?\.)+[a-z¡-￿]{2,63})/i;

function textDomain(text: string): string | null {
  const m = text.match(DOMAIN_IN_TEXT);
  if (!m || DOCUMENT_EXTENSIONS.has(extension(m[1]!))) return null;
  return hostOf(`http://${m[1]!}`);
}

const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");

export function linkSignals(links: Link[], ownerDomains: string[]): Signal[] {
  const out: Signal[] = [];
  const seen = new Set<string>();
  const once = (s: Signal) => {
    const k = `${s.id}:${s.detail ?? ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  };
  for (const link of links) {
    if (link.text) {
      const shown = textDomain(link.text);
      if (shown && !isIp(shown) && !sameOrg(shown, link.host)) {
        once({ id: "link_text_mismatch", weight: 3, detail: `${registrableDomain(shown)} -> ${link.host}` });
      }
    }
    if (isIp(link.host)) once({ id: "ip_link", weight: 2.5, detail: link.host });
    if (URL_SHORTENERS.has(link.host) || URL_SHORTENERS.has(registrableDomain(link.host))) once({ id: "url_shortener", weight: 1, detail: link.host });
    if (!isIp(link.host)) for (const s of lookalikeSignals(link.host, ownerDomains)) once(s);
  }
  return out;
}

/** Distinct registrable link domains, owner's own left out, most frequent first. */
export function linkDomains(links: Link[], ownerDomains: string[], limit: number): string[] {
  const owners = new Set(ownerDomains.map(registrableDomain));
  const counts = new Map<string, number>();
  for (const l of links) {
    if (isIp(l.host)) continue;
    const reg = registrableDomain(l.host);
    if (!owners.has(reg)) counts.set(reg, (counts.get(reg) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([d]) => d);
}

// --- Header and structure rules ---

const ADDRESS_IN_NAME = /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i;

function displayNameSignals(mail: SignalMail, ctx: SignalContext): Signal[] {
  const name = (mail.fromName ?? "").normalize("NFKC").toLowerCase();
  if (!name) return [];
  const fromDomain = domainOf(mail.fromEmail);
  const out: Signal[] = [];
  const addr = name.match(ADDRESS_IN_NAME);
  const shown = addr ? addr[1]! : textDomain(name);
  if (shown && !sameOrg(shown, fromDomain)) {
    const owner = ctx.ownerDomains.find((d) => sameOrg(d, shown));
    if (owner) out.push({ id: "display_name_spoofs_owner", weight: 5, detail: `${registrableDomain(owner)} via ${fromDomain}` });
    else out.push({ id: addr ? "display_name_address" : "display_name_domain", weight: 2, detail: `${registrableDomain(shown)} via ${fromDomain}` });
  }
  if (!out.length) {
    for (const owner of ctx.ownerDomains) {
      const label = registrableDomain(owner).split(".")[0]!;
      if (label.length >= 4 && new RegExp(`\\b${label}\\b`).test(name) && !sameOrg(owner, fromDomain)) {
        out.push({ id: "display_name_spoofs_owner", weight: 4, detail: `${registrableDomain(owner)} via ${fromDomain}` });
        break;
      }
    }
  }
  const fromName = registrableDomain(fromDomain).split(".")[0] ?? "";
  for (const brand of PROTECTED_BRANDS) {
    if (fromName !== brand && new RegExp(`\\b${brand}\\b`).test(name.replace(/\s+/g, " "))) {
      out.push({ id: "display_name_brand", weight: 2, detail: `${brand} via ${fromDomain}` });
      break;
    }
  }
  const contacts = new Set((ctx.knownContacts ?? []).map((c) => c.toLowerCase()));
  if (addr && contacts.has(addr[0]!.toLowerCase()) && addr[0]!.toLowerCase() !== mail.fromEmail.toLowerCase()) {
    out.push({ id: "display_name_spoofs_contact", weight: 4, detail: fromDomain });
  }
  return out;
}

function extension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/** ZIP local file header with general-purpose bit 0 (encrypted) set. */
function isEncryptedZip(content: Uint8Array | undefined): boolean {
  if (!content || content.length < 8) return false;
  return content[0] === 0x50 && content[1] === 0x4b && content[2] === 0x03 && content[3] === 0x04 && (content[6]! & 1) === 1;
}

function attachmentSignals(attachments: SignalAttachment[]): Signal[] {
  const out: Signal[] = [];
  for (const att of attachments) {
    const name = att.filename.toLowerCase().trim();
    const ext = extension(name);
    const parts = name.split(".");
    if (parts.length >= 3 && DOCUMENT_EXTENSIONS.has(parts[parts.length - 2]!) && !DOCUMENT_EXTENSIONS.has(ext)) {
      out.push({ id: "double_extension", weight: 4, detail: parts.slice(-2).join(".") });
    } else if (DANGEROUS_EXTENSIONS.has(ext)) {
      out.push({ id: "dangerous_attachment", weight: 3, detail: ext });
    }
    if (isEncryptedZip(att.content)) out.push({ id: "encrypted_archive", weight: 3, detail: ext || "zip" });
  }
  return out;
}

function header(mail: SignalMail, key: string): string | null {
  return mail.headers.find((h) => h.key.toLowerCase() === key)?.value ?? null;
}

function structureSignals(mail: SignalMail, ctx: SignalContext): Signal[] {
  const out: Signal[] = [];
  const fromDomain = domainOf(mail.fromEmail);
  const now = (ctx.now ?? new Date()).getTime();

  const replyDomains = [...new Set(mail.replyTo.map(domainOf).filter(Boolean))];
  const foreign = replyDomains.find((d) => !sameOrg(d, fromDomain));
  if (foreign) out.push({ id: "reply_to_mismatch", weight: 1.5, detail: `${registrableDomain(foreign)} vs ${fromDomain}` });

  if (fromDomain) out.push(...lookalikeSignals(fromDomain, ctx.ownerDomains).map((s) => ({ ...s, id: `from_${s.id}` })));

  const html = mail.html ?? "";
  const textLen = (mail.text ?? "").replace(/\s+/g, "").length;
  if (html && !textLen) out.push({ id: "html_only", weight: 0.5 });
  if (html) {
    const images = (html.match(/<img\b/gi) ?? []).length;
    const visible = decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, "").length;
    if (images > 0 && visible < 200 * images && visible < 400) out.push({ id: "mostly_images", weight: 1.5, detail: String(images) });
  }

  const dateHeader = mail.date ?? header(mail, "date");
  const date = dateHeader ? Date.parse(dateHeader) : NaN;
  if (!dateHeader || Number.isNaN(date)) out.push({ id: "date_missing", weight: 1 });
  else if (date > now + 24 * HOUR) out.push({ id: "date_future", weight: 2 });
  else if (date < now - 30 * 24 * HOUR) out.push({ id: "date_past", weight: 1 });

  const mid = mail.rfcMessageId ?? header(mail, "message-id");
  const midDomain = mid?.match(/@([^>\s]+)>?\s*$/)?.[1]?.toLowerCase();
  if (!mid) out.push({ id: "message_id_missing", weight: 1 });
  else if (!midDomain || !midDomain.includes(".")) out.push({ id: "message_id_malformed", weight: 0.5 });
  else if (fromDomain && !sameOrg(midDomain, fromDomain)) out.push({ id: "message_id_domain_mismatch", weight: 0.3, detail: registrableDomain(midDomain) });

  return out;
}

/** Owner domains or contacts used as the From address without passing authentication. */
function ownerSpoofSignals(mail: SignalMail, ctx: SignalContext, auth: AuthSummary): Signal[] {
  const fromDomain = domainOf(mail.fromEmail);
  const passed = auth.trusted && (auth.dmarc === "pass" || auth.dkim === "pass");
  if (passed) return [];
  if (ctx.ownerDomains.some((d) => sameOrg(d, fromDomain))) return [{ id: "owner_domain_spoof", weight: 6, detail: fromDomain }];
  if ((ctx.knownContacts ?? []).some((c) => c.toLowerCase() === mail.fromEmail.toLowerCase())) return [{ id: "contact_unauthenticated", weight: 2, detail: fromDomain }];
  return [];
}

export interface LocalSignals {
  auth: AuthSummary;
  signals: Signal[];
  links: Link[];
  /** The sending IP from Cloudflare's own Received header, for optional Spamhaus ZEN. */
  sendingIp: string | null;
  score: number;
}

/** The topmost Received header is Cloudflare's: "from host (1.2.3.4)" or "[1.2.3.4]". */
export function sendingIpOf(headers: SignalMail["headers"]): string | null {
  const received = headers.find((h) => h.key.toLowerCase() === "received")?.value ?? "";
  const m = received.match(/^\s*from\s+[^(\[]*[(\[][^)\]]*?(\d{1,3}(?:\.\d{1,3}){3})[)\]]/i);
  return m ? m[1]! : null;
}

/** Every local rule: authentication, display name, links, attachments, dates, Message-ID. */
export function localSignals(mail: SignalMail, ctx: SignalContext): LocalSignals {
  const auth = authSummary(mail.headers, mail.fromEmail);
  const links = extractLinks(mail.html, mail.text);
  const signals = [
    ...authSignals(auth),
    ...ownerSpoofSignals(mail, ctx, auth),
    ...displayNameSignals(mail, ctx),
    ...linkSignals(links, ctx.ownerDomains),
    ...attachmentSignals(mail.attachments),
    ...structureSignals(mail, ctx),
  ];
  return { auth, signals, links, sendingIp: sendingIpOf(mail.headers), score: sumWeights(signals) };
}

export const sumWeights = (signals: Signal[]) => Math.round(signals.reduce((s, x) => s + x.weight, 0) * 100) / 100;
