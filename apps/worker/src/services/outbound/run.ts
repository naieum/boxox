import type { WorkflowStep } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { messageEvents, messages } from "@boxox/db";
import { createDb, type Db } from "../../db";
import type { Env, SendParams } from "../../env";
import { log } from "../../log";
import { classifySendError, sendErrorMessage, type SendErrorKind } from "./errors";
import { sendingPause, suppressedRecipients } from "./safety";

/**
 * SendWorkflow's steps. The message row and its R2 body already exist
 * (queueOutbound writes both before creating the instance), so every step
 * reads from them and nothing here can lose the composed message.
 */

export type SendStep = Pick<WorkflowStep, "do" | "sleep" | "sleepUntil">;
export type SendEnv = Pick<Env, "DB" | "MAIL_STORE" | "EMAIL">;

/** Attempts for errors Cloudflare raises before sending (rate and daily limits). */
export const MAX_SEND_ATTEMPTS = 4;
export const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000];

export interface OutboundBody {
  text: string;
  html: string | null;
  attachments: { filename: string; content: string; contentType?: string }[];
}

type Recipients = { to: string[]; cc: string[]; bcc: string[] };

type Gate = { action: "stop"; reason: string } | { action: "send"; recipients: Recipients };

type Attempt =
  | { kind: "sent"; sentMessageId: string; recorded: boolean }
  | { kind: SendErrorKind; error: string };

const AMBIGUOUS_NOTE = "Delivery unknown: the message may have been sent. Check before sending it again.";

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

async function markFailed(db: Db, messageId: string, error: string, detail: Record<string, unknown>) {
  // Never overwrite a terminal state: a message already sent stays sent.
  const changed = await db
    .update(messages)
    .set({ sendStatus: "failed", sendError: error.slice(0, 500) })
    .where(and(eq(messages.id, messageId), inArray(messages.sendStatus, ["queued", "scheduled"])))
    .returning({ id: messages.id });
  if (!changed.length) return;
  await db
    .insert(messageEvents)
    .values({ id: `failed:${messageId}`, messageId, type: "failed", detail, occurredAt: new Date() })
    .onConflictDoNothing();
}

async function recordSent(db: Db, messageId: string, sentMessageId: string, attempt: number) {
  const now = new Date();
  await db.batch([
    db
      .update(messages)
      // The returned id is the RFC 5322 Message-ID recipients see; replies thread on it.
      .set({ sendStatus: "sent", sentMessageId, rfcMessageId: sentMessageId, sendError: null, sendAttempts: attempt })
      .where(eq(messages.id, messageId)),
    db
      .insert(messageEvents)
      .values({ id: `sent:${messageId}`, messageId, type: "sent", detail: { sentMessageId }, occurredAt: now })
      .onConflictDoNothing(),
  ]);
}

/** Drop suppressed recipients, and refuse to send while the breaker is open. */
async function gate(db: Db, messageId: string): Promise<Gate> {
  const [row] = await db
    .select({
      status: messages.sendStatus,
      fromEmail: messages.fromEmail,
      to: messages.toEmails,
      cc: messages.ccEmails,
      bcc: messages.bccEmails,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) return { action: "stop", reason: "missing" };
  if (row.status !== "queued" && row.status !== "scheduled") return { action: "stop", reason: row.status ?? "none" };

  const pause = await sendingPause(db);
  if (pause) {
    await markFailed(db, messageId, `Sending is paused: ${pause.reason ?? "circuit breaker"}. Send again once it is resumed.`, {
      reason: "sending_paused",
    });
    return { action: "stop", reason: "paused" };
  }

  const all = [...row.to, ...row.cc, ...row.bcc];
  const blocked = await suppressedRecipients(db, row.fromEmail, all);
  const keep = (list: string[]) => list.filter((r) => !blocked.has(r.toLowerCase()));
  const recipients = { to: keep(row.to), cc: keep(row.cc), bcc: keep(row.bcc) };
  if (blocked.size) {
    const now = new Date();
    await db
      .insert(messageEvents)
      .values(
        [...blocked].map((recipient) => ({
          id: `rejected:${messageId}:${recipient}`,
          messageId,
          type: "rejected" as const,
          recipient,
          detail: { reason: "suppressed" },
          occurredAt: now,
        })),
      )
      .onConflictDoNothing();
  }
  if (!recipients.to.length && !recipients.cc.length && !recipients.bcc.length) {
    await markFailed(db, messageId, "Every recipient is on the suppression list (an earlier bounce or complaint).", {
      reason: "suppressed",
    });
    return { action: "stop", reason: "suppressed" };
  }
  if (row.status === "scheduled") {
    await db
      .update(messages)
      .set({ sendStatus: "queued" })
      .where(and(eq(messages.id, messageId), eq(messages.sendStatus, "scheduled")));
  }
  return { action: "send", recipients };
}

/**
 * One call to send(), at most. The attempt counter is claimed first, so a step
 * the engine re-runs after a crash finds it taken and does not send again.
 */
async function attemptSend(env: SendEnv, db: Db, messageId: string, recipients: Recipients, attempt: number): Promise<Attempt> {
  const claimed = await db
    .update(messages)
    .set({ sendAttempts: attempt })
    .where(and(eq(messages.id, messageId), eq(messages.sendStatus, "queued"), eq(messages.sendAttempts, attempt - 1)))
    .returning({
      fromEmail: messages.fromEmail,
      fromName: messages.fromName,
      subject: messages.subject,
      r2Key: messages.r2Key,
      inReplyTo: messages.inReplyTo,
      references: messages.references,
    });
  const row = claimed[0];
  if (!row) return { kind: "ambiguous", error: "An earlier attempt was interrupted after it started." };

  const obj = await env.MAIL_STORE.get(row.r2Key);
  if (!obj) return { kind: "permanent", error: "The message body is missing from storage." };
  const body = (await obj.json()) as OutboundBody;

  let sentMessageId: string;
  try {
    const sent = await env.EMAIL.send({
      from: row.fromName ? { name: row.fromName, email: row.fromEmail } : row.fromEmail,
      ...(recipients.to.length ? { to: recipients.to } : {}),
      ...(recipients.cc.length ? { cc: recipients.cc } : {}),
      ...(recipients.bcc.length ? { bcc: recipients.bcc } : {}),
      subject: row.subject,
      text: body.text,
      ...(body.html ? { html: body.html } : {}),
      ...(body.attachments?.length
        ? {
            attachments: body.attachments.map((a) => ({
              disposition: "attachment" as const,
              filename: a.filename,
              type: a.contentType ?? "application/octet-stream",
              content: decodeBase64(a.content),
            })),
          }
        : {}),
      headers: {
        // Cloudflare sets Message-ID itself; this lets us recognise our own mail.
        "X-Boxox-Message": messageId,
        ...(row.inReplyTo ? { "In-Reply-To": row.inReplyTo } : {}),
        ...(row.references ? { References: row.references } : {}),
      },
    } as EmailMessageBuilder);
    sentMessageId = sent.messageId;
  } catch (err) {
    return { kind: classifySendError(err), error: sendErrorMessage(err) };
  }

  // The mail is out. A database blip now must not read as a send failure.
  try {
    await recordSent(db, messageId, sentMessageId, attempt);
    return { kind: "sent", sentMessageId, recorded: true };
  } catch (err) {
    log.error("outbound_record_sent_failed", { messageId, error: err });
    return { kind: "sent", sentMessageId, recorded: false };
  }
}

export async function runSend(env: SendEnv, params: SendParams, step: SendStep): Promise<string> {
  const db = createDb(env);
  const { messageId } = params;

  if (params.scheduledAt) {
    await step.sleepUntil("wait for scheduled time", new Date(params.scheduledAt));
  }

  const g = await step.do("check suppression and breaker", () => gate(db, messageId));
  if (g.action === "stop") return g.reason;

  for (let attempt = 1; ; attempt++) {
    let result: Attempt;
    try {
      result = await step.do(
        `send attempt ${attempt}`,
        // Never retried by the engine: send() has no idempotency key.
        { retries: { limit: 0, delay: 0 }, timeout: "5 minutes" },
        () => attemptSend(env, db, messageId, g.recipients, attempt),
      );
    } catch (err) {
      // The step itself died (timeout, eviction) with send() possibly issued.
      result = { kind: "ambiguous", error: sendErrorMessage(err) };
    }

    if (result.kind === "sent") {
      if (!result.recorded) {
        const sentMessageId = result.sentMessageId;
        await step.do("record sent", () => recordSent(db, messageId, sentMessageId, attempt));
      }
      return "sent";
    }
    if (result.kind === "retryable" && attempt < MAX_SEND_ATTEMPTS) {
      await step.sleep(`back off after attempt ${attempt}`, RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!);
      continue;
    }
    const error = result.kind === "ambiguous" ? `${AMBIGUOUS_NOTE} (${result.error})` : result.error;
    await step.do("mark failed", () =>
      markFailed(db, messageId, error, { reason: result.kind, attempts: attempt }),
    );
    return result.kind === "ambiguous" ? "unknown" : "failed";
  }
}
