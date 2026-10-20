import { sql } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";

/** Instants are stored as epoch milliseconds and read back as Date. */
export const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const bool = (name: string) => integer(name, { mode: "boolean" });

export const now = () => new Date();

/** SQL-side "now" in epoch ms, so raw-SQL inserts (triggers, tests) get stamps too. */
export const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

/** created_at / updated_at: stamped by Drizzle on insert, and by SQLite for raw SQL. */
export const stamp = (name: string) => ts(name).notNull().default(nowMs).$defaultFn(now);

/** jsonb → TEXT. Query inside with json_extract / json_each. */
export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
