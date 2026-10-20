import { and, asc, eq, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  agentRateHits,
  attachments,
  auditEvents,
  messages,
  operationalEvents,
  threads,
} from "@boxox/db";
import { batch, createDb } from "../db";
import type { Env } from "../env";
import { attachmentKey } from "./attachments/store";
import { attachmentTextKey } from "./attachments/text";
import { vectorId } from "./search/indexer";

/**
 * A fixed-window counter row is dead once its window has closed. Both limiters
 * use a 15-minute window; this keeps a wide margin so an in-flight window is
 * never deleted out from under a request.
 */
const RATE_HIT_STALE_MS = 24 * 3600 * 1000;

/** Threads idling in trash longer than this are permanently purged. */
export const RETENTION_TRASH_DAYS = 30;

/**
 * Age caps for the append-only operational tables. Nothing else deletes from
 * these, so without a sweep they grow without bound for the life of the
 * deployment — operational_events in particular gains several rows per inbound
 * email (one per routing decision, hold, drop, truncated attachment).
 *
 * audit_events is the outlier and is deliberately kept longest: it is the
 * security record (who connected a key, who paired an agent, who blocked a
 * sender) and is the thing you most want to still have during an incident.
 */
export const RETENTION_OPERATIONAL_EVENT_DAYS = 90;
export const RETENTION_AUDIT_EVENT_DAYS = 365;

/**
 * Per-run cap so a nightly purge stays well inside Worker CPU/time limits. The
 * remainder catches up on subsequent nights (the cutoff only moves forward).
 */
const PURGE_BATCH = 200;

/** Message-row subset the R2 keys live on. */
type AttachmentKeyRow = { sha256: string; textR2Key: string | null };
type R2KeyRow = { r2Key: string | null; rawMimeKey: string | null; attachmentsMeta: unknown };

/**
 * Every distinct R2 object key a set of message rows references: each row's
 * r2Key (the stored payload) plus every attachmentsMeta[].r2Key. A fetched-body
 * payload (`X.full.json`) also yields its raw webhook sibling (`X.json`) — no
 * message row references the raw once the full copy exists, so it would
 * otherwise survive the purge forever. Deduped; null/undefined keys are
 * skipped (truncated attachment metadata). Normalized attachment rows also
 * contribute their content-addressed bytes, derived text, and cache pointer. Pure.
 */
export function collectR2Keys(rows: R2KeyRow[], attachmentRows: AttachmentKeyRow[] = []): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    // The original RFC822 source. Without this the purge deletes the parsed
    // payload and attachments while `originals/<org>/<day>/<id>.eml` — which
    // contains the COMPLETE message including every attachment — survives with
    // no row referencing it: unreachable, unenumerable, and impossible to erase
    // on request. It is the largest and most sensitive artifact of the three.
    if (row.rawMimeKey) keys.add(row.rawMimeKey);
    if (row.r2Key) {
      keys.add(row.r2Key);
      if (row.r2Key.endsWith(".full.json")) {
        keys.add(row.r2Key.replace(/\.full\.json$/, ".json"));
      }
    }
    const meta = row.attachmentsMeta;
    if (Array.isArray(meta)) {
      for (const att of meta) {
        const k = (att as { r2Key?: unknown })?.r2Key;
        if (typeof k === "string" && k) {
          keys.add(k);
          const hash = /^att\/([a-f0-9]{64})$/.exec(k)?.[1];
          if (hash) keys.add(attachmentTextKey(hash));
        }
      }
    }
  }
  for (const att of attachmentRows) {
    keys.add(attachmentKey(att.sha256));
    // Conversion may have put its content-addressed cache before a D1 update
    // completed, so derive the canonical key even when textR2Key is still null.
    keys.add(attachmentTextKey(att.sha256));
    if (att.textR2Key) keys.add(att.textR2Key);
  }
  return [...keys];
}

/**
 * Nightly retention sweep: threads idling in `trash` past the cutoff are
 * permanently deleted — their search vectors and R2 objects first, then message
 * rows and the thread. The gate is `updatedAt` (bumped by the trash action), NOT
 * `lastMessageAt`: the 30-day undo window must start when the thread entered
 * trash, or a dormant thread would be destroyed by the very next cron run
 * after a mis-click. Bounded to PURGE_BATCH threads per run. Individual R2
 * delete failures are logged and defer that thread, preserving the identifiers
 * needed for the next nightly retry. Other threads still proceed. One
 * summary operational event per affected org records counts only (no
 * keys/bodies).
 */
/** Days → absolute cutoff instant. */
function cutoffFor(days: number, now: number): Date {
  return new Date(now - days * 24 * 3600 * 1000);
}

/**
 * Age out the append-only operational tables and the expired rate-limit
 * counters. Each delete is independent and best-effort: one failing table must
 * not stop the others, and none of it may abort the mail-bearing trash purge.
 *
 * The rate-limit tables are keyed state, not history — a row whose window has
 * long closed is dead weight, and both limiters recreate rows on demand, so
 * deleting stale ones is always safe.
 */
export async function purgeEphemeralRows(db: ReturnType<typeof createDb>, now: number): Promise<void> {
  const staleWindow = now - RATE_HIT_STALE_MS;
  const jobs: [string, Promise<unknown>][] = [
    [
      "operational_events",
      db
        .delete(operationalEvents)
        .where(lte(operationalEvents.createdAt, cutoffFor(RETENTION_OPERATIONAL_EVENT_DAYS, now))),
    ],
    [
      "audit_events",
      db.delete(auditEvents).where(lte(auditEvents.createdAt, cutoffFor(RETENTION_AUDIT_EVENT_DAYS, now))),
    ],
    // Fixed-window counters whose window closed long ago. agent_rate_hits stores
    // window_start as epoch millis, so this compares numbers, not dates.
    ["agent_rate_hits", db.delete(agentRateHits).where(lt(agentRateHits.windowStart, staleWindow))],
  ];

  for (const [table, job] of jobs) {
    try {
      await job;
    } catch (err) {
      console.error("retention_purge_failed", {
        table,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function runRetentionPurge(env: Env): Promise<void> {
  const db = createDb(env);
  const now = Date.now();
  const cutoff = new Date(now - RETENTION_TRASH_DAYS * 24 * 3600 * 1000);

  // Runs first and independently of the thread purge below, which returns early
  // when there is nothing in trash — the ephemeral tables still need sweeping
  // on those nights, which is exactly when they would otherwise grow forever.
  await purgeEphemeralRows(db, now);

  const candidates = await db
    .select({ id: threads.id, organizationId: threads.organizationId })
    .from(threads)
    .where(and(eq(threads.folder, "trash"), lte(threads.updatedAt, cutoff)))
    .orderBy(asc(threads.updatedAt))
    .limit(PURGE_BATCH);

  if (candidates.length === 0) return;

  const byOrg = new Map<
    string,
    { threads: number; messages: number; r2Deleted: number; r2Failed: number; r2Shared: number }
  >();

  for (const thread of candidates) {
    const rows = await db
      .select({
        id: messages.id,
        r2Key: messages.r2Key,
        rawMimeKey: messages.rawMimeKey,
        attachmentsMeta: messages.attachmentsMeta,
      })
      .from(messages)
      .where(eq(messages.threadId, thread.id));

    const attachmentRows = await db.select({ messageId: attachments.messageId, sha256: attachments.sha256, textR2Key: attachments.textR2Key })
      .from(attachments).innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(eq(messages.threadId, thread.id));

    if (env.VECTORS) {
      // indexMessage compacts attachments with text into #0..#N-1. Deleting
      // every possible part (including parts with no current text) also removes
      // stale vectors left by a prior indexing run with more converted parts.
      const ids: string[] = [];
      for (const row of rows) {
        ids.push(vectorId(row.id));
        const parts = attachmentRows.filter((att) => att.messageId === row.id).length;
        for (let part = 0; part < parts; part++) ids.push(vectorId(row.id, part));
      }
      try {
        for (let start = 0; start < ids.length; start += 1000) await env.VECTORS.deleteByIds(ids.slice(start, start + 1000));
      } catch (error) {
        // Keep the rows/attachment counts so the next sweep can retry the same
        // stable ids. Removing D1 first would make these vectors unenumerable.
        console.error("retention_vector_delete_failed", { threadId: thread.id, errorType: error instanceof Error ? error.name : "unknown" });
        continue;
      }
    }

    let r2Deleted = 0;
    let r2Failed = 0;
    let r2Shared = 0;
    for (const key of collectR2Keys(rows, attachmentRows)) {
      const textHash = /^att-text\/([a-f0-9]{64})\.md$/.exec(key)?.[1];
      const bytesKey = textHash ? attachmentKey(textHash) : key;
      // Shared-object guard: ingest stores ONE body object + ONE set of
      // attachment objects per inbound email and references them from every
      // copy (each routed mailbox, each held/unrouted recipient). Deleting a
      // key still referenced by a message outside this thread would 404 the
      // other copies, so it is skipped here and deleted when its last
      // referencing thread is purged.
      const referencedElsewhere = await db
        .select({ one: sql`1` })
        .from(messages)
        .where(
          and(
            ne(messages.threadId, thread.id),
            or(
              eq(messages.r2Key, key),
              // One .eml is shared by every routed and held copy of an email,
              // so it must participate in the shared-object guard too.
              eq(messages.rawMimeKey, key),
              sql`exists (select 1 from json_each(${messages.attachmentsMeta}) where json_extract(value, '$.r2Key') in (${key}, ${bytesKey}))`,
              // Normalized attachments are authoritative for converted text,
              // including references whose cache pointer has not been filled in.
              sql`exists (select 1 from ${attachments} a where a.message_id = ${messages.id} and
                (('att/' || a.sha256) = ${key} or ('att-text/' || a.sha256 || '.md') = ${key} or a.text_r2_key = ${key}))`,
            ),
          ),
        )
        .limit(1);
      if (referencedElsewhere.length > 0) {
        r2Shared++;
        continue;
      }
      try {
        await env.MAIL_STORE.delete(key);
        r2Deleted++;
      } catch (err) {
        // Keep purge metadata for retry rather than orphaning private content.
        // Log only the thread and error type, never object paths or bodies.
        r2Failed++;
        console.error("retention_r2_delete_failed", {
          threadId: thread.id,
          errorType: err instanceof Error ? err.name : "unknown",
        });
      }
    }
    if (r2Failed) continue;

    await batch(db, [
      db.delete(messages).where(eq(messages.threadId, thread.id)),
      db.delete(threads).where(eq(threads.id, thread.id)),
    ]);

    const agg = byOrg.get(thread.organizationId) ?? {
      threads: 0,
      messages: 0,
      r2Deleted: 0,
      r2Failed: 0,
      r2Shared: 0,
    };
    agg.threads += 1;
    agg.messages += rows.length;
    agg.r2Deleted += r2Deleted;
    agg.r2Failed += r2Failed;
    agg.r2Shared += r2Shared;
    byOrg.set(thread.organizationId, agg);
  }

  for (const [organizationId, counts] of byOrg) {
    await db.insert(operationalEvents).values({
      id: crypto.randomUUID(),
      organizationId,
      kind: "retention.trash_purged",
      level: "info",
      detail: counts,
    });
  }
}
