import { eq } from "drizzle-orm";
import { aiSettings } from "@boxox/db";
import { createDb } from "../db";
import type { Env } from "../env";
import { log } from "../log";
import { normalizePhishUrl, OPENPHISH_KV_KEY, type Fetcher, type OpenPhishFeed } from "../services/spam/signals-lookup";

export const OPENPHISH_CRON = "0 */6 * * *";
/** OpenPhish's free community feed: one phishing URL per line. */
export const OPENPHISH_FEED_URL = "https://openphish.com/feed.txt";
const MAX_ENTRIES = 100_000;
const MAX_BYTES = 10 * 1024 * 1024;

/** Feed text → distinct normalized "host/path" entries. */
export function parseOpenPhishFeed(body: string): string[] {
  const entries = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    if (entries.size >= MAX_ENTRIES) break;
    const norm = line.trim() ? normalizePhishUrl(line) : null;
    if (norm) entries.add(norm);
  }
  return [...entries];
}

export type OpenPhishOutcome = "updated" | "skipped" | "failed";

/**
 * Every 6 h: download the feed into KV. Only a download; nothing about the
 * owner's mail is sent. Runs only with "reputation lookups" on. A failed or
 * empty download keeps the previous feed rather than wiping it.
 */
export async function refreshOpenPhish(env: Pick<Env, "DB" | "KV">, fetcher: Fetcher = fetch): Promise<OpenPhishOutcome> {
  const settings = await createDb(env).query.aiSettings.findFirst({ where: eq(aiSettings.id, 1) });
  if (settings?.reputationLookups !== true) return "skipped";
  try {
    const res = await fetcher(OPENPHISH_FEED_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error("feed too large");
    const entries = parseOpenPhishFeed(body);
    if (!entries.length) throw new Error("empty feed");
    const feed: OpenPhishFeed = { updatedAt: new Date().toISOString(), entries };
    await env.KV.put(OPENPHISH_KV_KEY, JSON.stringify(feed));
    log.info("openphish_refreshed", { entries: entries.length });
    return "updated";
  } catch (err) {
    log.warn("openphish_refresh_failed", { error: err });
    return "failed";
  }
}
