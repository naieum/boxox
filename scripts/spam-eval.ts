/**
 * Spam pipeline evaluation on the labelled corpus in .corpus/ (fetch it with
 * scripts/fetch-corpus.sh). Runs the worker's own layer-1 rules, an in-memory
 * copy of the Bayes filter, sender reputation and the layer-3 combiner, with
 * k-fold cross-validation standing in for the owner's labels. No AI: see
 * scripts/model-eval.ts for the classifier bake-off and AI on vs off.
 *
 *   node --experimental-transform-types scripts/spam-eval.ts [--corpus .corpus] [--folds 5]
 *     [--train-limit N] [--json out.json]
 *
 * Owner exports can be added as .corpus/owner/{ham,spam,phishing}/ (one .eml
 * per file, or .mbox files).
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// Worker sources use extensionless relative imports (bundler resolution).
const hooks = `export async function resolve(s, c, next) {
  try { return await next(s, c); } catch (e) {
    if ((s.startsWith(".") || s.startsWith("/")) && !/\\.[cm]?[jt]sx?$/.test(s)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) { try { return await next(s + ext, c); } catch {} }
    }
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(hooks), import.meta.url);

const ROOT = resolve(import.meta.dirname, "..");
const { localSignals, linkDomains, sumWeights } = await import("../apps/worker/src/services/spam/signals.ts");
const { signalMailFrom } = await import("../apps/worker/src/services/spam/signals-run.ts");
const { MAX_LOOKUP_DOMAINS } = await import("../apps/worker/src/services/spam/signals-lookup.ts");
const { tokenize, tokenSpamProbability } = await import("../apps/worker/src/services/spam/bayes.ts");
const { combine, BASE_FEATURES, DEFAULT_WEIGHTS, featuresOf } = await import("../apps/worker/src/services/spam/combine.ts");
const { fitWeights } = await import("../apps/worker/src/crons/spam-refit.ts");

import type { Signal, SignalMail } from "../apps/worker/src/services/spam/signals.ts";
import type { ClassifierInput } from "../apps/worker/src/services/spam/classifier.ts";
import type { CombinedVerdict, CombinerInput, SenderHistory, Weights, WeightSet } from "../apps/worker/src/services/spam/combine.ts";

type Email = Parameters<typeof signalMailFrom>[0];
const PostalMime: { parse(raw: Uint8Array): Promise<Email> } = (
  await import(createRequire(join(ROOT, "apps/worker/package.json")).resolve("postal-mime"))
).default;

export type Label = "ham" | "spam" | "phishing";

export interface CorpusItem {
  id: string;
  source: string;
  label: Label;
  raw: Uint8Array;
}

const SA_LABELS: [RegExp, Label][] = [
  [/ham/, "ham"],
  [/spam/, "spam"],
];

function splitMbox(buf: Buffer): Uint8Array[] {
  const text = buf.toString("latin1");
  return text
    .split(/\r?\n(?=From \S)/)
    .map((m) => m.replace(/^From \S[^\n]*\n/, ""))
    .filter((m) => m.trim().length > 0)
    .map((m) => Buffer.from(m, "latin1"));
}

function readMessages(path: string): Uint8Array[] {
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => !f.startsWith("."))
      .sort()
      .flatMap((f) => readMessages(join(path, f)));
  }
  const buf = readFileSync(path);
  return path.endsWith(".mbox") ? splitMbox(buf) : [buf.toString("latin1").startsWith("From ") ? Buffer.from(buf.toString("latin1").replace(/^From \S[^\n]*\n/, ""), "latin1") : buf];
}

/** SpamAssassin sets, phishing mboxes and the owner's own export, labelled. */
export function loadCorpus(dir: string): CorpusItem[] {
  const items: CorpusItem[] = [];
  const add = (source: string, label: Label, path: string) =>
    readMessages(path).forEach((raw, i) => items.push({ id: `${source}/${i}`, source, label, raw }));
  const sa = join(dir, "spamassassin");
  if (existsSync(sa)) {
    for (const set of readdirSync(sa).filter((s) => !s.startsWith(".")).sort()) {
      const label = SA_LABELS.find(([re]) => re.test(set))?.[1];
      if (label) add(set.replace(/^\d+_/, ""), label, join(sa, set));
    }
  }
  const phish = join(dir, "phishing");
  if (existsSync(phish)) {
    for (const f of readdirSync(phish).filter((f) => f.endsWith(".mbox")).sort()) add(f.replace(/\.mbox$/, ""), "phishing", join(phish, f));
  }
  for (const label of ["ham", "spam", "phishing"] as const) {
    const owner = join(dir, "owner", label);
    if (existsSync(owner)) add(`owner-${label}`, label, owner);
  }
  return items;
}

export interface Prepared {
  item: CorpusItem;
  fold: number;
  mail: SignalMail;
  fromEmail: string;
  signals: Signal[];
  score: number;
  tokens: string[];
  classifier: ClassifierInput;
}

/** FNV-1a, for deterministic folds and samples. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const header = (mail: SignalMail, key: string) => mail.headers.find((h) => h.key.toLowerCase() === key)?.value ?? null;
const domainOf = (addr: string | null) => addr?.match(/@([^>\s]+)>?\s*$/)?.[1]?.toLowerCase() ?? null;

/**
 * Layer 1 for one corpus message. The corpus never passed through Cloudflare,
 * so the receiving time comes from the top Received header (the date rules
 * would otherwise flag every 2002 message), the owner's domain from
 * Delivered-To, and auth_untrusted is dropped: it would fire on every message
 * here and on none in production.
 */
export async function prepare(item: CorpusItem, folds: number): Promise<Prepared | null> {
  let email: Email;
  try {
    email = await PostalMime.parse(item.raw);
  } catch {
    return null;
  }
  const mail = signalMailFrom(email);
  const received = header(mail, "received")?.split(";").pop()?.trim();
  const receivedAt = received ? Date.parse(received) : NaN;
  const dateAt = mail.date ? Date.parse(mail.date) : NaN;
  const now = new Date(Number.isFinite(receivedAt) ? receivedAt : Number.isFinite(dateAt) ? dateAt + 3600_000 : Date.UTC(2026, 0, 1));
  const delivered = header(mail, "delivered-to") ?? header(mail, "to");
  const ownerDomain = domainOf(delivered);
  const ownerDomains = ownerDomain ? [ownerDomain] : [];
  const local = localSignals(mail, { ownerDomains, now });
  const signals = local.signals.filter((s) => s.id !== "auth_untrusted");
  const to = (email.to ?? []).flatMap((a) => (a.group ? a.group : [a])).map((a) => (a.address ?? "").toLowerCase()).filter(Boolean);
  return {
    item,
    fold: hash(item.id) % folds,
    mail,
    fromEmail: mail.fromEmail,
    signals,
    score: sumWeights(signals),
    tokens: tokenize({ subject: email.subject ?? null, fromEmail: mail.fromEmail, text: mail.text, html: mail.html }),
    classifier: {
      address: (delivered ?? to[0] ?? "owner@example.org").replace(/^.*</, "").replace(/>.*$/, "").toLowerCase(),
      fromEmail: mail.fromEmail,
      fromName: mail.fromName,
      replyTo: mail.replyTo,
      to,
      subject: email.subject ?? null,
      date: mail.date,
      auth: null,
      signals,
      linkDomains: linkDomains(local.links, ownerDomains, MAX_LOOKUP_DOMAINS),
      attachmentNames: mail.attachments.map((a) => a.filename).filter(Boolean),
      sender: null,
      text: mail.text,
      html: mail.html,
    },
  };
}

export async function prepareAll(items: CorpusItem[], folds: number): Promise<{ prepared: Prepared[]; unparsed: number }> {
  const prepared: Prepared[] = [];
  let unparsed = 0;
  for (const item of items) {
    const p = await prepare(item, folds);
    if (p) prepared.push(p);
    else unparsed++;
  }
  return { prepared, unparsed };
}

/** In-memory twin of services/spam/bayes.ts score(): same tokens, smoothing and top-20 log-odds. */
export class MemoryBayes {
  spamMessages = 0;
  hamMessages = 0;
  private counts = new Map<string, [spam: number, ham: number]>();

  learn(tokens: string[], spam: boolean) {
    if (spam) this.spamMessages++;
    else this.hamMessages++;
    for (const t of tokens) {
      const c = this.counts.get(t) ?? [0, 0];
      c[spam ? 0 : 1]++;
      this.counts.set(t, c);
    }
  }

  score(tokens: string[]) {
    const { spamMessages, hamMessages } = this;
    if (!spamMessages || !hamMessages) return { logOdds: 0, spamMessages, hamMessages };
    const decisive = tokens
      .flatMap((token) => {
        const c = this.counts.get(token);
        if (!c) return [];
        const f = Math.min(0.99, Math.max(0.01, tokenSpamProbability(c[0], c[1], spamMessages, hamMessages)));
        return Math.abs(f - 0.5) >= 0.1 ? [{ token, f }] : [];
      })
      .sort((a, b) => Math.abs(b.f - 0.5) - Math.abs(a.f - 0.5) || a.token.localeCompare(b.token))
      .slice(0, 20);
    return { logOdds: decisive.reduce((s, t) => s + Math.log(t.f / (1 - t.f)), 0), spamMessages, hamMessages };
  }
}

export interface Evaluated {
  p: Prepared;
  /** Layer-3 inputs from the training folds (Bayes, sender reputation). */
  input: CombinerInput;
  bayesSpam: boolean;
  dayOne: CombinedVerdict;
  handSet: CombinedVerdict;
  refit: CombinedVerdict;
  /** The AI-free weights refit on this message's training folds. */
  weights: Record<WeightSet, Weights>;
}

const isSpam = (l: Label) => l !== "ham";

/** Build Bayes and reputation using only the supplied training labels. */
export function trainedInput(train: Prepared[]): (p: Prepared, self: boolean) => CombinerInput {
  const bayes = new MemoryBayes();
  const senders = new Map<string, SenderHistory>();
  for (const p of train) {
    bayes.learn(p.tokens, isSpam(p.item.label));
    if (!p.fromEmail) continue;
    const s = senders.get(p.fromEmail) ?? { inbound: 0, outbound: 0, spam: 0, ham: 0 };
    s.inbound++;
    if (isSpam(p.item.label)) s.spam++;
    else s.ham++;
    senders.set(p.fromEmail, s);
  }
  const inputOf = (p: Prepared, self: boolean): CombinerInput => {
    const own = self ? senders.get(p.fromEmail) : undefined;
    // A training message's own label must not count toward its reputation.
    const sender = own
      ? { ...own, spam: own.spam - (isSpam(p.item.label) ? 1 : 0), ham: own.ham - (isSpam(p.item.label) ? 0 : 1) }
      : (senders.get(p.fromEmail) ?? null);
    return { layer1: { score: p.score, signals: p.signals }, bayes: bayes.score(p.tokens), sender, blockedSender: false };
  };
  return inputOf;
}

/**
 * K-fold: each fold is scored by Bayes, reputation and refit weights learned
 * only from the other folds, like a mailbox whose owner labelled the rest.
 * `trainLimit` caps the labels per fold to show a newer mailbox.
 */
export function crossValidate(prepared: Prepared[], folds: number, trainLimit = Infinity): Evaluated[] {
  const out: Evaluated[] = [];
  for (let k = 0; k < folds; k++) {
    const train = prepared
      .filter((p) => p.fold !== k)
      .sort((a, b) => hash(`train:${a.item.id}`) - hash(`train:${b.item.id}`))
      .slice(0, trainLimit);
    const test = prepared.filter((p) => p.fold === k);
    const inputOf = trainedInput(train);
    const samples = train.map((p) => {
      const f = featuresOf(inputOf(p, true));
      return { features: Object.fromEntries(BASE_FEATURES.map((x) => [x, f[x] ?? 0])), label: (isSpam(p.item.label) ? 1 : 0) as 0 | 1, ai: false };
    });
    const weights = { ...DEFAULT_WEIGHTS, "ai-free": fitWeights(samples, DEFAULT_WEIGHTS["ai-free"], BASE_FEATURES) };
    for (const p of test) {
      const input = inputOf(p, false);
      const empty: CombinerInput = { layer1: input.layer1, bayes: null, sender: null, blockedSender: false };
      out.push({
        p,
        input,
        bayesSpam: (input.bayes?.logOdds ?? 0) > 0,
        dayOne: combine(empty, DEFAULT_WEIGHTS),
        handSet: combine(input, DEFAULT_WEIGHTS),
        refit: combine(input, weights),
        weights,
      });
    }
  }
  return out;
}

export interface Metrics {
  n: number;
  ham: number;
  spam: number;
  phishing: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  /** Share of ham flagged as spam or quarantine. */
  fpr: number;
  /** Share of phishing sent to Quarantine. */
  phishQuarantined: number;
  hamQuarantined: number;
}

export type Decision = { flagged: boolean; quarantine: boolean };

export function metrics(rows: { label: Label; d: Decision }[]): Metrics {
  const ham = rows.filter((r) => r.label === "ham");
  const pos = rows.filter((r) => isSpam(r.label));
  const phish = rows.filter((r) => r.label === "phishing");
  const tp = pos.filter((r) => r.d.flagged).length;
  const fp = ham.filter((r) => r.d.flagged).length;
  const div = (a: number, b: number) => (b ? a / b : NaN);
  return {
    n: rows.length,
    ham: ham.length,
    spam: pos.length - phish.length,
    phishing: phish.length,
    tp,
    fp,
    fn: pos.length - tp,
    precision: div(tp, tp + fp),
    recall: div(tp, pos.length),
    fpr: div(fp, ham.length),
    phishQuarantined: div(phish.filter((r) => r.d.quarantine).length, phish.length),
    hamQuarantined: ham.filter((r) => r.d.quarantine).length,
  };
}

export const fromVerdict = (v: CombinedVerdict): Decision => ({ flagged: v.folder !== "inbox", quarantine: v.folder === "quarantine" });

export const pct = (x: number, digits = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "–");

export function metricsTable(rows: [string, Metrics][]): string {
  const lines = [
    "| Pipeline | Messages | Precision | Recall | False positive rate | False positives | Phishing → Quarantine | Ham → Quarantine |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [name, m] of rows) {
    lines.push(`| ${name} | ${m.n} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.fpr, 2)} | ${m.fp} of ${m.ham} | ${pct(m.phishQuarantined)} | ${m.hamQuarantined} |`);
  }
  return lines.join("\n");
}

function bySourceTable(evaluated: Evaluated[]): string {
  const sources = [...new Set(evaluated.map((e) => e.p.item.source))];
  const lines = ["| Source | Label | Messages | Flagged (hand-set) | Flagged (refit) | Quarantine (refit) |", "|---|---|---:|---:|---:|---:|"];
  for (const s of sources) {
    const rows = evaluated.filter((e) => e.p.item.source === s);
    const share = (f: (e: Evaluated) => boolean) => pct(rows.filter(f).length / rows.length);
    lines.push(
      `| ${s} | ${rows[0]!.p.item.label} | ${rows.length} | ${share((e) => e.handSet.folder !== "inbox")} | ${share((e) => e.refit.folder !== "inbox")} | ${share((e) => e.refit.folder === "quarantine")} |`,
    );
  }
  return lines.join("\n");
}

function topSignals(evaluated: Evaluated[], n = 12): string {
  const counts = new Map<string, Record<Label, number>>();
  for (const e of evaluated) {
    for (const id of new Set(e.p.signals.map((s) => s.id))) {
      const c = counts.get(id) ?? { ham: 0, spam: 0, phishing: 0 };
      c[e.p.item.label]++;
      counts.set(id, c);
    }
  }
  const totals = { ham: 0, spam: 0, phishing: 0 };
  for (const e of evaluated) totals[e.p.item.label]++;
  const lines = ["| Signal | Ham | Spam | Phishing |", "|---|---:|---:|---:|"];
  [...counts.entries()]
    .sort((a, b) => b[1].ham + b[1].spam + b[1].phishing - (a[1].ham + a[1].spam + a[1].phishing))
    .slice(0, n)
    .forEach(([id, c]) => lines.push(`| ${id} | ${pct(c.ham / totals.ham)} | ${pct(c.spam / totals.spam)} | ${pct(c.phishing / totals.phishing)} |`));
  return lines.join("\n");
}

export function pipelineRows(evaluated: Evaluated[]): [string, Metrics][] {
  const rows = (d: (e: Evaluated) => Decision) => metrics(evaluated.map((e) => ({ label: e.p.item.label, d: d(e) })));
  return [
    ["Layer 1 rules only (day one, no labels)", rows((e) => fromVerdict(e.dayOne))],
    ["Bayes only (log-odds > 0)", rows((e) => ({ flagged: e.bayesSpam, quarantine: false }))],
    ["AI off: rules + Bayes + reputation, hand-set weights", rows((e) => fromVerdict(e.handSet))],
    ["AI off: same, weights refit on labels", rows((e) => fromVerdict(e.refit))],
  ];
}

export async function loadEvaluated(corpus: string, folds: number, trainLimit = Infinity) {
  const items = loadCorpus(corpus);
  if (!items.length) throw new Error(`No corpus in ${corpus}: run scripts/fetch-corpus.sh first`);
  const { prepared, unparsed } = await prepareAll(items, folds);
  return { items, unparsed, evaluated: crossValidate(prepared, folds, trainLimit) };
}

async function main() {
  const { values } = parseArgs({
    options: {
      corpus: { type: "string", default: join(ROOT, ".corpus") },
      folds: { type: "string", default: "5" },
      "train-limit": { type: "string" },
      json: { type: "string" },
    },
  });
  const folds = Number(values.folds);
  if (!Number.isSafeInteger(folds) || folds < 2) throw new Error("--folds must be an integer of at least 2");
  const trainLimit = values["train-limit"] ? Number(values["train-limit"]) : Infinity;
  if (values["train-limit"] && (!Number.isSafeInteger(trainLimit) || trainLimit < 1)) throw new Error("--train-limit must be a positive integer");
  const started = Date.now();
  const { items, unparsed, evaluated } = await loadEvaluated(values.corpus!, folds, trainLimit);
  const rows = pipelineRows(evaluated);
  const counts = (l: Label) => evaluated.filter((e) => e.p.item.label === l).length;

  console.log(`# Spam eval (AI off)\n`);
  console.log(
    `${items.length} messages (${unparsed} unparseable): ${counts("ham")} ham, ${counts("spam")} spam, ${counts("phishing")} phishing. ` +
      `${folds}-fold cross-validation${Number.isFinite(trainLimit) ? `, at most ${trainLimit} labels per fold` : ""}. ` +
      `Spam = anything not left in the inbox; ${(Date.now() - started) / 1000}s.\n`,
  );
  console.log(metricsTable(rows));
  console.log(`\n## By source\n\n${bySourceTable(evaluated)}`);
  console.log(`\n## Most common layer-1 signals\n\n${topSignals(evaluated)}`);
  const fps = evaluated.filter((e) => e.p.item.label === "ham" && e.refit.folder !== "inbox").slice(0, 10);
  if (fps.length) {
    console.log(`\n## Sample false positives (refit)\n`);
    for (const e of fps) console.log(`- ${e.p.item.id}: p=${e.refit.probability} ${e.refit.folder}; ${e.p.signals.map((s) => s.id).join(", ") || "no signals"}`);
  }
  if (values.json) {
    const first = evaluated[0]?.weights["ai-free"];
    writeFileSync(values.json, JSON.stringify({ folds, trainLimit: values["train-limit"] ?? null, messages: items.length, unparsed, rows: Object.fromEntries(rows), refitWeightsFold0: first }, null, 2));
  }
}

if (import.meta.main) await main();
