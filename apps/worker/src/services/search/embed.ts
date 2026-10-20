import { isAllowedModel, MODELS, modelFor, runAi, type AiDeps, type AiRefusal, type ModelId, type ModelSpec } from "../ai";

/** ~2k tokens per document at ~4 characters per token keeps indexing cheap. */
export const EMBED_CHAR_LIMIT = 8000;

/**
 * The embedding model for the owner's consent: an explicit override when it is
 * an allow-listed embed model, otherwise the provider's preset. Anthropic and
 * Cloudflare presets have none, so semantic search is off for them.
 */
export function embedModel(deps: Pick<AiDeps, "consent">, override?: string | null): ModelId | null {
  if (override && isAllowedModel(override) && (MODELS[override] as ModelSpec).tasks.includes("embed")) return override;
  return deps.consent.provider ? modelFor(deps.consent.provider, "embed") : null;
}

/**
 * Third-party embeddings arrive wrapped as { state, result: <OpenAI body> }
 * (docs/spikes/ai-thirdparty.md); Workers AI models answer { data: number[][] }.
 */
export function vectorsFrom(output: unknown, count: number, dimensions?: number): number[][] | null {
  let body = output as Record<string, unknown> | null;
  if (body && typeof body === "object" && "result" in body && body.result && typeof body.result === "object") {
    body = body.result as Record<string, unknown>;
  }
  const data = body && typeof body === "object" ? body.data : null;
  if (!Array.isArray(data) || data.length !== count) return null;
  const vectors = data.map((d) => (Array.isArray(d) ? d : (d as { embedding?: unknown } | null)?.embedding));
  const valid = vectors.every(
    (v): v is number[] =>
      Array.isArray(v) && v.length > 0 && (!dimensions || v.length === dimensions) && v.every((x) => typeof x === "number" && Number.isFinite(x)),
  );
  return valid ? (vectors as number[][]) : null;
}

export type EmbedResult = { ok: true; vectors: number[][] } | { ok: false; reason: AiRefusal | "no-model" | "bad-output" | "error" };

export async function embedTexts(
  deps: AiDeps & { model?: string | null },
  texts: string[],
  opts: { feature: string; address?: string },
): Promise<EmbedResult> {
  const model = embedModel(deps, deps.model);
  if (!model) return { ok: false, reason: "no-model" };
  let result;
  try {
    result = await runAi(deps, {
      model,
      input: { input: texts.map((t) => t.slice(0, EMBED_CHAR_LIMIT)) },
      feature: opts.feature,
      address: opts.address,
    });
  } catch {
    return { ok: false, reason: "error" };
  }
  if (!result.ok) return result;
  const vectors = vectorsFrom(result.output, texts.length, (MODELS[model] as ModelSpec).dimensions);
  return vectors ? { ok: true, vectors } : { ok: false, reason: "bad-output" };
}
