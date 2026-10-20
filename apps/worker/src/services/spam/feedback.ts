import { and, eq } from "drizzle-orm";
import { messages } from "@boxox/db";
import type { Db } from "../../db";
import { learn, type BayesLabel } from "./bayes";
import { forgetSpamFingerprint, recordSpamFingerprint } from "./fingerprint";

/** Called only after the thread's org/read checks, for the owner's explicit spam choices. */
export async function trainThreadFeedback(db: Db, bucket: R2Bucket, orgId: string, threadId: string, label: BayesLabel) {
  const rows = await db.select().from(messages).where(and(
    eq(messages.organizationId, orgId), eq(messages.threadId, threadId), eq(messages.direction, "inbound"),
  ));
  for (const message of rows) {
    const obj = await bucket.get(message.r2Key);
    const raw = obj ? await obj.json().catch(() => null) as {
      data?: { html?: unknown; text?: unknown }; html?: unknown; text?: unknown;
    } | null : null;
    const text = raw?.data?.text ?? raw?.text;
    const html = raw?.data?.html ?? raw?.html;
    const body = {
      text: typeof text === "string" ? text : typeof html === "string" ? null : message.snippet,
      html: typeof html === "string" ? html : null,
    };
    // learn atomically removes the previous label's counts before relabelling.
    // Repeated clicks on the same label are no-ops.
    await learn(db, message.id, label, { ...body, subject: message.subject, fromEmail: message.fromEmail });
    if (label === "spam") await recordSpamFingerprint(db, message.id, body);
    else await forgetSpamFingerprint(db, message.id);
  }
}
