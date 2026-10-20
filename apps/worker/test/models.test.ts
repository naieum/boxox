import { describe, expect, it, vi } from "vitest";
import {
  isAllowedModel,
  estimateCost,
  MODELS,
  memoryBudgetStore,
  MODEL_IDS,
  ModelNotAllowedError,
  PRESETS,
  runAi,
  utcDay,
  type AiConsent,
  type AiDeps,
} from "../src/services/ai";

/** Worker source text keyed by path under src/, bundled at build time (workerd has no disk). */
const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../src/**/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" }),
  ).map(([path, text]) => [path.slice("../src/".length), text]),
);
const AI_DIR = "services/ai/";
const sourceFiles = () => Object.keys(SOURCES);
const readSource = (f: string) => SOURCES[f] ?? "";

const ON: AiConsent = { enabled: true, provider: "openai" };
const INPUT = { messages: [{ role: "user", content: "synthetic test text, not mail" }] };
const NOW = Date.UTC(2026, 9, 17, 12);

function deps(overrides: Partial<AiDeps> = {}) {
  const run = vi.fn(async () => ({
    response: "ok",
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
  }));
  const d: AiDeps = {
    ai: { run } as unknown as AiDeps["ai"],
    consent: ON,
    budget: memoryBudgetStore(),
    dailyBudgetUsd: 1,
    now: () => NOW,
    ...overrides,
  };
  return { d, run };
}

describe("AI model allow-list", () => {
  it("rejects a model id that is not on the allow-list", async () => {
    const { d, run } = deps();
    for (const id of ["@cf/meta/llama-3.1-8b-instruct", "@cf/qwen/qwen3-30b", "openai/gpt-6", ""]) {
      expect(isAllowedModel(id)).toBe(false);
      await expect(runAi(d, { model: id, input: INPUT, feature: "test" })).rejects.toBeInstanceOf(
        ModelNotAllowedError,
      );
    }
    expect(run).not.toHaveBeenCalled();

    const ok = await runAi(d, { model: "openai/gpt-6-luna", input: INPUT, feature: "test" });
    expect(ok.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("contains exactly the approved candidates", () => {
    expect([...MODEL_IDS].sort()).toEqual(
      [
        "@cf/openai/gpt-oss-20b",
        "@cf/openai/whisper-large-v3-turbo",
        "anthropic/claude-haiku-5.5",
        "anthropic/claude-sonnet-5.5",
        "openai/gpt-5.6-luna",
        "openai/gpt-6-luna",
        "openai/text-embedding-3-small",
      ].sort(),
    );
    for (const id of MODEL_IDS) {
      expect(id).not.toMatch(/qwen|deepseek|kimi|moonshot|glm|baai|bge|clef|llama|@cf\/meta\//i);
    }
    for (const preset of Object.values(PRESETS)) {
      for (const id of Object.values(preset)) expect(isAllowedModel(id)).toBe(true);
    }
    expect(PRESETS.anthropic.embed).toBeUndefined();
  });

  it("no env.AI.run call outside the ai wrapper", () => {
    const files = sourceFiles();
    expect(files).toContain("index.ts");
    const offenders = files
      .filter((f) => !f.startsWith(AI_DIR))
      .filter((f) => /\bAI\s*\.\s*run\s*\(|\.run\s*\(\s*["'`](@cf\/|openai\/|anthropic\/)/.test(readSource(f)));
    expect(offenders).toEqual([]);
    // The wrapper itself does call it, so the scan is looking at the right thing.
    expect(readSource(`${AI_DIR}run.ts`)).toMatch(/deps\.ai\.run/);
  });

  it("names model ids only in models.ts", () => {
    const literal = /["'`](@cf\/[\w.-]+\/[\w.-]+|openai\/[\w.-]+|anthropic\/[\w.-]+)["'`]/g;
    const outside = sourceFiles()
      .filter((f) => f !== `${AI_DIR}models.ts`)
      .flatMap((f) => [...readSource(f).matchAll(literal)].map((m) => `${f}: ${m[1]}`));
    expect(outside).toEqual([]);
  });
});

describe("runAi consent and budget", () => {
  it("makes no AI call when the AI group is off", async () => {
    const off = deps({ consent: { enabled: false, provider: "openai" } });
    expect(await runAi(off.d, { model: "openai/gpt-6-luna", input: INPUT, feature: "test" })).toEqual({
      ok: false,
      reason: "ai-off",
    });
    expect(await runAi(off.d, { model: "@cf/openai/gpt-oss-20b", input: INPUT, feature: "test" })).toEqual({
      ok: false,
      reason: "ai-off",
    });
    expect(off.run).not.toHaveBeenCalled();

    const noProvider = deps({ consent: { enabled: true, provider: null } });
    expect((await runAi(noProvider.d, { model: "openai/gpt-6-luna", input: INPUT, feature: "t" })).ok).toBe(false);
    expect(noProvider.run).not.toHaveBeenCalled();
  });

  it("honours the per-address opt-out and the chosen provider", async () => {
    const { d, run } = deps({ consent: { enabled: true, provider: "openai", disabledAddresses: ["legal@example.test"] } });
    expect(
      await runAi(d, { model: "openai/gpt-6-luna", input: INPUT, feature: "t", address: "Legal@example.test" }),
    ).toEqual({ ok: false, reason: "address-opted-out" });
    expect(await runAi(d, { model: "anthropic/claude-haiku-5.5", input: INPUT, feature: "t" })).toEqual({
      ok: false,
      reason: "provider-not-consented",
    });
    expect(run).not.toHaveBeenCalled();

    // Cloudflare-hosted models never leave Cloudflare, so any AI consent covers them.
    expect((await runAi(d, { model: "@cf/openai/gpt-oss-20b", input: INPUT, feature: "t" })).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops calling AI once the daily budget is spent", async () => {
    // 1000 in + 100 out on gpt-6-luna = $0.00015 per call; cap at three calls' worth.
    const { d, run } = deps({ dailyBudgetUsd: 0.00045 });
    const req = { model: "openai/gpt-6-luna", input: INPUT, feature: "test" };
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await runAi(d, req));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false]);
    expect(results[3]).toEqual({ ok: false, reason: "budget-spent" });
    expect(run).toHaveBeenCalledTimes(3);
    expect(await d.budget.spent(utcDay(NOW))).toBeCloseTo(0.00045, 10);

    // A new UTC day starts a fresh budget.
    const tomorrow = { ...d, now: () => NOW + 24 * 3600 * 1000 };
    expect((await runAi(tomorrow, req)).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(4);

    const zero = deps({ dailyBudgetUsd: 0 });
    expect(await runAi(zero.d, req)).toEqual({ ok: false, reason: "budget-spent" });
    expect(zero.run).not.toHaveBeenCalled();
  });

  it("sends every call through AI Gateway without caching or payload logs", async () => {
    const { d, run } = deps({ gatewayId: "boxox" });
    await runAi(d, { model: "openai/gpt-6-luna", input: INPUT, feature: "spam-classify" });
    expect(run).toHaveBeenCalledWith("openai/gpt-6-luna", INPUT, {
      gateway: { id: "boxox", skipCache: true, collectLog: false, metadata: { feature: "spam-classify" } },
    });
  });
});


describe("AI usage accounting", () => {
  it.each([
    ["Chat Completions", { usage: { prompt_tokens: 1000, completion_tokens: 100 } }],
    ["OpenAI Responses", { usage: { input_tokens: 1000, output_tokens: 100 } }],
    ["Anthropic Messages", { usage: { input_tokens: 1000, output_tokens: 100 } }],
  ])("charges reported %s usage to the daily budget", async (_, output) => {
    const run = vi.fn(async () => output);
    const { d } = deps({ ai: { run } as unknown as AiDeps["ai"], dailyBudgetUsd: 0.00015 });
    const request = { model: "openai/gpt-6-luna", input: INPUT, feature: "test" };
    const result = await runAi(d, request);
    expect(result.ok && result.costUsd).toBeCloseTo(0.00015, 10);
    expect(await d.budget.spent(utcDay(NOW))).toBeCloseTo(0.00015, 10);
    expect(await runAi(d, request)).toEqual({ ok: false, reason: "budget-spent" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("uses wrapped embedding usage and accepts zero reported tokens", () => {
    expect(estimateCost(MODELS["openai/text-embedding-3-small"], INPUT, {
      state: "Completed", result: { usage: { prompt_tokens: 1000, total_tokens: 1000 } },
    })).toBeCloseTo(0.00002, 10);
    expect(estimateCost(MODELS["openai/gpt-6-luna"], INPUT, {
      usage: { input_tokens: 0, output_tokens: 0 },
    })).toBe(0);
    expect(estimateCost(MODELS["openai/gpt-6-luna"], INPUT, {})).toBeGreaterThan(0);
  });
});
