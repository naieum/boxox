import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { suppressions } from "@boxox/db";
import type { Db } from "../db";
import type { AuthenticatedKey } from "./keys";
import { MessageError, zodError } from "./messages";

/**
 * The key's domain's suppression list. Bounces and complaints land here from
 * cf-email-events; a key with `send` can also add or remove addresses. Removing
 * one only clears our list: Cloudflare's own list still applies.
 */

type SuppressionRow = typeof suppressions.$inferSelect;

export const addSuppressionSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(320), detail: z.string().max(300).optional() })
  .strict();

function view(row: SuppressionRow) {
  return {
    id: row.id,
    object: "suppression",
    email: row.email,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

function encodeCursor(row: SuppressionRow) {
  return btoa(`${row.createdAt.getTime()}:${row.id}`).replace(/=+$/, "");
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const [at, id] = atob(cursor).split(":");
    const ms = Number(at);
    if (id && Number.isFinite(ms)) return { at: new Date(ms), id };
  } catch {}
  throw new MessageError(400, "bad_request", "Invalid cursor", "cursor");
}

export interface SuppressionFilters {
  reason?: SuppressionRow["reason"];
  cursor?: string;
  limit?: number;
}

export async function listSuppressions(db: Db, key: AuthenticatedKey, filters: SuppressionFilters) {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const where: SQL[] = [eq(suppressions.domainId, key.domainId!)];
  if (filters.reason) where.push(eq(suppressions.reason, filters.reason));
  if (filters.cursor) {
    const c = decodeCursor(filters.cursor);
    where.push(or(lt(suppressions.createdAt, c.at), and(eq(suppressions.createdAt, c.at), lt(suppressions.id, c.id)))!);
  }
  const rows = await db
    .select()
    .from(suppressions)
    .where(and(...where))
    .orderBy(desc(suppressions.createdAt), desc(suppressions.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { data: page.map(view), nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null };
}

async function ownSuppression(db: Db, key: AuthenticatedKey, email: string) {
  const [row] = await db
    .select()
    .from(suppressions)
    .where(and(eq(suppressions.domainId, key.domainId!), eq(suppressions.email, email.trim().toLowerCase())))
    .limit(1);
  if (!row) throw new MessageError(404, "not_found", "That address is not suppressed");
  return row;
}

export async function getSuppression(db: Db, key: AuthenticatedKey, email: string) {
  return view(await ownSuppression(db, key, email));
}

/** Manual entries; an address already suppressed keeps its original reason. */
export async function addSuppression(db: Db, key: AuthenticatedKey, raw: unknown) {
  const parsed = addSuppressionSchema.safeParse(raw);
  if (!parsed.success) throw zodError(parsed.error);
  await db
    .insert(suppressions)
    .values({
      id: crypto.randomUUID(),
      domainId: key.domainId!,
      email: parsed.data.email,
      reason: "manual",
      detail: parsed.data.detail ?? null,
    })
    .onConflictDoNothing();
  return view(await ownSuppression(db, key, parsed.data.email));
}

export async function removeSuppression(db: Db, key: AuthenticatedKey, email: string) {
  const row = await ownSuppression(db, key, email);
  await db.delete(suppressions).where(eq(suppressions.id, row.id));
  return { id: row.id, object: "suppression", email: row.email, deleted: true };
}
