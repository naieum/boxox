import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { bool, json, stamp, ts } from "./columns";

/**
 * "How your mail is processed" — one row (id = 1). Each group is null until
 * the owner makes an explicit choice; null never means on. Setup can't finish
 * while any group is null.
 */
export const aiSettings = sqliteTable(
  "ai_settings",
  {
    id: integer("id").primaryKey(),
    localFilters: bool("local_filters"),
    localFiltersChangedAt: ts("local_filters_changed_at"),
    reputationLookups: bool("reputation_lookups"),
    reputationLookupsChangedAt: ts("reputation_lookups_changed_at"),
    ai: bool("ai"),
    aiChangedAt: ts("ai_changed_at"),
    provider: text("provider", { enum: ["openai", "anthropic", "cloudflare"] }),
    /** Task → model id; every id must be on the allow-list in services/ai/models.ts. */
    models: json<Record<string, string>>("models").notNull().default({}),
    /** Run the AI classifier only when layers 1–2 are inconclusive. */
    onlyWhenUncertain: bool("only_when_uncertain").notNull().default(true),
    /** Daily AI budget cap in micro-dollars; past it, ingest falls back to the non-AI checks. */
    dailyBudgetMicros: integer("daily_budget_micros").notNull().default(1_000_000),
    /** Plain-English spam rules; each becomes a boolean field in the classifier schema. */
    ownerRules: json<string[]>("owner_rules").notNull().default([]),
    updatedAt: stamp("updated_at"),
  },
  (t) => [check("ai_settings_singleton_check", sql`${t.id} = 1`)],
);

/** AI spend per UTC day, against the daily budget cap. */
export const aiUsage = sqliteTable("ai_usage", {
  day: text("day").primaryKey(),
  calls: integer("calls").notNull().default(0),
  costMicros: integer("cost_micros").notNull().default(0),
  updatedAt: stamp("updated_at"),
});

/** Install-wide switches, one row (id = 1). */
export const appSettings = sqliteTable(
  "app_settings",
  {
    id: integer("id").primaryKey(),
    setupCompletedAt: ts("setup_completed_at"),
    /** Kill switch for every agent at once. */
    agentsDisabled: bool("agents_disabled").notNull().default(false),
    /** Send circuit breaker: set when the bounce or complaint rate crosses the threshold. */
    sendingPausedAt: ts("sending_paused_at"),
    sendingPausedReason: text("sending_paused_reason"),
    updatedAt: stamp("updated_at"),
  },
  (t) => [check("app_settings_singleton_check", sql`${t.id} = 1`)],
);
