import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { addressGrants, addresses, domains, drafts, messageEvents, messages, shareLinks, threads } from "@boxox/db";
import { createDb } from "../src/db";
import type { Env, SendParams } from "../src/env";
import type { AppContext, SessionUser } from "../src/middleware";
import { draftRoutes } from "../src/routes/drafts";
import { MAX_MESSAGE_BYTES, replyAllRecipients, sendRoutes } from "../src/routes/send";
import {
  SHARE_LINK_LIMITS,
  createShareLink,
  hashToken,
  shareLinkPublicRoutes,
  shareLinkRoutes,
} from "../src/routes/share-links";
import { runSend, type SendStep } from "../src/services/outbound/run";
import { id, messageRow } from "./helpers/seed";

/**
 * Compose against real D1 and R2: sends, drafts and share links go through
 * their routes as the web app calls them. SendWorkflow is a fake that records
 * what was queued; the send_email binding is a fake too, so nothing is mailed.
 */
const ORG = "owner";
const ORIGIN = "https://mail.example.test";
const db = createDb(env);
const enc = new TextEncoder();

const OWNER: SessionUser = { id: "owner@example.test", email: "owner@example.test", name: "Owner", role: "owner" };
const MEMBER: SessionUser = { id: "member@example.test", email: "member@example.test", name: "Member", role: "member" };

function fakeWorkflow() {
  const create = vi.fn(async (_opts: { id: string; params: SendParams }) => ({ id: _opts.id }));
  return { create, binding: { create } as unknown as Workflow<SendParams> };
}

function appAs(user: SessionUser) {
  return new Hono<AppContext>()
    .use("*", async (c, next) => {
      c.set("db", createDb(c.env));
      if (!c.req.path.startsWith("/f/")) c.set("user", user);
      await next();
    })
    .route("/api/orgs/:orgId/send", sendRoutes)
    .route("/api/orgs/:orgId/drafts", draftRoutes)
    .route("/api/orgs/:orgId/share-links", shareLinkRoutes)
    .route("/f", shareLinkPublicRoutes);
}

function client(user: SessionUser = OWNER) {
  const wf = fakeWorkflow();
  const app = appAs(user);
  const testEnv = { ...env, SEND_WORKFLOW: wf.binding, PUBLIC_URL: ORIGIN } as unknown as Env;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(
      path.startsWith("/f/") ? `${ORIGIN}${path}` : `${ORIGIN}/api/orgs/${ORG}${path}`,
      {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
      },
      testEnv,
    );
  return { wf, call };
}

async function seedAddress(localPart: string, domainName = `${id().slice(0, 8)}.test`) {
  let [domain] = await db.select().from(domains).where(eq(domains.name, domainName));
  if (!domain) {
    [domain] = await db
      .insert(domains)
      .values({ id: id(), organizationId: ORG, name: domainName, sendingEnabled: true })
      .returning();
  }
  const addressId = id();
  await db.insert(addresses).values({ id: addressId, domainId: domain!.id, organizationId: ORG, localPart, createdBy: OWNER.id });
  return { addressId, email: `${localPart}@${domainName}`, domainName };
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function messagesOf(addressId: string) {
  return db.select().from(messages).where(eq(messages.addressId, addressId));
}

async function sentPayload(r2Key: string) {
  const obj = await env.MAIL_STORE.get(r2Key);
  return (await obj!.json()) as { text: string; html: string | null; attachments: { filename: string; content: string }[] };
}

describe("compose", () => {
  it("reply-all excludes the user's own addresses", async () => {
    const me = await seedAddress("me");
    const sales = await seedAddress("sales", me.domainName);
    const threadId = id();
    await db.insert(threads).values({ id: threadId, organizationId: ORG, addressId: me.addressId, subject: "Plans" });
    const original = messageRow({ orgId: ORG, addressId: me.addressId }, threadId, {
      fromEmail: "alice@ext.test",
      toEmails: [me.email, "bob@ext.test", sales.email.toUpperCase()],
      ccEmails: ["carol@ext.test", me.email.toUpperCase(), "Bob@ext.test"],
      subject: "Plans",
      references: "<root@ext.test>",
    });
    await db.insert(messages).values(original);
    await env.MAIL_STORE.put(original.r2Key, JSON.stringify({ text: "Shall we meet?\nThursday?", html: null }));

    // The owner sends as every address, so both of theirs drop out.
    const owner = client(OWNER);
    const ctx = await owner.call("GET", `/send/context/${original.id}?mode=reply_all`);
    expect(ctx.status).toBe(200);
    const prefill = (await ctx.json()) as { to: string[]; cc: string[]; subject: string; quote: string; threadId: string; fromAddressId: string };
    expect(prefill.to).toEqual(["alice@ext.test", "bob@ext.test"]);
    expect(prefill.cc).toEqual(["carol@ext.test"]);
    expect(prefill.subject).toBe("Re: Plans");
    expect(prefill.threadId).toBe(threadId);
    expect(prefill.fromAddressId).toBe(me.addressId);
    expect(prefill.quote).toContain("> Shall we meet?\n> Thursday?");

    // A member who sends only as me@ keeps the sales mailbox: it's a colleague's, not theirs.
    await db.insert(addressGrants).values({
      id: id(),
      addressId: me.addressId,
      organizationId: ORG,
      principalType: "user",
      inviteEmail: MEMBER.email,
      permissions: ["read", "send"],
      createdBy: OWNER.id,
    });
    const member = client(MEMBER);
    const memberCtx = (await (await member.call("GET", `/send/context/${original.id}?mode=reply_all`)).json()) as { to: string[]; cc: string[] };
    expect(memberCtx.to).toEqual(["alice@ext.test", "bob@ext.test", sales.email.toUpperCase()]);
    expect(memberCtx.cc).toEqual(["carol@ext.test"]);

    // Answering your own sent message goes back to its recipients.
    expect(
      replyAllRecipients(
        { direction: "outbound", fromEmail: me.email, toEmails: ["dan@ext.test", me.email], ccEmails: ["erin@ext.test", "DAN@ext.test"] },
        [me.email],
      ),
    ).toEqual({ to: ["dan@ext.test"], cc: ["erin@ext.test"] });

    // Sending the reply-all threads it under the message answered.
    const res = await owner.call("POST", "/send", {
      fromAddressId: me.addressId,
      mode: "reply_all",
      replyToMessageId: original.id,
      to: prefill.to,
      cc: prefill.cc,
      subject: prefill.subject,
      text: `Thursday works.${prefill.quote}`,
    });
    expect(res.status).toBe(200);
    const sent = (await res.json()) as { messageId: string; threadId: string };
    expect(sent.threadId).toBe(threadId);
    const [row] = await db.select().from(messages).where(eq(messages.id, sent.messageId));
    expect(row!.toEmails).toEqual(["alice@ext.test", "bob@ext.test"]);
    expect(row!.ccEmails).toEqual(["carol@ext.test"]);
    expect(row!.inReplyTo).toBe(original.rfcMessageId);
    expect(row!.references).toBe(`<root@ext.test> ${original.rfcMessageId}`);
    expect(owner.wf.create).toHaveBeenCalledWith({ id: sent.messageId, params: { messageId: sent.messageId } });
  });

  it("a message over 5 MiB turns attachments into expiring links", async () => {
    const me = await seedAddress("big");
    const owner = client(OWNER);
    const big = new Uint8Array(4 * 1024 * 1024).map((_, i) => i % 251);
    const small = enc.encode("small notes ".repeat(500));
    const body = {
      fromAddressId: me.addressId,
      to: ["friend@ext.test"],
      subject: "The footage",
      text: "Files attached.",
      html: "<p>Files attached.</p>",
      attachments: [
        { filename: "footage.bin", content: toBase64(big), contentType: "application/octet-stream" },
        { filename: "notes.txt", content: toBase64(small), contentType: "text/plain" },
      ],
    };

    // Asked not to fall back, the oversized message is refused and nothing is written.
    const refused = await owner.call("POST", "/send", { ...body, attachmentsMode: "fail" });
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ error: { code: "message_too_large" } });
    expect(await messagesOf(me.addressId)).toHaveLength(0);
    expect(owner.wf.create).not.toHaveBeenCalled();

    const before = Date.now();
    const res = await owner.call("POST", "/send", body);
    expect(res.status).toBe(200);
    const sent = (await res.json()) as { messageId: string; links: { id: string; filename: string; url: string; expiresAt: string }[] };
    // Only the large file became a link; the small one still fits as an attachment.
    expect(sent.links.map((l) => l.filename)).toEqual(["footage.bin"]);
    const link = sent.links[0]!;
    expect(link.url).toMatch(new RegExp(`^${ORIGIN}/f/[A-Za-z0-9_-]{22}$`));
    const expiresIn = new Date(link.expiresAt).getTime() - before;
    expect(expiresIn).toBeGreaterThan(7 * 24 * 3600 * 1000 - 60_000);
    expect(expiresIn).toBeLessThan(7 * 24 * 3600 * 1000 + 60_000);

    const [row] = await messagesOf(me.addressId);
    expect(row!.id).toBe(sent.messageId);
    expect((row!.attachmentsMeta as { filename: string }[]).map((a) => a.filename)).toEqual(["notes.txt"]);
    const payload = await sentPayload(row!.r2Key);
    expect(payload.attachments.map((a) => a.filename)).toEqual(["notes.txt"]);
    expect(payload.text).toContain(link.url);
    expect(payload.html).toContain(`href="${link.url}"`);
    const encoded = enc.encode(JSON.stringify(payload)).length;
    expect(encoded).toBeLessThan(MAX_MESSAGE_BYTES);

    // Only the token's hash is stored, and the link is tied to the message.
    const token = link.url.split("/f/")[1]!;
    const [stored] = await db.select().from(shareLinks).where(eq(shareLinks.id, link.id));
    expect(stored!.tokenHash).toBe(await hashToken(token));
    expect(stored!.tokenHash).not.toContain(token);
    expect(stored!.messageId).toBe(sent.messageId);
    expect(stored!.size).toBe(big.length);

    const download = await owner.call("GET", `/f/${token}/download`, undefined, { "cf-connecting-ip": "198.51.100.1" });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain('attachment; filename="footage.bin"');
    expect(download.headers.get("x-robots-tag")).toContain("noindex");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(big);
  });

  it("rejects more than 50 recipients", async () => {
    const me = await seedAddress("many");
    const owner = client(OWNER);
    const people = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}@ext.test`);
    const res = await owner.call("POST", "/send", {
      fromAddressId: me.addressId,
      to: people(30, "to"),
      cc: people(15, "cc"),
      bcc: people(6, "bcc"),
      subject: "Everyone",
      text: "Hello all",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "too_many_recipients" } });
    expect(await messagesOf(me.addressId)).toHaveLength(0);
    expect(owner.wf.create).not.toHaveBeenCalled();

    // A draft can hold more while it's being written, but can't be sent that way.
    const draft = (await (await owner.call("POST", "/drafts", { fromAddressId: me.addressId, to: people(51, "d"), subject: "Too many", text: "x" })).json()) as {
      draft: { id: string };
    };
    const fromDraft = await owner.call("POST", `/drafts/${draft.draft.id}/send`, {});
    expect(fromDraft.status).toBe(422);
    expect((await owner.call("GET", `/drafts/${draft.draft.id}`)).status).toBe(200);

    const exactly = await owner.call("POST", "/send", {
      fromAddressId: me.addressId,
      to: people(30, "to"),
      cc: people(14, "cc"),
      bcc: people(6, "bcc"),
      subject: "Everyone",
      text: "Hello all",
    });
    expect(exactly.status).toBe(200);
    const [row] = await messagesOf(me.addressId);
    expect(row!.toEmails.length + row!.ccEmails.length + row!.bccEmails.length).toBe(50);
    expect(owner.wf.create).toHaveBeenCalledTimes(1);
  });

  it("large-file links expire, can be revoked and are rate limited", async () => {
    const owner = client(OWNER);
    const member = client(MEMBER);
    const bytes = enc.encode("%PDF-1.4 the big report");
    await env.MAIL_STORE.put("files/test/report", bytes);
    const make = (days?: number) =>
      createShareLink(db, ORIGIN, {
        r2Key: "files/test/report",
        filename: "report.pdf",
        contentType: "application/pdf",
        size: bytes.length,
        createdBy: OWNER.id,
        expiresInDays: days,
      });
    const ip = (n: number) => ({ "cf-connecting-ip": `192.0.2.${n}` });

    const link = await make();
    const page = await owner.call("GET", `/f/${link.token}`, undefined, ip(1));
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    expect(await page.text()).toContain('<meta name="robots" content="noindex');
    const file = await owner.call("GET", `/f/${link.token}/download`, undefined, ip(1));
    expect(file.status).toBe(200);
    // Served as opaque bytes, never as the declared type.
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect(file.headers.get("content-security-policy")).toBe("sandbox");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect((await db.select().from(shareLinks).where(eq(shareLinks.id, link.id)))[0]!.downloadCount).toBe(1);
    expect((await owner.call("GET", `/f/${"A".repeat(22)}`, undefined, ip(1))).status).toBe(404);

    // Expiry: the owner's choice, clamped to 30 days; once past, the file is gone.
    const long = await make(99);
    expect(long.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 24 * 3600 * 1000);
    await db.update(shareLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shareLinks.id, long.id));
    expect((await owner.call("GET", `/f/${long.token}/download`, undefined, ip(1))).status).toBe(410);

    // Revocation: only by its creator (or an admin), and immediate.
    expect((await member.call("POST", `/share-links/${link.id}/revoke`)).status).toBe(404);
    expect((await owner.call("POST", `/share-links/${link.id}/revoke`)).status).toBe(200);
    expect((await owner.call("GET", `/f/${link.token}/download`, undefined, ip(1))).status).toBe(410);
    expect((await owner.call("GET", `/f/${link.token}`, undefined, ip(1))).status).toBe(410);
    const listed = (await (await owner.call("GET", "/share-links")).json()) as { links: { id: string; revokedAt: string | null }[] };
    expect(listed.links.find((l) => l.id === link.id)?.revokedAt).not.toBeNull();

    // Per IP: guessing tokens spends the same budget, then even a valid link is refused.
    const fresh = await make();
    for (let i = 0; i < SHARE_LINK_LIMITS.perIp; i++) {
      expect((await owner.call("GET", `/f/${id().replace(/-/g, "").slice(0, 22)}`, undefined, ip(50))).status).toBe(404);
    }
    expect((await owner.call("GET", `/f/${fresh.token}/download`, undefined, ip(50))).status).toBe(429);
    expect((await owner.call("GET", `/f/${fresh.token}/download`, undefined, ip(51))).status).toBe(200);

    // Per link: many addresses can't pull one file without limit.
    const popular = await make();
    for (let i = 0; i < SHARE_LINK_LIMITS.perLink; i++) {
      const res = await owner.call("GET", `/f/${popular.token}`, undefined, { "cf-connecting-ip": `2001:db8::${i.toString(16)}` });
      expect(res.status).toBe(200);
    }
    const over = await owner.call("GET", `/f/${popular.token}/download`, undefined, { "cf-connecting-ip": "2001:db8::ffff" });
    expect(over.status).toBe(429);
    expect(over.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("a draft becomes a scheduled send", async () => {
    const me = await seedAddress("later");
    const owner = client(OWNER);

    const created = await owner.call("POST", "/drafts", { fromAddressId: me.addressId });
    expect(created.status).toBe(201);
    const draftId = ((await created.json()) as { draft: { id: string } }).draft.id;

    // Autosave: partial updates land as they're typed.
    await owner.call("PATCH", `/drafts/${draftId}`, { to: ["client@ext.test"], subject: "Monday" });
    await owner.call("PATCH", `/drafts/${draftId}`, { text: "See you Monday." });
    const upload = await owner.call("POST", `/drafts/${draftId}/attachments?filename=agenda.txt`, enc.encode("abc"), {
      "content-type": "text/plain",
    });
    expect(upload.status).toBe(201);
    const saved = ((await (await owner.call("GET", `/drafts/${draftId}`)).json()) as {
      draft: { to: string[]; subject: string; text: string; attachments: { filename: string; size: number }[] };
    }).draft;
    expect(saved).toMatchObject({ to: ["client@ext.test"], subject: "Monday", text: "See you Monday." });
    expect(saved.attachments).toEqual([{ index: 0, filename: "agenda.txt", contentType: "text/plain", size: 3 }]);
    const [draftRow] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    const draftKey = (draftRow!.attachmentsMeta as { r2Key: string }[])[0]!.r2Key;
    expect(await env.MAIL_STORE.head(draftKey)).not.toBeNull();
    // Someone else can't see or send it.
    expect((await client(MEMBER).call("POST", `/drafts/${draftId}/send`, {})).status).toBe(404);

    const sendAt = new Date(Date.now() + 2 * 3600 * 1000);
    const res = await owner.call("POST", `/drafts/${draftId}/send`, { sendAt: sendAt.toISOString() });
    expect(res.status).toBe(200);
    const sent = (await res.json()) as { messageId: string; scheduled: boolean };
    expect(sent.scheduled).toBe(true);

    const [row] = await db.select().from(messages).where(eq(messages.id, sent.messageId));
    expect(row).toMatchObject({ sendStatus: "scheduled", subject: "Monday", toEmails: ["client@ext.test"] });
    expect(row!.scheduledAt?.getTime()).toBe(sendAt.getTime());
    expect(await db.select().from(messageEvents).where(and(eq(messageEvents.messageId, sent.messageId), eq(messageEvents.type, "scheduled")))).toHaveLength(1);
    expect(owner.wf.create).toHaveBeenCalledWith({
      id: sent.messageId,
      params: { messageId: sent.messageId, scheduledAt: sendAt.toISOString() },
    });
    const payload = await sentPayload(row!.r2Key);
    expect(payload.text).toBe("See you Monday.");
    expect(payload.attachments).toEqual([{ filename: "agenda.txt", content: "YWJj", contentType: "text/plain" }]);

    // The draft is gone, its upload copied into the message and removed.
    expect((await owner.call("GET", `/drafts/${draftId}`)).status).toBe(404);
    expect(await env.MAIL_STORE.head(draftKey)).toBeNull();

    // SendWorkflow sleeps until the chosen time, then sends once.
    const order: string[] = [];
    const step = {
      async do(name: string, a: unknown, b?: unknown) {
        order.push(name);
        return ((typeof a === "function" ? a : b) as () => Promise<unknown>)();
      },
      async sleep() {},
      async sleepUntil(name: string, at: Date) {
        order.push(`${name} ${new Date(at).toISOString()}`);
      },
    } as unknown as SendStep;
    const send = vi.fn(async (_msg: Record<string, unknown>) => ({ messageId: `<${id()}@${me.domainName}>` }));
    await runSend({ ...env, EMAIL: { send } as unknown as SendEmail }, { messageId: sent.messageId, scheduledAt: sendAt.toISOString() }, step);
    expect(order[0]).toBe(`wait for scheduled time ${sendAt.toISOString()}`);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ to: ["client@ext.test"], subject: "Monday" });
    expect((await db.select().from(messages).where(eq(messages.id, sent.messageId)))[0]!.sendStatus).toBe("sent");

    // One draft per thread: saving a reply draft twice updates the same one.
    const thread = (await db.select().from(threads).where(eq(threads.id, row!.threadId)))[0]!;
    const first = (await (await owner.call("POST", "/drafts", { fromAddressId: me.addressId, threadId: thread.id, mode: "reply", text: "a" })).json()) as {
      draft: { id: string };
    };
    const second = (await (await owner.call("POST", "/drafts", { fromAddressId: me.addressId, threadId: thread.id, mode: "reply", text: "ab" })).json()) as {
      draft: { id: string; text: string };
    };
    expect(second.draft.id).toBe(first.draft.id);
    expect(second.draft.text).toBe("ab");
    expect(await db.select().from(drafts).where(eq(drafts.threadId, thread.id))).toHaveLength(1);
  });
});
