import { eq } from "drizzle-orm";
import { aiSettings } from "@boxox/db";
import { createDb, type Db } from "../../db";
import type { Env } from "../../env";
import { loadAssistConfig } from "../assist";
import { isFree } from "../capabilities";
import { kvBudgetStore } from "./budget";

/** One persisted consent/budget configuration for request and workflow AI entrypoints. */
export async function mailAiDeps(env: Env, db: Db = createDb(env)) {
  const config = await loadAssistConfig(db);
  if (isFree(env)) config.consent = { ...config.consent, enabled: false };
  const settings = await db.query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) });
  return {
    db,
    ai: env.AI,
    budget: kvBudgetStore(env.KV),
    consent: config.consent,
    dailyBudgetUsd: config.dailyBudgetUsd,
    config,
    model: settings?.models?.embed ?? null,
    vectors: env.VECTORS,
    bucket: env.MAIL_STORE,
  };
}
