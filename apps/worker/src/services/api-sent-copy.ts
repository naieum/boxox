import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { addresses, apiMessages, domains, messages, threads } from "@boxox/db";
import { base64Size, makeSnippet, normalizeSubject, parseAddress } from "@boxox/shared";
import { createDb } from "../db";
import type { Env } from "../env";

type CopyEnv = Pick<Env, "DB" | "MAIL_STORE"> & Partial<Pick<Env, "MAILBOX_HUB">>;
export const apiSentCopyId = (id: string) => `api-sent:${id}`;

/** A separate stored copy: deleting mailbox mail must never delete the API log's body. */
export async function copyApiSentMessage(env: CopyEnv, id: string): Promise<void> {
  const db = createDb(env);
  const copyId = apiSentCopyId(id);
  const [record] = await db.select({ message: apiMessages, domain: domains }).from(apiMessages)
    .innerJoin(domains, eq(domains.id, apiMessages.domainId)).where(eq(apiMessages.id, id)).limit(1);
  if (!record?.message.sentMessageId || record.message.mailboxCopiedAt) return;
  const { message: row, domain } = record;
  const from = parseAddress(row.fromEmail);
  const [address] = await db.select({ id: addresses.id }).from(addresses)
    .where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, from.email.split("@")[0]!))).limit(1);
  // Unconfigured senders remain owner-only; a domain key cannot mint mailbox grants.
  const addressId = address?.id ?? null;
  const object = await env.MAIL_STORE.get(row.r2Key);
  if (!object) return;
  const body = await object.json<{ text?: string; html?: string | null; headers?: Record<string, string>; attachments?: { filename: string; content: string; contentType?: string; contentId?: string }[] }>();
  const r2Key = `sent-api/${domain.organizationId}/${id}.json`;
  const payload = JSON.stringify(body);
  await env.MAIL_STORE.put(r2Key, payload, { httpMetadata: { contentType: "application/json" } });
  const attachments = await Promise.all((body.attachments ?? []).map(async (a, i) => {
    const key = `sent-api/${domain.organizationId}/${id}/attachment-${i}`;
    await env.MAIL_STORE.put(key, Uint8Array.from(atob(a.content), c => c.charCodeAt(0)));
    return { filename: a.filename, contentType: a.contentType ?? "application/octet-stream", size: base64Size(a.content), r2Key: key, ...(a.contentId ? { contentId: a.contentId } : {}) };
  }));
  const snippet = makeSnippet(body.text ?? body.html?.replace(/<[^>]*>/g, " ") ?? "");
  await db.batch([
    db.insert(threads).values({ id: copyId, organizationId: domain.organizationId, domainId: domain.id, addressId,
      subject: row.subject, subjectNorm: normalizeSubject(row.subject), counterpartyEmail: row.toEmails[0] ?? null,
      participants: [...new Set([from.email, ...row.toEmails, ...row.ccEmails])], folder: "sent", unread: false,
      messageCount: 1, snippet, lastMessageAt: row.createdAt }).onConflictDoNothing(),
    db.insert(messages).values({ id: copyId, threadId: copyId, organizationId: domain.organizationId, addressId,
      dedupeScope: `api-sent:${id}`, direction: "outbound", fromEmail: from.email, fromName: from.name,
      authenticated: true, toEmails: row.toEmails, ccEmails: row.ccEmails, bccEmails: row.bccEmails,
      subject: row.subject, snippet, r2Key, hasText: !!body.text, hasHtml: !!body.html, attachmentsMeta: attachments,
      inReplyTo: Object.entries(body.headers ?? {}).find(([k]) => k.toLowerCase() === "in-reply-to")?.[1] ?? null,
      references: Object.entries(body.headers ?? {}).find(([k]) => k.toLowerCase() === "references")?.[1] ?? null,
      sendStatus: "sent", sentMessageId: row.sentMessageId, rfcMessageId: row.sentMessageId,
      storedBytes: new TextEncoder().encode(payload).length + attachments.reduce((n, a) => n + a.size, 0),
      occurredAt: row.createdAt }).onConflictDoNothing(),
    db.update(apiMessages).set({ mailboxCopiedAt: new Date() }).where(eq(apiMessages.id, id)),
  ]);
  const { notifyNewMessage } = await import("../do/mailbox-hub");
  await notifyNewMessage(env, db, copyId, "sent");
}

/** Bounded catch-up for messages accepted before mailbox copies were introduced. */
export async function copyRecentApiSentMessages(env: CopyEnv, orgId: string, limit = 20): Promise<void> {
  const db = createDb(env);
  const pending = await db.select({ id: apiMessages.id }).from(apiMessages).innerJoin(domains, eq(domains.id, apiMessages.domainId))
    .where(and(eq(domains.organizationId, orgId), isNotNull(apiMessages.sentMessageId),
      isNull(apiMessages.mailboxCopiedAt)))
    .orderBy(desc(apiMessages.createdAt)).limit(limit);
  for (const row of pending) await copyApiSentMessage(env, row.id);
}
