import { and, eq, sql } from "drizzle-orm";
import { blockedSenders, messages, senderReputation, spamModels, threads } from "@boxox/db";
import { batch, type Db } from "../../db";
import type { BayesScore } from "./bayes";
import { classify, type ClassifierDeps, type ClassifierInput, type ClassifierOutcome, type ClassifierVerdict } from "./classifier";
import type { Layer1Result } from "./signals-run";
import type { Signal } from "./signals";

/**
 * Spam layer 3: a small logistic regression over the other layers' scores.
 * Two weight sets live in spam_models ("combiner" / "ai" and "ai-free");
 * whenever the classifier didn't run (AI off, budget spent, error) the
 * AI-free set decides. The AI inputs' total pull is capped, so text that
 * talks the model into "not spam" can only nudge the verdict, never decide it.
 */

export const BASE_FEATURES = ["rules", "links", "bayes", "reputation"] as const;
export const AI_FEATURES = ["knn", "ai_spam", "ai_phishing", "ai_impersonation", "ai_injection"] as const;
export type Feature = (typeof BASE_FEATURES)[number] | (typeof AI_FEATURES)[number];
export type Features = Partial<Record<Feature, number>>;

export type WeightSet = "ai" | "ai-free";
export interface Weights {
  bias: number;
  weights: Features;
}

/** Most the AI inputs together may move the log-odds, either way. */
export const AI_CAP = 2;
export const SPAM_THRESHOLD = 0.5;
export const QUARANTINE_THRESHOLD = 0.8;
/** With "only when uncertain", the classifier runs only between these. */
export const UNCERTAIN = [0.15, 0.85] as const;

export const DEFAULT_WEIGHTS: Record<WeightSet, Weights> = {
  "ai-free": { bias: -2.5, weights: { rules: 1.6, links: 2.5, bayes: 1, reputation: 0.8 } },
  ai: {
    bias: -2.5,
    weights: { rules: 1.4, links: 2.2, bayes: 0.9, reputation: 0.7, knn: 0.4, ai_spam: 0.8, ai_phishing: 0.3, ai_impersonation: 0.2, ai_injection: 0.3 },
  },
};

/** Phishing is a second, hand-set model; owner labels are only spam / not spam. */
const PHISHING_SIGNALS = new Set([
  "openphish_listed", "cf_security_blocked", "spamhaus_dbl", "lookalike_owner_domain", "lookalike_brand_domain",
  "display_name_spoofs_owner", "display_name_spoofs_contact", "owner_domain_spoof", "link_text_mismatch",
  "double_extension", "dangerous_attachment",
]);
const LINK_SIGNALS = new Set(["openphish_listed", "cf_security_blocked", "spamhaus_dbl"]);
const PHISHING_WEIGHTS = { bias: -3, signals: 2, ai_phishing: 1.5, ai_impersonation: 0.5 };

export interface SenderHistory {
  inbound: number;
  outbound: number;
  spam: number;
  ham: number;
}

export interface CombinerInput {
  layer1: Pick<Layer1Result, "score" | "signals">;
  bayes: Pick<BayesScore, "logOdds" | "spamMessages" | "hamMessages"> | null;
  sender: SenderHistory | null;
  blockedSender: boolean;
  /** Spam share among the nearest labelled neighbours, when the vote ran. */
  knnShare?: number | null;
  ai?: Pick<ClassifierVerdict, "spam" | "phishing" | "impersonation" | "prompt_injection"> | null;
}

export type Folder = "inbox" | "spam" | "quarantine";
export type HardRule = "blocked-sender" | "wrote-to-sender";

export interface Contribution {
  feature: Feature | "bias";
  value: number;
  weight: number;
  contribution: number;
}

export interface CombinedVerdict {
  version: 1;
  folder: Folder;
  probability: number;
  phishing: number;
  weights: WeightSet;
  /** Why the AI-free set was used, e.g. "budget-spent"; null when the AI set ran. */
  fallback: string | null;
  hardRule: HardRule | null;
  features: Features;
  contributions: Contribution[];
  phishingSignals: string[];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const round = (x: number) => Math.round(x * 1000) / 1000;

/** Inputs → features on comparable scales; AI features only when the classifier ran. */
export function featuresOf(input: CombinerInput): Features {
  const sender = input.sender;
  const labelled = sender ? sender.spam + sender.ham : 0;
  const trained = !!input.bayes && input.bayes.spamMessages > 0 && input.bayes.hamMessages > 0;
  const f: Features = {
    rules: clamp(input.layer1.score, -5, 20) / 5,
    links: Math.min(3, input.layer1.signals.filter((s) => LINK_SIGNALS.has(s.id)).length),
    bayes: trained ? clamp(input.bayes!.logOdds, -20, 20) / 5 : 0,
    reputation: labelled ? clamp(Math.log((sender!.spam + 0.5) / (sender!.ham + 0.5)), -3, 3) : 0,
  };
  if (input.ai) {
    f.knn = input.knnShare == null ? 0 : (clamp(input.knnShare, 0, 1) - 0.5) * 2;
    f.ai_spam = (clamp(input.ai.spam, 0, 1) - 0.5) * 2;
    f.ai_phishing = clamp(input.ai.phishing, 0, 1);
    f.ai_impersonation = clamp(input.ai.impersonation, 0, 1);
    f.ai_injection = clamp(input.ai.prompt_injection, 0, 1);
  }
  return f;
}

/** Most the AI set's bias may be: with no other evidence, even a maxed-out AI pull stays below 0.5. */
export const AI_MAX_BIAS = -(AI_CAP + 0.5);

/**
 * Scales the AI weights down so their combined pull stays within AI_CAP, and
 * keeps the bias low enough that the AI inputs alone can't flag clean mail.
 */
export function capAiWeights(w: Weights): Weights {
  const total = AI_FEATURES.reduce((s, k) => s + Math.abs(w.weights[k] ?? 0), 0);
  const k = total > AI_CAP ? AI_CAP / total : 1;
  const weights = { ...w.weights };
  for (const f of AI_FEATURES) if (weights[f] !== undefined) weights[f] = weights[f]! * k;
  return { bias: Math.min(w.bias, AI_MAX_BIAS), weights };
}

function phishingOf(signals: Signal[], f: Features): { probability: number; signals: string[] } {
  const hits = signals.filter((s) => PHISHING_SIGNALS.has(s.id));
  const sum = hits.reduce((s, x) => s + Math.max(0, x.weight), 0);
  const ai = Math.min(AI_CAP, PHISHING_WEIGHTS.ai_phishing * (f.ai_phishing ?? 0) + PHISHING_WEIGHTS.ai_impersonation * (f.ai_impersonation ?? 0));
  const logit = PHISHING_WEIGHTS.bias + PHISHING_WEIGHTS.signals * (Math.min(sum, 25) / 5) + ai;
  return { probability: sigmoid(logit), signals: [...new Set(hits.map((h) => h.id))] };
}

export function logit(w: Weights, f: Features): number {
  return Object.entries(f).reduce((s, [k, v]) => s + (w.weights[k as Feature] ?? 0) * v, w.bias);
}

/**
 * The verdict for one message. Hard rules first: a blocked sender is spam,
 * someone the owner has written to is inbox. Otherwise phishing above the
 * quarantine threshold goes to Quarantine, and spam above 0.5 to Spam.
 */
export function combine(input: CombinerInput, weights: Record<WeightSet, Weights> = DEFAULT_WEIGHTS, fallback: string | null = null): CombinedVerdict {
  const features = featuresOf(input);
  const set: WeightSet = input.ai ? "ai" : "ai-free";
  const w = set === "ai" ? capAiWeights(weights.ai) : weights["ai-free"];
  const contributions: Contribution[] = [
    { feature: "bias" as const, value: 1, weight: w.bias, contribution: w.bias },
    ...Object.entries(features).map(([k, v]) => {
      const weight = w.weights[k as Feature] ?? 0;
      return { feature: k as Feature, value: v, weight, contribution: weight * v };
    }),
  ].map((c) => ({ ...c, value: round(c.value), weight: round(c.weight), contribution: round(c.contribution) }));
  const probability = sigmoid(logit(w, features));
  const phishing = phishingOf(input.layer1.signals, features);

  const hardRule: HardRule | null = input.blockedSender ? "blocked-sender" : (input.sender?.outbound ?? 0) > 0 ? "wrote-to-sender" : null;
  const folder: Folder =
    hardRule === "blocked-sender"
      ? "spam"
      : hardRule === "wrote-to-sender"
        ? "inbox"
        : phishing.probability >= QUARANTINE_THRESHOLD
          ? "quarantine"
          : probability >= SPAM_THRESHOLD
            ? "spam"
            : "inbox";

  return {
    version: 1,
    folder,
    probability: round(probability),
    phishing: round(phishing.probability),
    weights: set,
    fallback: set === "ai" ? null : fallback,
    hardRule,
    features: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, round(v)])),
    contributions,
    phishingSignals: phishing.signals,
  };
}

function parseWeights(params: Record<string, unknown> | undefined, fallback: Weights): Weights {
  const bias = params?.bias;
  const raw = params?.weights;
  if (typeof bias !== "number" || !Number.isFinite(bias) || !raw || typeof raw !== "object") return fallback;
  const weights: Features = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) weights[k as Feature] = v;
  }
  return { bias, weights };
}

/** The refit weights, or the hand-set ones where no refit has been stored. */
export async function loadWeights(db: Db): Promise<Record<WeightSet, Weights>> {
  const rows = await db.select().from(spamModels).where(eq(spamModels.name, "combiner"));
  const by = new Map(rows.map((r) => [r.variant, r.params]));
  return {
    ai: parseWeights(by.get("ai"), DEFAULT_WEIGHTS.ai),
    "ai-free": parseWeights(by.get("ai-free"), DEFAULT_WEIGHTS["ai-free"]),
  };
}

export async function saveWeights(db: Db, variant: WeightSet, w: Weights, sampleCount: number, now = new Date()): Promise<void> {
  const params = { bias: w.bias, weights: w.weights };
  await db
    .insert(spamModels)
    .values({ name: "combiner", variant, params, sampleCount, fittedAt: now })
    .onConflictDoUpdate({
      target: [spamModels.name, spamModels.variant],
      set: { params, sampleCount, fittedAt: now, updatedAt: sql`cast(unixepoch('subsec') * 1000 as integer)` },
    });
}

export async function senderHistory(db: Db, email: string): Promise<SenderHistory | null> {
  const row = await db.select().from(senderReputation).where(eq(senderReputation.email, email.toLowerCase())).get();
  return row ? { inbound: row.inboundCount, outbound: row.outboundCount, spam: row.spamCount, ham: row.hamCount } : null;
}

export async function isBlockedSender(db: Db, orgId: string, email: string): Promise<boolean> {
  const row = await db
    .select({ id: blockedSenders.id })
    .from(blockedSenders)
    .where(and(eq(blockedSenders.organizationId, orgId), eq(blockedSenders.email, email.toLowerCase())))
    .get();
  return !!row;
}

export interface ScanInput extends Omit<CombinerInput, "ai"> {
  classifier: ClassifierInput;
  /** Earlier unscanned attempts, for the rescan back-off. */
  attempt?: number;
}

export interface ScanDeps extends ClassifierDeps {
  db: Db;
  onlyWhenUncertain: boolean;
}

export interface ScanResult {
  verdict: CombinedVerdict;
  /** Null when the classifier was not asked: a hard rule or an already certain verdict. */
  classifier: ClassifierOutcome | null;
}

/**
 * Layers combined for one message. The AI-free verdict comes first; the
 * classifier only runs when no hard rule applies and, with "only when
 * uncertain", when that verdict is inconclusive. If it is skipped (budget
 * spent, AI off) or fails, the AI-free verdict stands, tagged with the reason.
 */
export async function scanMessage(deps: ScanDeps, input: ScanInput): Promise<ScanResult> {
  const weights = await loadWeights(deps.db);
  const base = combine({ ...input, ai: null }, weights);
  if (base.hardRule) return { verdict: { ...base, fallback: "hard-rule" }, classifier: null };
  const certain = base.probability < UNCERTAIN[0] || base.probability > UNCERTAIN[1] || base.folder === "quarantine";
  if (deps.onlyWhenUncertain && certain) return { verdict: { ...base, fallback: "certain" }, classifier: null };

  const outcome = await classify(deps, input.classifier, input.attempt ?? 0);
  if (outcome.status === "scanned") return { verdict: combine({ ...input, ai: outcome.verdict }, weights), classifier: outcome };
  const reason = outcome.status === "skipped" ? outcome.reason : `unscanned:${outcome.reason}`;
  return { verdict: { ...base, fallback: reason }, classifier: outcome };
}

/**
 * Stores the verdict JSON for the "why" panel and moves the thread. Only a
 * thread still in the inbox moves to Spam or Quarantine; an inbox verdict
 * never pulls a thread out of a folder the owner chose.
 */
export async function recordVerdict(db: Db, messageId: string, result: ScanResult): Promise<Folder | null> {
  const row = await db
    .select({ verdict: messages.spamVerdict, threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (!row) return null;
  const outcome = result.classifier;
  const ai =
    outcome?.status === "scanned"
      ? { status: "scanned", model: outcome.model, ...outcome.verdict }
      : outcome?.status === "unscanned"
        ? { status: "unscanned", model: outcome.model, reason: outcome.reason, attempt: outcome.attempt, rescanAt: outcome.rescanAt }
        : outcome
          ? { status: "skipped", reason: outcome.reason }
          : { status: "skipped", reason: result.verdict.fallback };
  const spamVerdict = { ...(row.verdict ?? {}), ai, combiner: result.verdict };
  const scanStatus = outcome?.status === "unscanned" ? ("unscanned" as const) : ("scanned" as const);
  const updates = [db.update(messages).set({ spamVerdict, scanStatus }).where(eq(messages.id, messageId))];
  // Commit the replay marker and folder together: a retried scan must never
  // observe a saved verdict whose thread move was lost to a partial write.
  await batch(db, [
    ...updates,
    ...(outcome?.status === "scanned" ? [db.update(threads)
      .set({ priority: outcome.verdict.priority, category: outcome.verdict.category, updatedAt: new Date() })
      .where(eq(threads.id, row.threadId))] : []),
    ...(result.verdict.folder !== "inbox" ? [db.update(threads)
      .set({ folder: result.verdict.folder, updatedAt: new Date() })
      .where(and(eq(threads.id, row.threadId), eq(threads.folder, "inbox")))] : []),
  ]);
  return result.verdict.folder;
}
