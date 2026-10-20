import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { spamTokens, spamTraining } from "@boxox/db";
import { batch, type Db } from "../../db";

/**
 * Naive Bayes over word tokens, trained online from the owner's spam and
 * not-spam actions. Each message counts a token once. spam_training records
 * what each message was trained as, so relabelling or unlearning removes
 * exactly the counts that were added. Token probabilities use Robinson's
 * smoothing, and the most decisive tokens are combined as log-odds.
 */

export type BayesLabel = "spam" | "ham";

export interface BayesMail {
  subject: string | null;
  fromEmail: string | null;
  text: string | null;
  html: string | null;
}

export interface BayesScore {
  /** Sum of log(f / (1 - f)) over the decisive tokens; 0 when untrained. */
  logOdds: number;
  probability: number;
  /** Messages trained as each class. */
  spamMessages: number;
  hamMessages: number;
  tokens: { token: string; f: number }[];
}

/** Holds the per-class message totals; the leading space keeps it out of tokenize()'s range. */
export const MESSAGE_COUNT_TOKEN = " messages";
const MAX_CHARS = 50_000;
const MAX_TOKENS = 1000;
const DECISIVE = 20;
/** Robinson's s (strength of the prior) and x (prior for an unseen token). */
const S = 1;
const X = 0.5;
const MIN_DEVIATION = 0.1;
/** D1 allows 100 bound parameters per statement. */
const CHUNK = 90;

function domainOf(email: string | null): string | null {
  const at = email?.lastIndexOf("@") ?? -1;
  return at < 0 ? null : email!.slice(at + 1).toLowerCase() || null;
}

function words(text: string, prefix: string, out: Set<string>) {
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}$€£'!-]+/u)) {
    const t = w.replace(/^['!-]+|['-]+$/g, "");
    if (t.length < 3 || t.length > 24 || /^\d+$/.test(t)) continue;
    out.add(prefix + t);
    if (out.size >= MAX_TOKENS) return;
  }
}

/** Distinct tokens of a message: subject words, body words, sender and link domains. */
export function tokenize(mail: BayesMail): string[] {
  const out = new Set<string>();
  const from = domainOf(mail.fromEmail);
  if (from) out.add(`from:${from}`);
  words(mail.subject ?? "", "subject:", out);
  const raw = (mail.text?.trim() ? mail.text : (mail.html ?? "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")).slice(0, MAX_CHARS);
  for (const m of raw.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    if (out.size >= MAX_TOKENS) break;
    out.add(`url:${m[1]!.toLowerCase().replace(/^www\./, "")}`);
  }
  words(raw.replace(/<[^>]*>/g, " ").replace(/https?:\/\/\S+/gi, " "), "", out);
  return [...out].slice(0, MAX_TOKENS);
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function addStatements(db: Db, tokens: string[], label: BayesLabel): BatchItem<"sqlite">[] {
  const spam = label === "spam" ? 1 : 0;
  return chunks([MESSAGE_COUNT_TOKEN, ...tokens], 30).map((part) =>
    db
      .insert(spamTokens)
      .values(part.map((token) => ({ token, spamCount: spam, hamCount: 1 - spam })))
      .onConflictDoUpdate({
        target: spamTokens.token,
        set: {
          spamCount: sql`${spamTokens.spamCount} + excluded.spam_count`,
          hamCount: sql`${spamTokens.hamCount} + excluded.ham_count`,
          updatedAt: sql`cast(unixepoch('subsec') * 1000 as integer)`,
        },
      }),
  );
}

function removeStatements(db: Db, tokens: string[], label: BayesLabel): BatchItem<"sqlite">[] {
  const column = label === "spam" ? spamTokens.spamCount : spamTokens.hamCount;
  const set = label === "spam" ? { spamCount: sql`max(0, ${column} - 1)` } : { hamCount: sql`max(0, ${column} - 1)` };
  return chunks([MESSAGE_COUNT_TOKEN, ...tokens]).flatMap((part) => [
    db
      .update(spamTokens)
      .set({ ...set, updatedAt: sql`cast(unixepoch('subsec') * 1000 as integer)` })
      .where(inArray(spamTokens.token, part)),
    db.delete(spamTokens).where(and(inArray(spamTokens.token, part), eq(spamTokens.spamCount, 0), eq(spamTokens.hamCount, 0))),
  ]);
}

async function trainedAs(db: Db, messageId: string): Promise<BayesLabel | null> {
  const [row] = await db.select({ label: spamTraining.label }).from(spamTraining).where(eq(spamTraining.messageId, messageId)).limit(1);
  return row?.label ?? null;
}

/**
 * The owner marked a message spam or not spam. Training the same label twice
 * is a no-op; a different label first unlearns the old one. Returns what changed.
 */
export async function learn(db: Db, messageId: string, label: BayesLabel, mail: BayesMail): Promise<"learned" | "relabelled" | "unchanged"> {
  const previous = await trainedAs(db, messageId);
  if (previous === label) return "unchanged";
  const tokens = tokenize(mail);
  await batch(db, [
    ...(previous ? removeStatements(db, tokens, previous) : []),
    ...addStatements(db, tokens, label),
    db
      .insert(spamTraining)
      .values({ messageId, label })
      .onConflictDoUpdate({ target: spamTraining.messageId, set: { label, trainedAt: sql`cast(unixepoch('subsec') * 1000 as integer)` } }),
  ]);
  return previous ? "relabelled" : "learned";
}

/** Remove a message's training entirely, e.g. the owner undid the action. */
export async function unlearn(db: Db, messageId: string, mail: BayesMail): Promise<boolean> {
  const previous = await trainedAs(db, messageId);
  if (!previous) return false;
  await batch(db, [...removeStatements(db, tokenize(mail), previous), db.delete(spamTraining).where(eq(spamTraining.messageId, messageId))]);
  return true;
}

/** Robinson's f(w): the smoothed probability that a message containing the token is spam. */
export function tokenSpamProbability(spamCount: number, hamCount: number, spamMessages: number, hamMessages: number): number {
  const n = spamCount + hamCount;
  if (n === 0 || spamMessages === 0 || hamMessages === 0) return X;
  const bad = Math.min(1, spamCount / spamMessages);
  const good = Math.min(1, hamCount / hamMessages);
  const p = bad / (bad + good);
  return (S * X + n * p) / (S + n);
}

export async function score(db: Db, mail: BayesMail): Promise<BayesScore> {
  const tokens = tokenize(mail);
  const counts = new Map<string, { spam: number; ham: number }>();
  for (const part of chunks([MESSAGE_COUNT_TOKEN, ...tokens])) {
    const rows = await db
      .select({ token: spamTokens.token, spam: spamTokens.spamCount, ham: spamTokens.hamCount })
      .from(spamTokens)
      .where(inArray(spamTokens.token, part));
    for (const r of rows) counts.set(r.token, r);
  }
  const totals = counts.get(MESSAGE_COUNT_TOKEN);
  const spamMessages = totals?.spam ?? 0;
  const hamMessages = totals?.ham ?? 0;
  if (!spamMessages || !hamMessages) return { logOdds: 0, probability: 0.5, spamMessages, hamMessages, tokens: [] };
  const decisive = tokens
    .flatMap((token) => {
      const c = counts.get(token);
      if (!c) return [];
      const f = Math.min(0.99, Math.max(0.01, tokenSpamProbability(c.spam, c.ham, spamMessages, hamMessages)));
      return Math.abs(f - X) >= MIN_DEVIATION ? [{ token, f }] : [];
    })
    .sort((a, b) => Math.abs(b.f - X) - Math.abs(a.f - X) || a.token.localeCompare(b.token))
    .slice(0, DECISIVE);
  const logOdds = decisive.reduce((sum, t) => sum + Math.log(t.f / (1 - t.f)), 0);
  return { logOdds, probability: 1 / (1 + Math.exp(-logOdds)), spamMessages, hamMessages, tokens: decisive };
}
