/**
 * The AI model allow-list: the only place model IDs appear (docs/v2-plan.md,
 * "AI use"). OpenAI and Anthropic models only, plus OpenAI open-weight models
 * hosted on Workers AI. No Chinese-made models or fine-tunes of them, and no
 * Meta models. Before adding an entry, check its model card for the base model.
 *
 * Prices are USD per 1M tokens and only feed the daily budget estimate; the
 * bake-off (scripts/model-eval.ts) picks the defaults.
 */

export type AiProvider = "openai" | "anthropic" | "cloudflare";

export type AiTask = "classify" | "assist" | "embed" | "transcribe";

export interface ModelSpec {
  provider: AiProvider;
  /** Whether mail content leaves Cloudflare for the provider. */
  leavesCloudflare: boolean;
  tasks: readonly AiTask[];
  inputPerM: number;
  outputPerM: number;
  /** Flat estimate for models not priced by tokens (audio). */
  perCallUsd?: number;
  dimensions?: number;
}

export const MODELS = {
  "openai/gpt-6-luna": {
    provider: "openai",
    leavesCloudflare: true,
    tasks: ["classify", "assist"],
    inputPerM: 0.1,
    outputPerM: 0.5,
  },
  "openai/gpt-5.6-luna": {
    provider: "openai",
    leavesCloudflare: true,
    tasks: ["classify"],
    inputPerM: 0.2,
    outputPerM: 1.2,
  },
  "anthropic/claude-haiku-5.5": {
    provider: "anthropic",
    leavesCloudflare: true,
    tasks: ["classify", "assist"],
    inputPerM: 0.1,
    outputPerM: 0.5,
  },
  "anthropic/claude-sonnet-5.5": {
    provider: "anthropic",
    leavesCloudflare: true,
    tasks: ["assist"],
    inputPerM: 2,
    outputPerM: 10,
  },
  "openai/text-embedding-3-small": {
    provider: "openai",
    leavesCloudflare: true,
    tasks: ["embed"],
    inputPerM: 0.02,
    outputPerM: 0,
    dimensions: 1536,
  },
  "@cf/openai/gpt-oss-20b": {
    provider: "cloudflare",
    leavesCloudflare: false,
    tasks: ["classify", "assist"],
    inputPerM: 0.2,
    outputPerM: 0.3,
  },
  "@cf/openai/whisper-large-v3-turbo": {
    provider: "cloudflare",
    leavesCloudflare: false,
    tasks: ["transcribe"],
    inputPerM: 0,
    outputPerM: 0,
    perCallUsd: 0.001,
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODELS;

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

export function isAllowedModel(id: string): id is ModelId {
  return Object.hasOwn(MODELS, id);
}

/** Chosen default classifier from the measured public-corpus bake-off (docs/model-eval.md).
 * gpt-oss-20b was the interim default before third-party evaluation.
 */
export const DEFAULT_CLASSIFY_MODEL: ModelId = "openai/gpt-6-luna";

/** The "all OpenAI" / "all Anthropic" / "Cloudflare only" presets. */
export const PRESETS: Record<AiProvider, Partial<Record<AiTask, ModelId>>> = {
  openai: {
    classify: DEFAULT_CLASSIFY_MODEL,
    assist: "openai/gpt-6-luna",
    embed: "openai/text-embedding-3-small",
    transcribe: "@cf/openai/whisper-large-v3-turbo",
  },
  // Anthropic has no embedding model: similar-mail matching and semantic search are off.
  anthropic: {
    classify: "anthropic/claude-haiku-5.5",
    assist: "anthropic/claude-haiku-5.5",
    transcribe: "@cf/openai/whisper-large-v3-turbo",
  },
  cloudflare: {
    classify: "@cf/openai/gpt-oss-20b",
    assist: "@cf/openai/gpt-oss-20b",
    transcribe: "@cf/openai/whisper-large-v3-turbo",
  },
};

export function modelFor(provider: AiProvider, task: AiTask): ModelId | null {
  return PRESETS[provider][task] ?? null;
}
