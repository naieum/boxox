import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { threads } from "@boxox/db";
import { createDb, type Db } from "../db";
import type { Env, SnoozeParams } from "../env";

/**
 * Returns a snoozed thread to the inbox, unread. Only the snooze this instance
 * was started for: a later snooze, or an unsnooze, changed snoozed_until and
 * makes this a no-op.
 */
export async function wakeSnoozed(db: Db, threadId: string, until: Date): Promise<boolean> {
  const woke = await db
    .update(threads)
    .set({
      folder: sql`CASE WHEN ${threads.folder} = 'archive' THEN 'inbox' ELSE ${threads.folder} END`,
      snoozedUntil: null,
      unread: true,
      updatedAt: new Date(),
    })
    .where(and(eq(threads.id, threadId), eq(threads.snoozedUntil, until)))
    .returning({ id: threads.id });
  return woke.length > 0;
}

/** Sleeps until the snooze time, then wakes the thread. One instance per (thread, time). */
export class SnoozeWorkflow extends WorkflowEntrypoint<Env, SnoozeParams> {
  async run(event: WorkflowEvent<SnoozeParams>, step: WorkflowStep): Promise<boolean> {
    const until = new Date(event.payload.until);
    await step.sleepUntil("snooze", until);
    return step.do("wake thread", () => wakeSnoozed(createDb(this.env), event.payload.threadId, until));
  }
}
