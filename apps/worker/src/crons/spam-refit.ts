import { eq } from "drizzle-orm";
import { messages, spamTraining } from "@boxox/db";
import { createDb, type Db } from "../db";
import type { Env } from "../env";
import { log } from "../log";
import {
  AI_FEATURES,
  BASE_FEATURES,
  capAiWeights,
  loadWeights,
  logit,
  saveWeights,
  sigmoid,
  type Feature,
  type Features,
  type Weights,
  type WeightSet,
} from "../services/spam/combine";

export const SPAM_REFIT_CRON = "0 3 * * *";
export const MIN_SAMPLES = 10;
export const MIN_PER_CLASS = 3;
const ITERATIONS = 400;
const LEARNING_RATE = 0.3;
/** L2 pull toward the current weights, so a handful of labels can't swing them wildly. */
const PRIOR_STRENGTH = 2;
const MAX_WEIGHT = 10;
const MAX_SAMPLES = 5000;

export interface Sample {
  features: Features;
  /** 1 spam, 0 not spam. */
  label: 0 | 1;
  /** The classifier ran for this message, so its AI features are real. */
  ai: boolean;
}

/** Owner-labelled messages with the features their stored verdict was made from. */
export async function labelledSamples(db: Db, limit = MAX_SAMPLES): Promise<Sample[]> {
  const rows = await db
    .select({ label: spamTraining.label, verdict: messages.spamVerdict })
    .from(spamTraining)
    .innerJoin(messages, eq(messages.id, spamTraining.messageId))
    .orderBy(spamTraining.trainedAt)
    .limit(limit);
  return rows.flatMap((r) => {
    const combiner = (r.verdict as { combiner?: { features?: unknown; weights?: unknown } } | null)?.combiner;
    const raw = combiner?.features;
    if (!raw || typeof raw !== "object") return [];
    const features: Features = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) features[k as Feature] = v;
    }
    return [{ features, label: r.label === "spam" ? 1 : 0, ai: combiner?.weights === "ai" } satisfies Sample];
  });
}

export function logLoss(w: Weights, samples: Sample[]): number {
  if (!samples.length) return 0;
  const eps = 1e-9;
  return (
    samples.reduce((s, x) => {
      const p = sigmoid(logit(w, x.features));
      return s - (x.label ? Math.log(p + eps) : Math.log(1 - p + eps));
    }, 0) / samples.length
  );
}

/**
 * Logistic regression by batch gradient descent, starting from and
 * regularised toward `prior`. Classes are weighted equally so a mostly-ham
 * mailbox doesn't learn to call everything ham.
 */
export function fitWeights(samples: Sample[], prior: Weights, features: readonly Feature[]): Weights {
  const pos = samples.filter((s) => s.label).length;
  const neg = samples.length - pos;
  const classWeight = (y: 0 | 1) => samples.length / (2 * (y ? pos : neg));
  const w: Weights = { bias: prior.bias, weights: Object.fromEntries(features.map((f) => [f, prior.weights[f] ?? 0])) };
  const lambda = PRIOR_STRENGTH / samples.length;
  for (let it = 0; it < ITERATIONS; it++) {
    let gBias = 0;
    const g: Record<string, number> = Object.fromEntries(features.map((f) => [f, 0]));
    for (const s of samples) {
      const err = (sigmoid(logit(w, s.features)) - s.label) * classWeight(s.label);
      gBias += err;
      for (const f of features) g[f]! += err * (s.features[f] ?? 0);
    }
    w.bias -= (LEARNING_RATE * gBias) / samples.length;
    for (const f of features) {
      const reg = lambda * ((w.weights[f] ?? 0) - (prior.weights[f] ?? 0));
      w.weights[f] = Math.max(-MAX_WEIGHT, Math.min(MAX_WEIGHT, w.weights[f]! - LEARNING_RATE * (g[f]! / samples.length + reg)));
    }
    w.bias = Math.max(-MAX_WEIGHT, Math.min(MAX_WEIGHT, w.bias));
  }
  return w;
}

export type RefitOutcome = { variant: WeightSet; status: "fitted"; samples: number; loss: [before: number, after: number] } | { variant: WeightSet; status: "skipped"; samples: number };

const enough = (samples: Sample[]) => {
  const pos = samples.filter((s) => s.label).length;
  return samples.length >= MIN_SAMPLES && pos >= MIN_PER_CLASS && samples.length - pos >= MIN_PER_CLASS;
};

/**
 * Nightly: refit both weight sets from the owner's spam / not-spam labels.
 * The AI-free set learns from every labelled message's non-AI features; the
 * AI set only from messages the classifier actually scored. A set with too
 * few labels keeps its current weights.
 */
export async function refitCombiner(env: Pick<Env, "DB">, now = new Date()): Promise<RefitOutcome[]> {
  const db = createDb(env);
  const current = await loadWeights(db);
  const all = await labelledSamples(db);
  const plan: [WeightSet, Sample[], readonly Feature[]][] = [
    ["ai-free", all.map((s) => ({ ...s, features: Object.fromEntries(BASE_FEATURES.map((f) => [f, s.features[f] ?? 0])) })), BASE_FEATURES],
    ["ai", all.filter((s) => s.ai), [...BASE_FEATURES, ...AI_FEATURES]],
  ];
  const out: RefitOutcome[] = [];
  for (const [variant, samples, features] of plan) {
    if (!enough(samples)) {
      out.push({ variant, status: "skipped", samples: samples.length });
      continue;
    }
    let fitted = fitWeights(samples, current[variant], features);
    if (variant === "ai") fitted = capAiWeights(fitted);
    const loss: [number, number] = [logLoss(current[variant], samples), logLoss(fitted, samples)];
    await saveWeights(db, variant, fitted, samples.length, now);
    out.push({ variant, status: "fitted", samples: samples.length, loss });
  }
  log.info("spam_refit", { outcomes: out.map((o) => `${o.variant}:${o.status}:${o.samples}`) });
  return out;
}
