import { eq, sql } from "drizzle-orm";
import { messageEvents, messages, threads } from "@boxox/db";
import { base64Size, makeSnippet, normalizeSubject } from "@boxox/shared";
import { batch, createDb } from "../../db";
import type { Env } from "../../env";
import { log } from "../../log";
import type { OutboundBody } from "./run";

export interface QueueOutboundInput {
  organizationId: string;
  /** The sending address; the caller has already checked the send grant. */
  address: { id: string; email: string; displayName: string | null };
  /** An existing thread of this address, or null to start one. */
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | null;
  attachments: OutboundBody["attachments"];
  inReplyTo: string | null;
  references: string | null;
  /** Absent or past: send now. */
  scheduledAt?: Date | null;
}

export type QueueOutboundResult =
  | { ok: true; messageId: string; threadId: string; scheduled: boolean }
  | { ok: false; messageId: string; threadId: string; error: string };

/**
 * Persist first: the body goes to R2 and the message row to D1 before a
 * SendWorkflow exists, so nothing that happens to the send can lose the
 * message. The workflow instance id is the message id, so a message can
 * never have two sends in flight.
 */
export async function queueOutbound(
  env: Pick<Env, "DB" | "MAIL_STORE" | "SEND_WORKFLOW">,
  input: QueueOutboundInput,
): Promise<QueueOutboundResult> {
  const db = createDb(env);
  const now = new Date();
  const msgId = crypto.randomUUID();
  const scheduled = !!input.scheduledAt && input.scheduledAt.getTime() > now.getTime();
  const r2Key = `sent/${input.organizationId}/${now.toISOString().slice(0, 10)}/${msgId}.json`;

  const body: OutboundBody = { text: input.text, html: input.html, attachments: input.attachments };
  const payload = JSON.stringify(body);
  await env.MAIL_STORE.put(r2Key, payload, { httpMetadata: { contentType: "application/json" } });

  const newThread = !input.threadId;
  const threadId = input.threadId ?? crypto.randomUUID();
  const snippet = makeSnippet(input.text);
  await batch(db, [
    ...(newThread
      ? [
          db.insert(threads).values({
            id: threadId,
            organizationId: input.organizationId,
            addressId: input.address.id,
            subject: input.subject,
            subjectNorm: normalizeSubject(input.subject),
            counterpartyEmail: input.to[0] ?? null,
            participants: [...new Set([input.address.email, ...input.to, ...input.cc].map((e) => e.toLowerCase()))],
            folder: "sent",
            unread: false,
            lastMessageAt: now,
          }),
        ]
      : []),
    db.insert(messages).values({
      id: msgId,
      threadId,
      organizationId: input.organizationId,
      addressId: input.address.id,
      dedupeScope: input.address.id,
      direction: "outbound",
      fromEmail: input.address.email,
      fromName: input.address.displayName,
      authenticated: true,
      toEmails: input.to,
      ccEmails: input.cc,
      bccEmails: input.bcc,
      subject: input.subject,
      snippet,
      inReplyTo: input.inReplyTo,
      references: input.references,
      r2Key,
      hasText: true,
      hasHtml: !!input.html,
      attachmentsMeta: input.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType ?? "application/octet-stream",
        size: base64Size(a.content),
        r2Key: null,
      })),
      sendStatus: scheduled ? "scheduled" : "queued",
      scheduledAt: scheduled ? input.scheduledAt! : null,
      sendAttempts: 0,
      storedBytes: new TextEncoder().encode(payload).length,
      occurredAt: now,
    }),
    ...(scheduled
      ? [
          db.insert(messageEvents).values({
            id: `scheduled:${msgId}`,
            messageId: msgId,
            type: "scheduled",
            detail: { scheduledAt: input.scheduledAt!.toISOString() },
            occurredAt: now,
          }),
        ]
      : []),
    db
      .update(threads)
      .set({ lastMessageAt: now, snippet, messageCount: sql`${threads.messageCount} + 1`, updatedAt: now })
      .where(eq(threads.id, threadId)),
  ]);

  try {
    await env.SEND_WORKFLOW.create({
      id: msgId,
      params: { messageId: msgId, ...(scheduled ? { scheduledAt: input.scheduledAt!.toISOString() } : {}) },
    });
  } catch (err) {
    // Nothing was sent, so failing here is safe; the saved message can be sent again.
    log.error("send_workflow_create_failed", { messageId: msgId, error: err });
    const error = "Could not start sending; the message was saved. Send it again to retry.";
    await db.update(messages).set({ sendStatus: "failed", sendError: error }).where(eq(messages.id, msgId));
    return { ok: false, messageId: msgId, threadId, error };
  }
  return { ok: true, messageId: msgId, threadId, scheduled };
}
