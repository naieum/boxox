import { eq } from "drizzle-orm";
import { z } from "zod";
import { aiSettings } from "@boxox/db";
import type { Db } from "../db";
import type { Env } from "../env";
import { isFree } from "./capabilities";
import { DEFAULT_GATEWAY_ID } from "./ai";
import { MODELS, PRESETS, type AiProvider, type AiTask, type ModelId } from "./ai/models";
import { cloudflareClient, CloudflareApiError, TokenNotConfiguredError } from "./cloudflare";

export const PROCESSING_GROUPS = ["localFilters", "reputationLookups", "ai"] as const;
export type ProcessingGroup = (typeof PROCESSING_GROUPS)[number];

/** Typical mail for the cost estimate: ~2k tokens in, ~100 out (plan, "AI use"). */
const EST_TOKENS_IN = 2_000;
const EST_TOKENS_OUT = 100;
const EST_EMAILS_PER_DAY = 100;

export const PROVIDERS: Record<
  AiProvider,
  { company: string; label: string; leavesCloudflare: boolean; termsUrl: string; dataNote: string }
> = {
  openai: {
    company: "OpenAI",
    label: "OpenAI",
    leavesCloudflare: true,
    termsUrl: "https://openai.com/policies/business-terms/",
    dataNote:
      "Email content leaves Cloudflare and is sent to OpenAI (a US company) under its business terms: no training on API data.",
  },
  anthropic: {
    company: "Anthropic",
    label: "Anthropic",
    leavesCloudflare: true,
    termsUrl: "https://www.anthropic.com/legal/commercial-terms",
    dataNote:
      "Email content leaves Cloudflare and is sent to Anthropic (a US company) under its commercial terms: no training on API data. Anthropic has no embedding model, so similar-mail matching and semantic search stay off.",
  },
  cloudflare: {
    company: "Cloudflare",
    label: "Cloudflare only",
    leavesCloudflare: false,
    termsUrl: "https://developers.cloudflare.com/workers-ai/platform/privacy/",
    dataNote:
      "Email content stays inside Cloudflare (Workers AI, OpenAI's open-weight model). Cloudflare says Workers AI doesn't retain inputs or train on customer content. Processing may happen outside the US.",
  },
};

const TASK_LABELS: Record<AiTask, string> = {
  classify: "Spam, phishing, priority and category",
  assist: "Summaries and smart replies",
  embed: "Similar-mail matching and semantic search",
  transcribe: "Voicemail transcription",
};

export function estimateMonthlyUsd(provider: AiProvider, emailsPerDay = EST_EMAILS_PER_DAY): number {
  const perEmail = (["classify", "embed"] as const).reduce((sum, task) => {
    const id = PRESETS[provider][task];
    if (!id) return sum;
    const m = MODELS[id];
    return sum + (EST_TOKENS_IN * m.inputPerM + EST_TOKENS_OUT * m.outputPerM) / 1_000_000;
  }, 0);
  return Math.round(perEmail * emailsPerDay * 30 * 100) / 100;
}

/** Everything the consent screen shows. Nothing here is a default choice. */
export function consentScreen() {
  return {
    title: "How your mail is processed",
    groups: [
      {
        id: "localFilters" as const,
        title: "Local filters",
        summary: "No AI, and nothing leaves your Cloudflare account.",
        includes: [
          "Sender authentication checks (SPF, DKIM, DMARC, ARC)",
          "Header and structure rules",
          "Your blocklist",
          "A Bayes filter trained on your spam / not-spam clicks",
          "Campaign fingerprints of mail you marked as spam",
        ],
      },
      {
        id: "reputationLookups" as const,
        title: "Reputation lookups",
        summary:
          "Link domains from your mail are sent to outside services: Cloudflare's 1.1.1.2 resolver, and Spamhaus (with sending IPs) if you add a key. The OpenPhish feed is only downloaded; nothing is sent to it.",
        includes: ["Cloudflare 1.1.1.2 (malware-blocking DNS)", "Spamhaus ZEN/DBL, only with your own DQS key", "OpenPhish feed (download only)"],
      },
      {
        id: "ai" as const,
        title: "AI (reads your incoming emails)",
        summary:
          "An AI model will read the content of your incoming emails. Requests go through your Cloudflare account's AI Gateway, with gateway logging of message bodies off and a zero-data-retention routing preference. Provider retention depends on the model; this setting is not a provider guarantee.",
        includes: [
          "Spam and phishing classification",
          "Embeddings for similar-mail matching and semantic search",
          "Attachment text extraction",
          "Summaries and smart replies",
        ],
      },
    ],
    providers: (Object.keys(PROVIDERS) as AiProvider[]).map((id) => ({
      id,
      ...PROVIDERS[id],
      models: (Object.entries(PRESETS[id]) as [AiTask, ModelId][])
        .filter(([, model]) => MODELS[model].provider === id || id === "cloudflare")
        .map(([task, model]) => ({ task, use: TASK_LABELS[task], model })),
      estimatedMonthlyUsd: estimateMonthlyUsd(id),
      needsCredits: id !== "cloudflare",
    })),
    privacy: {
      zeroDataRetention: true,
      bodyLogging: false,
      via: "Your Cloudflare account's AI Gateway",
    },
    estimateBasis: `${EST_EMAILS_PER_DAY} emails a day, about ${EST_TOKENS_IN} tokens in and ${EST_TOKENS_OUT} out each`,
  };
}

export const processingSchema = z
  .object({
    localFilters: z.boolean(),
    reputationLookups: z.boolean(),
    ai: z.boolean(),
    provider: z.enum(["openai", "anthropic", "cloudflare"]).nullable().optional(),
  })
  .strict()
  .refine((v) => !v.ai || !!v.provider, { message: "Pick a provider to turn AI on", path: ["provider"] });

export type ProcessingState = Record<ProcessingGroup, boolean | null> & { provider: AiProvider | null };

export function bad(message: string, code = "bad_request") {
  return { error: { code, message } };
}

export async function processingState(db: Db): Promise<ProcessingState> {
  const row = await db.query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) });
  return {
    localFilters: row?.localFilters ?? null,
    reputationLookups: row?.reputationLookups ?? null,
    ai: row?.ai ?? null,
    provider: row?.ai ? (row.provider ?? null) : null,
  };
}

/** Groups the owner hasn't explicitly switched on or off. Null never means on. */
export function missingChoices(state: ProcessingState): ProcessingGroup[] {
  return PROCESSING_GROUPS.filter((g) => state[g] === null);
}

export class ProcessingUpdateError extends Error {
  constructor(readonly status: 400 | 409, readonly code: string, message: string) { super(message); }
}

export function cfError(err: unknown) {
  if (err instanceof ProcessingUpdateError) return { status: err.status, body: bad(err.message, err.code) };
  if (err instanceof TokenNotConfiguredError) {
    return { status: 412 as const, body: bad(err.message, "token_not_configured") };
  }
  if (err instanceof CloudflareApiError) {
    const status = err.status === 403 || err.status === 401 ? 403 : err.status === 404 ? 404 : 502;
    return {
      status: status as 403 | 404 | 502,
      body: bad(
        status === 403
          ? err.requiredPermission
            ? `Cloudflare denied Email Routing settings access. Connect with Cloudflare again and approve ${err.requiredPermission}. If that permission is absent, update the installation’s OAuth client first. API tokens need Zone Settings Edit for this zone.`
            : "The Cloudflare connection lacks a permission this step needs. Reconnect with Cloudflare, or check your API token permissions against the setup guide."
          : err.message,
        status === 403 ? "token_forbidden" : "cloudflare_error",
      ),
    };
  }
  throw err;
}

export const processingUpdateSchema = z.object({
  localFilters: z.boolean().optional(),
  reputationLookups: z.boolean().optional(),
  ai: z.boolean().optional(),
  provider: z.enum(["openai", "anthropic", "cloudflare"]).nullable().optional(),
  ownerRules: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  dailyBudgetMicros: z.number().int().min(0).max(1_000_000_000).optional(),
  onlyWhenUncertain: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "Choose a setting to change");

export type ProcessingUpdate = z.infer<typeof processingUpdateSchema>;

/** Shared consent transition for the setup wizard and the post-setup owner controls. */
export async function updateProcessing(db: Db, env: Env, patch: ProcessingUpdate, fetcher: typeof fetch = fetch): Promise<string[]> {
  if (isFree(env) && (patch.ai === true || (patch.provider && patch.ai !== false))) {
    throw new ProcessingUpdateError(409, "feature_unavailable", "AI is not installed in the Free inbox profile. Upgrade Workers and rerun the installer to enable it.");
  }
  const current = await db.query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) });
  const ai = patch.ai ?? current?.ai ?? null;
  const provider = ai ? (patch.provider === undefined ? current?.provider : patch.provider) ?? null : null;
  if (ai && !provider) throw new ProcessingUpdateError(400, "processing_choice_required", "Choose a provider before turning AI on.");
  const dailyBudgetMicros = patch.dailyBudgetMicros ?? current?.dailyBudgetMicros ?? 1_000_000;
  const newlyEnabled = !!ai && (current?.ai !== true || current.provider !== provider);
  const budgetRequested = patch.dailyBudgetMicros !== undefined;
  const warnings: string[] = [];
  if (ai && provider && (newlyEnabled || budgetRequested)) {
    if (newlyEnabled || (env.CF_API_TOKEN && env.CF_ACCOUNT_ID)) {
      const client = cloudflareClient(env, fetcher);
      if (newlyEnabled && provider !== "cloudflare") {
        const { balance } = await client.getCreditBalance();
        if (!(balance > 0)) throw new ProcessingUpdateError(409, "no_ai_credits", `${PROVIDERS[provider].company} models need AI Gateway credits. Buy credits in the Cloudflare dashboard, or choose Cloudflare only.`);
      }
      await client.applyGatewaySettings(DEFAULT_GATEWAY_ID, { dailySpendLimitUsd: dailyBudgetMicros / 1_000_000 });
    } else {
      warnings.push("The app uses your new daily budget. The AI Gateway backstop is unchanged because the setup token was removed; its existing limit may stop AI sooner or allow a higher backstop. Restore the token to sync that limit.");
    }
  }
  const now = new Date();
  const values = {
    localFilters: patch.localFilters ?? current?.localFilters ?? null,
    reputationLookups: patch.reputationLookups ?? current?.reputationLookups ?? null,
    ai, provider,
    models: provider ? (newlyEnabled ? Object.fromEntries(Object.entries(PRESETS[provider]).filter(([, id]) => !!id)) : current?.models ?? {}) : {},
    ownerRules: patch.ownerRules ?? current?.ownerRules ?? [], dailyBudgetMicros,
    onlyWhenUncertain: patch.onlyWhenUncertain ?? current?.onlyWhenUncertain ?? true,
    updatedAt: now,
  };
  const stamps = {
    ...(current?.localFilters !== values.localFilters && { localFiltersChangedAt: now }),
    ...(current?.reputationLookups !== values.reputationLookups && { reputationLookupsChangedAt: now }),
    ...((current?.ai !== ai || newlyEnabled) && { aiChangedAt: now }),
  };
  await db.insert(aiSettings).values({ id: 1, ...values, ...stamps })
    .onConflictDoUpdate({ target: aiSettings.id, set: { ...values, ...stamps } });
  return warnings;
}
