import { utcDay, type BudgetStore } from "./budget";
import { isAllowedModel, MODELS, type AiProvider, type ModelId, type ModelSpec } from "./models";

/**
 * The single entry point for AI. Every env.AI.run call in the app lives here,
 * and each one is checked against the allow-list, the owner's consent
 * switches, and the daily budget before it goes out through AI Gateway.
 */

export interface AiConsent {
  /** The "AI (reads your incoming emails)" group. Off until the owner turns it on. */
  enabled: boolean;
  /** The provider the owner chose on the consent screen. */
  provider: AiProvider | null;
  /** Per-address opt-out, e.g. legal@. Lowercased addresses. */
  disabledAddresses?: readonly string[];
}

export interface AiDeps {
  ai: Pick<Ai, "run">;
  consent: AiConsent;
  budget: BudgetStore;
  /** Daily cap in USD; 0 means no AI spend at all. */
  dailyBudgetUsd: number;
  gatewayId?: string;
  now?: () => number;
}

export interface AiRequest {
  model: string;
  input: Record<string, unknown>;
  /** Short tag for gateway metadata and logs, e.g. "spam-classify". */
  feature: string;
  /** The mailbox address the content belongs to, for the per-address opt-out. */
  address?: string;
}

export type AiRefusal = "ai-off" | "address-opted-out" | "provider-not-consented" | "budget-spent";

export type AiResult =
  | { ok: true; model: ModelId; output: unknown; costUsd: number }
  | { ok: false; reason: AiRefusal };

export class ModelNotAllowedError extends Error {
  constructor(readonly model: string) {
    super(`AI model "${model}" is not on the allow-list (services/ai/models.ts)`);
    this.name = "ModelNotAllowedError";
  }
}

export const DEFAULT_GATEWAY_ID = "default";

export function gatewayOptions(gatewayId: string, feature: string): AiOptions {
  // Responses are never cached: a cache entry would hold mail content.
  return { gateway: { id: gatewayId, skipCache: true, collectLog: false, metadata: { feature } } };
}

export function refusalFor(consent: AiConsent, spec: ModelSpec, address?: string): AiRefusal | null {
  if (!consent.enabled || !consent.provider) return "ai-off";
  if (address && consent.disabledAddresses?.includes(address.toLowerCase())) return "address-opted-out";
  // Cloudflare-hosted models keep mail inside Cloudflare, so any AI consent covers them.
  if (spec.leavesCloudflare && spec.provider !== consent.provider) return "provider-not-consented";
  return null;
}

/** Rough token count when a model reports no usage: ~4 characters per token. */
function estimateTokens(value: unknown): number {
  if (value == null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil((text?.length ?? 0) / 4);
}

export function estimateCost(spec: ModelSpec, input: unknown, output: unknown): number {
  if (spec.perCallUsd !== undefined) return spec.perCallUsd;
  type Usage = { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
  // Responses and Anthropic use input/output_tokens; embeddings may be wrapped
  // by Unified Billing in { state, result: { usage } }.
  const body = output as { usage?: Usage; result?: { usage?: Usage } } | null;
  const usage = body?.usage ?? body?.result?.usage;
  const inTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? estimateTokens(input);
  const outTokens = usage?.output_tokens ?? usage?.completion_tokens ?? (spec.outputPerM > 0 ? estimateTokens(output) : 0);
  return (inTokens * spec.inputPerM + outTokens * spec.outputPerM) / 1_000_000;
}

export async function runAi(deps: AiDeps, req: AiRequest): Promise<AiResult> {
  if (!isAllowedModel(req.model)) throw new ModelNotAllowedError(req.model);
  const spec: ModelSpec = MODELS[req.model];

  const refusal = refusalFor(deps.consent, spec, req.address);
  if (refusal) return { ok: false, reason: refusal };

  const day = utcDay(deps.now?.() ?? Date.now());
  if ((await deps.budget.spent(day)) >= deps.dailyBudgetUsd) return { ok: false, reason: "budget-spent" };

  const output: unknown = await (deps.ai.run as (m: string, i: unknown, o: AiOptions) => Promise<unknown>)(
    req.model,
    req.input,
    gatewayOptions(deps.gatewayId ?? DEFAULT_GATEWAY_ID, req.feature),
  );
  const costUsd = estimateCost(spec, req.input, output);
  await deps.budget.add(day, costUsd);
  return { ok: true, model: req.model, output, costUsd };
}
