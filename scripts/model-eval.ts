/**
 * Model bake-off for the spam classifier (docs/v2-plan.md, "AI use"). Runs
 * each candidate through the worker's own classify() → runAi() → env.AI.run
 * on a stratified sample of the labelled corpus, then compares the whole
 * pipeline with AI on and off. Results go to docs/model-eval.md.
 *
 *   node --experimental-transform-types scripts/model-eval.ts [--sample 400] [--concurrency 4]
 *     [--third-party --gateway <id>] [--model <id> ...] [--dry-run] [--fresh] [--cache-only]
 *
 * env.AI is a real remote Workers AI binding from wrangler's platform proxy
 * (wrangler login). Without --gateway, calls skip AI Gateway, which is fine
 * for @cf/ models. --third-party adds the OpenAI and Anthropic candidates;
 * they need AI Gateway credits and an authenticated gateway (Unified Billing,
 * docs/spikes/ai-thirdparty.md), and send corpus mail out of Cloudflare.
 * Model replies are cached in .corpus/results/ so reruns only call what's new.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  fromVerdict,
  hash,
  loadEvaluated,
  metrics,
  metricsTable,
  pct,
  trainedInput,
  type Decision,
  type Evaluated,
  type Label,
  type Metrics,
} from "./spam-eval.ts";

const ROOT = join(import.meta.dirname, "..");
const { MODELS, PRESETS, isAllowedModel, memoryBudgetStore, estimateCost } = await import("../apps/worker/src/services/ai/index.ts");
const { classify, classifierInstructions } = await import("../apps/worker/src/services/spam/classifier.ts");
const { combine, capAiWeights, DEFAULT_WEIGHTS, featuresOf, AI_FEATURES, BASE_FEATURES, UNCERTAIN } = await import(
  "../apps/worker/src/services/spam/combine.ts"
);
const { fitWeights } = await import("../apps/worker/src/crons/spam-refit.ts");

import type { ModelId } from "../apps/worker/src/services/ai/models.ts";
import type { ClassifierOutcome, ClassifierVerdict } from "../apps/worker/src/services/spam/classifier.ts";
import type { CombinedVerdict, Weights, WeightSet } from "../apps/worker/src/services/spam/combine.ts";

export const CLOUDFLARE_CANDIDATES: ModelId[] = [PRESETS.cloudflare.classify!];
/** The plan's third-party candidates, enabled with --third-party. */
export const THIRD_PARTY_CANDIDATES: ModelId[] = ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5", "openai/gpt-5.6-luna"];
/** Workers AI list price (docs/spikes/ai.md). */
const USD_PER_NEURON = 0.011 / 1000;
// Classifier inputs must not carry label-derived reputation: cached predictions
// are reused across outer folds while fitting AI weights.
const EVAL_PROTOCOL = "no-label-derived-sender-v2";
const SAMPLE_SHARE: Record<Label, number> = { ham: 0.5, spam: 0.25, phishing: 0.25 };

interface CallRecord {
  id: string;
  ms: number | null;
  costUsd: number;
  neurons: number | null;
  inputTokens?: number;
  outputTokens?: number;
  outcome: ClassifierOutcome;
}

/** Fixed share per label, spread evenly over that label's sources, in hash order. */
export function stratifiedSample(evaluated: Evaluated[], size: number, seed = "model-eval"): Evaluated[] {
  const out: Evaluated[] = [];
  for (const label of ["ham", "spam", "phishing"] as Label[]) {
    const quota = Math.round(size * SAMPLE_SHARE[label]);
    const bySource = new Map<string, Evaluated[]>();
    for (const e of evaluated.filter((e) => e.p.item.label === label)) {
      bySource.set(e.p.item.source, [...(bySource.get(e.p.item.source) ?? []), e]);
    }
    const queues = [...bySource.values()].map((q) => q.sort((a, b) => hash(seed + a.p.item.id) - hash(seed + b.p.item.id)));
    for (let i = 0; out.filter((e) => e.p.item.label === label).length < quota && queues.some((q) => q.length); i++) {
      const q = queues[i % queues.length]!;
      if (q.length) out.push(q.shift()!);
    }
  }
  return out;
}

const slug = (model: string) => model.replace(/[^a-z0-9.-]+/gi, "_");

function readCache(file: string): Map<string, CallRecord> {
  const cache = new Map<string, CallRecord>();
  if (!existsSync(file)) return cache;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as CallRecord;
    cache.set(r.id, r);
  }
  return cache;
}

async function remoteAi(): Promise<{ ai: Ai; dispose: () => Promise<void> }> {
  const dir = join(tmpdir(), `boxox-model-eval-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "wrangler.json");
  writeFileSync(config, JSON.stringify({ name: "boxox-model-eval", compatibility_date: "2026-06-01", ai: { binding: "AI", remote: true } }));
  const { getPlatformProxy } = await import(createRequire(join(ROOT, "package.json")).resolve("wrangler"));
  const proxy = await getPlatformProxy({ configPath: config, persist: false });
  return {
    ai: (proxy.env as { AI: Ai }).AI,
    dispose: async () => {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Runs one model over the sample. The binding is wrapped only to time the
 * call, read usage, and keep gateway logs off (collectLog: false, per
 * docs/spikes/ai.md); the request itself is classify()'s, unchanged.
 */
async function runModel(model: ModelId, sample: Evaluated[], ai: Ai, opts: { gateway?: string; concurrency: number; cacheFile: string }) {
  const cache = readCache(opts.cacheFile);
  const todo = sample.filter((e) => !cache.has(e.p.item.id));
  const queue = [...todo];
  let done = 0;
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      let call: { ms: number; output: unknown; input: unknown } | null = null;
      const wrapped = {
        run: async (m: string, input: unknown, options?: AiOptions) => {
          const started = performance.now();
          const gw = options?.gateway;
          const output = opts.gateway
            ? await (ai.run as (m: string, i: unknown, o: AiOptions) => Promise<unknown>)(m, input, { ...options, gateway: { ...gw!, id: opts.gateway, collectLog: false } })
            : await (ai.run as (m: string, i: unknown) => Promise<unknown>)(m, input);
          call = { ms: performance.now() - started, output, input };
          return output;
        },
      };
      const provider = MODELS[model].provider;
      const outcome = await classify(
        {
          ai: wrapped as unknown as Ai,
          budget: memoryBudgetStore(),
          gatewayId: opts.gateway,
          config: { consent: { enabled: true, provider }, model, ownerRules: [], dailyBudgetUsd: 1000 },
        },
        { ...e.p.classifier, sender: null },
      );
      const c = call as { ms: number; output: unknown; input: unknown } | null;
      const usage = (c?.output as { usage?: { neurons?: number; prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } } | null)?.usage;
      const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens;
      const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;
      const record: CallRecord = {
        id: e.p.item.id,
        ms: c ? Math.round(c.ms) : null,
        costUsd: typeof inputTokens === "number" && typeof outputTokens === "number"
          ? (inputTokens * MODELS[model].inputPerM + outputTokens * MODELS[model].outputPerM) / 1e6
          : c ? estimateCost(MODELS[model], c.input, c.output) : 0,
        inputTokens,
        outputTokens,
        neurons: typeof usage?.neurons === "number" ? usage.neurons : null,
        outcome,
      };
      cache.set(record.id, record);
      appendFileSync(opts.cacheFile, JSON.stringify(record) + "\n");
      if (++done % 25 === 0) process.stderr.write(`  ${model}: ${done}/${todo.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  return sample.map((e) => cache.get(e.p.item.id)!);
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
};

const aiDecision = (v: ClassifierVerdict): Decision => ({
  flagged: v.spam >= 0.5 || v.phishing >= 0.5 || ["spam", "phishing", "scam"].includes(v.category),
  quarantine: v.phishing >= 0.5 || v.category === "phishing",
});

/** AI weights refit by k-fold within the sample (the AI set only learns from scored mail). */
function refitAiWeights(population: Evaluated[], sample: Evaluated[], verdicts: Map<string, ClassifierVerdict>, folds: number): Map<string, Weights> {
  const features = [...BASE_FEATURES, ...AI_FEATURES];
  const out = new Map<string, Weights>();
  for (let k = 0; k < folds; k++) {
    const train = sample.filter((e) => e.p.fold !== k && verdicts.has(e.p.item.id));
    // Rebuild base learners inside the outer fold. Reusing each training row's
    // own held-out input would let this fold's labels leak into AI meta-training.
    const inputOf = trainedInput(population.filter((e) => e.p.fold !== k).map((e) => e.p));
    const samples = train.map((e) => ({
      features: featuresOf({ ...inputOf(e.p, true), ai: verdicts.get(e.p.item.id)! }),
      label: (e.p.item.label === "ham" ? 0 : 1) as 0 | 1,
      ai: true,
    }));
    const w = samples.length ? capAiWeights(fitWeights(samples, DEFAULT_WEIGHTS.ai, features)) : DEFAULT_WEIGHTS.ai;
    for (const e of sample.filter((e) => e.p.fold === k)) out.set(e.p.item.id, w);
  }
  return out;
}

function summarise(model: ModelId, population: Evaluated[], sample: Evaluated[], records: CallRecord[], folds: number) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const verdicts = new Map<string, ClassifierVerdict>();
  for (const r of records) if (r.outcome.status === "scanned") verdicts.set(r.id, r.outcome.verdict);
  const scanned = records.filter((r) => r.outcome.status === "scanned");
  const unscanned = records.filter((r) => r.outcome.status === "unscanned");
  const reasons: Record<string, number> = {};
  for (const r of unscanned) if (r.outcome.status === "unscanned") reasons[r.outcome.reason] = (reasons[r.outcome.reason] ?? 0) + 1;
  const ms = records.map((r) => r.ms).filter((x): x is number => x !== null);
  const neurons = records.map((r) => r.neurons).filter((x): x is number => x !== null);
  const aiWeights = refitAiWeights(population, sample, verdicts, folds);

  const withAi = (e: Evaluated, weights: Record<WeightSet, Weights>, onlyWhenUncertain: boolean): CombinedVerdict => {
    const base = combine({ ...e.input, ai: null }, weights);
    const certain = base.probability < UNCERTAIN[0] || base.probability > UNCERTAIN[1] || base.folder === "quarantine";
    const v = verdicts.get(e.p.item.id);
    if ((onlyWhenUncertain && certain) || !v) return base;
    return combine({ ...e.input, ai: v }, weights);
  };
  const rows = (d: (e: Evaluated) => Decision): Metrics => metrics(sample.map((e) => ({ label: e.p.item.label, d: d(e) })));
  const scannedSample = sample.filter((e) => verdicts.has(e.p.item.id));
  const refitSet = (e: Evaluated) => ({ "ai-free": e.weights["ai-free"], ai: aiWeights.get(e.p.item.id)! });

  return {
    model,
    calls: records.length,
    schemaValid: scanned.length / records.length,
    unscanned: reasons,
    p50: quantile(ms, 0.5),
    p95: quantile(ms, 0.95),
    costPer1000: (records.reduce((s, r) => s + r.costUsd, 0) / records.length) * 1000,
    neuronsPer1000: neurons.length ? (neurons.reduce((s, x) => s + x, 0) / neurons.length) * 1000 : null,
    aiAlone: metrics(scannedSample.map((e) => ({ label: e.p.item.label, d: aiDecision(verdicts.get(e.p.item.id)!) }))),
    pipeline: [
      ["AI off (refit AI-free weights)", rows((e) => fromVerdict(e.refit))],
      ["AI on, every message, hand-set AI weights", rows((e) => fromVerdict(withAi(e, { ...e.weights, ai: DEFAULT_WEIGHTS.ai }, false)))],
      ["AI on, every message, refit AI weights", rows((e) => fromVerdict(withAi(e, refitSet(e), false)))],
      ["AI on, only when uncertain, refit AI weights", rows((e) => fromVerdict(withAi(e, refitSet(e), true)))],
    ] as [string, Metrics][],
    injection: scannedSample.filter((e) => verdicts.get(e.p.item.id)!.prompt_injection >= 0.5).length,
    uncertainShare: sample.filter((e) => {
      const p = combine({ ...e.input, ai: null }, e.weights);
      return p.folder !== "quarantine" && p.probability >= UNCERTAIN[0] && p.probability <= UNCERTAIN[1];
    }).length / sample.length,
    byId,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      corpus: { type: "string", default: join(ROOT, ".corpus") },
      sample: { type: "string", default: "400" },
      folds: { type: "string", default: "5" },
      concurrency: { type: "string", default: "4" },
      model: { type: "string", multiple: true },
      "third-party": { type: "boolean", default: false },
      gateway: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      "cache-only": { type: "boolean", default: false },
      json: { type: "string" },
    },
  });
  const models = [...(values.model ?? CLOUDFLARE_CANDIDATES), ...(values["third-party"] ? THIRD_PARTY_CANDIDATES : [])];
  for (const m of models) {
    if (!isAllowedModel(m) || !MODELS[m].tasks.includes("classify" as never)) throw new Error(`${m} is not an allow-listed classify model`);
    if (MODELS[m].leavesCloudflare && !values.gateway) throw new Error(`${m} needs --gateway <id>: Unified Billing only works through an authenticated AI Gateway`);
  }
  if (values.fresh && values["cache-only"]) throw new Error("--fresh and --cache-only cannot be combined");
  for (const key of ["sample", "folds", "concurrency"] as const) {
    const n = Number(values[key]);
    if (!Number.isSafeInteger(n) || n < (key === "folds" ? 2 : 1)) throw new Error(`--${key} must be a positive integer${key === "folds" ? " of at least 2" : ""}`);
  }
  const folds = Number(values.folds);
  const { evaluated } = await loadEvaluated(values.corpus!, folds);
  const sample = stratifiedSample(evaluated, Number(values.sample));
  const count = (l: Label) => sample.filter((e) => e.p.item.label === l).length;
  console.log(`# Model eval\n\nSample: ${sample.length} messages (${count("ham")} ham, ${count("spam")} spam, ${count("phishing")} phishing), models: ${models.join(", ")}.\n`);
  if (values["dry-run"]) return;

  const results = join(values.corpus!, "results");
  mkdirSync(results, { recursive: true });
  const remote = values["cache-only"] ? null : await remoteAi();
  const summaries = [];
  try {
    for (const model of models as ModelId[]) {
      // Keyed by the prompt and evaluation protocol. Use --fresh if the corpus
      // or production request builder changes.
      const cacheFile = join(results, `${slug(model)}-${hash(classifierInstructions([]) + EVAL_PROTOCOL).toString(16)}.jsonl`);
      if (values.fresh) rmSync(cacheFile, { force: true });
      const cached = readCache(cacheFile);
      const missing = sample.filter((e) => !cached.has(e.p.item.id));
      if (values["cache-only"] && missing.length) throw new Error(`${model}: ${missing.length} uncached messages; rerun without --cache-only`);
      const records = remote
        ? await runModel(model, sample, remote.ai, { gateway: values.gateway, concurrency: Number(values.concurrency), cacheFile })
        : sample.map((e) => cached.get(e.p.item.id)!);
      summaries.push(summarise(model, evaluated, sample, records, folds));
    }
  } finally {
    await remote?.dispose();
  }

  console.log("| Model | Schema-valid | Unscanned | Precision | Recall | False positive rate | Phishing → Quarantine | p50 | p95 | Cost per 1,000 emails |");
  console.log("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of summaries) {
    const un = Object.entries(s.unscanned).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
    const neurons = s.neuronsPer1000 === null ? "" : ` (${Math.round(s.neuronsPer1000)} Neurons ≈ $${(s.neuronsPer1000 * USD_PER_NEURON).toFixed(3)})`;
    console.log(
      `| ${s.model} | ${pct(s.schemaValid)} (${Math.round(s.schemaValid * s.calls)}/${s.calls}) | ${un} | ${pct(s.aiAlone.precision)} | ${pct(s.aiAlone.recall)} | ` +
        `${pct(s.aiAlone.fpr, 2)} (${s.aiAlone.fp}/${s.aiAlone.ham}) | ${pct(s.aiAlone.phishQuarantined)} | ${Math.round(s.p50)} ms | ${Math.round(s.p95)} ms | $${s.costPer1000.toFixed(3)}${neurons} |`,
    );
  }
  for (const s of summaries) {
    console.log(`\n## Pipeline with ${s.model}, AI on vs AI off\n`);
    console.log(metricsTable(s.pipeline));
    console.log(`\nprompt_injection ≥ 0.5 on ${s.injection} messages; "only when uncertain" would call the model on ${pct(s.uncertainShare)} of the sample.`);
    const fps = sample.filter((e) => {
      const r = s.byId.get(e.p.item.id)?.outcome;
      return e.p.item.label === "ham" && r?.status === "scanned" && aiDecision(r.verdict).flagged;
    });
    for (const e of fps.slice(0, 10)) {
      const r = s.byId.get(e.p.item.id)!.outcome as Extract<ClassifierOutcome, { status: "scanned" }>;
      console.log(`- AI false positive ${e.p.item.id}: spam ${r.verdict.spam}, phishing ${r.verdict.phishing}, ${r.verdict.category}`);
    }
  }
  if (values.json) {
    writeFileSync(values.json, JSON.stringify(summaries.map(({ byId, ...s }) => s), null, 2));
  }
}

if (import.meta.main) await main();
