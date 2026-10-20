import { and, desc, eq } from "drizzle-orm";
import { spamFingerprints } from "@boxox/db";
import type { Db } from "../../db";
import type { Signal } from "./signals";

/**
 * Campaign fingerprints: a 64-bit simhash of the body's word shingles. Spam
 * campaigns vary names, numbers and links per recipient; those are folded out
 * before hashing, so copies of one campaign land a few bits apart while
 * unrelated mail differs in about half the bits.
 */

export const FINGERPRINT_ALGORITHM = "simhash" as const;
/** Hamming distance at or under which two bodies count as one campaign. */
export const NEAR_DUPLICATE_BITS = 10;
/** Bodies shorter than this many shingles carry too little to fingerprint. */
const MIN_SHINGLES = 8;
const SHINGLE = 3;
const MAX_CHARS = 50_000;
/** Most recent spam fingerprints compared per message. */
const COMPARE_LIMIT = 5000;

/** Lowercased words with URLs, addresses and numbers replaced by placeholders. */
export function normalizeForFingerprint(text: string): string[] {
  return text
    .slice(0, MAX_CHARS)
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+|www\.\S+/g, " url ")
    .replace(/\S+@\S+\.\S+/g, " email ")
    .replace(/\d+([.,:/-]\d+)*/g, " num ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 16 hex chars, or null when the text is too short to say anything. */
export function simhash(text: string): string | null {
  const words = normalizeForFingerprint(text);
  const shingles = words.length < SHINGLE ? [] : words.slice(0, words.length - SHINGLE + 1).map((_, i) => words.slice(i, i + SHINGLE).join(" "));
  const unique = [...new Set(shingles)];
  if (unique.length < MIN_SHINGLES) return null;
  const v = new Int32Array(64);
  for (const sh of unique) {
    const hi = fnv1a(sh, 0x9e3779b9);
    const lo = fnv1a(sh, 0x7f4a7c15);
    for (let b = 0; b < 32; b++) {
      v[b]! += (hi >>> b) & 1 ? 1 : -1;
      v[32 + b]! += (lo >>> b) & 1 ? 1 : -1;
    }
  }
  let hi = 0, lo = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b]! > 0) hi |= 1 << b;
    if (v[32 + b]! > 0) lo |= 1 << b;
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64;
  const x = Number.parseInt(a.slice(0, 8), 16) ^ Number.parseInt(b.slice(0, 8), 16);
  const y = Number.parseInt(a.slice(8), 16) ^ Number.parseInt(b.slice(8), 16);
  return popcount(x) + popcount(y);
}

/** Text the fingerprint is taken from: the text part, else the HTML stripped. */
export function fingerprintText(mail: { text: string | null; html: string | null }): string {
  return mail.text?.trim() ? mail.text : (mail.html ?? "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
}

export interface FingerprintMatch {
  hash: string;
  distance: number;
  messageId: string | null;
}

/** The closest fingerprint of mail the owner marked spam, if within NEAR_DUPLICATE_BITS. */
export async function findSpamFingerprint(db: Db, hash: string): Promise<FingerprintMatch | null> {
  const rows = await db
    .select({ hash: spamFingerprints.hash, messageId: spamFingerprints.messageId })
    .from(spamFingerprints)
    .where(eq(spamFingerprints.algorithm, FINGERPRINT_ALGORITHM))
    .orderBy(desc(spamFingerprints.createdAt))
    .limit(COMPARE_LIMIT);
  let best: FingerprintMatch | null = null;
  for (const r of rows) {
    const distance = hammingDistance(hash, r.hash);
    if (distance <= NEAR_DUPLICATE_BITS && (!best || distance < best.distance)) best = { hash: r.hash, distance, messageId: r.messageId };
    if (best?.distance === 0) break;
  }
  return best;
}

export function fingerprintSignal(match: FingerprintMatch | null): Signal[] {
  if (!match) return [];
  return [{ id: "spam_fingerprint", weight: match.distance <= 3 ? 6 : 4, detail: `${match.distance} bits` }];
}

/** Called when the owner marks a message spam. Idempotent per message and hash. */
export async function recordSpamFingerprint(db: Db, messageId: string | null, mail: { text: string | null; html: string | null }): Promise<string | null> {
  const hash = simhash(fingerprintText(mail));
  if (!hash) return null;
  if (messageId) {
    const existing = await db
      .select({ id: spamFingerprints.id })
      .from(spamFingerprints)
      .where(and(eq(spamFingerprints.messageId, messageId), eq(spamFingerprints.hash, hash)))
      .limit(1);
    if (existing.length) return hash;
  }
  await db.insert(spamFingerprints).values({ id: crypto.randomUUID(), algorithm: FINGERPRINT_ALGORITHM, hash, messageId });
  return hash;
}

/** Forget a message's fingerprints when the owner says it wasn't spam after all. */
export async function forgetSpamFingerprint(db: Db, messageId: string): Promise<void> {
  await db.delete(spamFingerprints).where(eq(spamFingerprints.messageId, messageId));
}
