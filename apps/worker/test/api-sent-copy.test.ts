import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addresses, apiMessages, domains, messages, threads } from "@boxox/db";
import { createDb } from "../src/db";
import { apiSentCopyId, copyApiSentMessage, copyRecentApiSentMessages } from "../src/services/api-sent-copy";
import { recordEmailEvent } from "../src/services/outbound/events";

const db = createDb(env);
async function sample(withAddress = true) {
  const domainId = crypto.randomUUID(), id = crypto.randomUUID(), addressId = crypto.randomUUID();
  const name = `${domainId}.test`, org = crypto.randomUUID(), r2Key = `api-test/${id}`;
  await db.insert(domains).values({ id: domainId, organizationId: org, name });
  if (withAddress) await db.insert(addresses).values({ id: addressId, domainId, organizationId: org, localPart: "hello", createdBy: "owner" });
  await env.MAIL_STORE.put(r2Key, JSON.stringify({ text: "Application test", html: "<p>Application test</p>", attachments: [{ filename: "test.txt", content: btoa("attachment"), contentType: "text/plain" }] }));
  await db.insert(apiMessages).values({ id, domainId, fromEmail: `App <hello@${name}>`, toEmails: ["recipient@example.test"], bccEmails: ["private@example.test"], subject: "Sent from app", r2Key, status: "sent", sentMessageId: `<${id}@sending.test>` });
  return { id, addressId, domainId, name, org, r2Key, copyId: apiSentCopyId(id) };
}

describe("API sent copies", () => {
  it("shows sent app mail in the existing mailbox once, with independent body and attachments", async () => {
    const s = await sample();
    await Promise.all([copyApiSentMessage(env, s.id), copyApiSentMessage(env, s.id)]);
    const [copy] = await db.select().from(messages).where(eq(messages.id, s.copyId));
    const [thread] = await db.select().from(threads).where(eq(threads.id, s.copyId));
    expect(copy).toMatchObject({ addressId: s.addressId, direction: "outbound", sendStatus: "sent", fromEmail: `hello@${s.name}`, bccEmails: ["private@example.test"] });
    expect(thread).toMatchObject({ folder: "sent", unread: false, messageCount: 1, organizationId: s.org });
    expect(copy!.r2Key).not.toBe(s.r2Key);
    const attachment = copy!.attachmentsMeta[0] as { r2Key: string };
    expect(await (await env.MAIL_STORE.get(attachment.r2Key!))!.text()).toBe("attachment");
    await env.MAIL_STORE.delete(copy!.r2Key);
    expect(await env.MAIL_STORE.get(s.r2Key)).not.toBeNull();
    expect(await db.select().from(messages).where(eq(messages.id, s.copyId))).toHaveLength(1);
    await db.delete(threads).where(eq(threads.id, s.copyId));
    await copyRecentApiSentMessages(env, s.org);
    expect(await db.query.messages.findFirst({ where: eq(messages.id, s.copyId) })).toBeUndefined();
  });
  it("keeps unknown sending addresses owner-only and scopes historical catch-up to the organization", async () => {
    const a = await sample(false), b = await sample(false);
    await copyRecentApiSentMessages(env, a.org);
    expect(await db.query.messages.findFirst({ where: eq(messages.id, b.copyId) })).toBeUndefined();
    expect(await db.query.messages.findFirst({ where: eq(messages.id, a.copyId) })).toMatchObject({ addressId: null });
    expect(await db.select().from(addresses).where(eq(addresses.domainId, a.domainId))).toEqual([]);
  });
  it("delivery updates both the mailbox copy and API log while retaining API webhook ownership", async () => {
    const s = await sample();
    await copyApiSentMessage(env, s.id);
    const ev = { eventId: crypto.randomUUID(), type: "delivered" as const, messageId: `<${s.id}@sending.test>`, sender: `hello@${s.name}`, recipient: "recipient@example.test", occurredAt: new Date(), detail: {} };
    const result = await recordEmailEvent(db, ev);
    expect(result.apiMessageId).toBe(s.id);
    expect((await db.query.messages.findFirst({ where: eq(messages.id, s.copyId) }))?.deliveryStatus).toBe("delivered");
    expect((await db.query.apiMessages.findFirst({ where: eq(apiMessages.id, s.id) }))?.status).toBe("delivered");
    expect(await recordEmailEvent(db, ev)).toEqual(result);
  });
});
