import { env, introspectWorkflowInstance } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { messages, threads } from "@boxox/db";
import { createDb } from "../src/db";
import { inboundRawKey } from "../src/email";
import type { AppContext, SessionUser } from "../src/middleware";
import { labelRoutes } from "../src/routes/labels";
import { splitQuotedHtml, splitQuotedText, threadRoutes } from "../src/routes/threads";
import { runIngest, type IngestStep } from "../src/services/ingest/run";
import { queueOutbound } from "../src/services/outbound/queue";
import { wakeSnoozed } from "../src/workflows/snooze";
import { id, messageRow, seedMailbox, seedThread } from "./helpers/seed";

/**
 * The conversation view's server side on real D1, R2 and Workflows: inbound
 * mail goes through runIngest, and the owner drives the thread routes.
 */
const db = createDb(env);
const OWNER: SessionUser = { id: "owner@example.test", email: "owner@example.test", name: "Owner", role: "owner" };
const app = new Hono<AppContext>()
  .use("*", async (c, next) => {
    c.set("db", createDb(c.env));
    c.set("user", OWNER);
    await next();
  })
  .route("/api/orgs/:orgId/threads", threadRoutes)
  .route("/api/orgs/:orgId/labels", labelRoutes);

const onceStep = { do: (_name: string, _cfg: unknown, fn: () => Promise<unknown>) => fn() } as unknown as IngestStep;

let mailbox: { orgId: string; addressId: string; to: string };

beforeAll(async () => {
  const orgId = `org-${id()}`;
  const domain = `${id()}.test`;
  const seeded = await seedMailbox(db, { orgId, domain, localPart: "ann" });
  mailbox = { orgId, addressId: seeded.addressId, to: `ann@${domain}` };
});

function call(method: string, path: string, body?: unknown) {
  return app.request(
    `/api/orgs/${mailbox.orgId}${path}`,
    { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
}

async function receive(o: { subject: string; html?: string; text?: string; messageId: string; inReplyTo?: string }) {
  const receivedAt = new Date();
  const rawKey = inboundRawKey(receivedAt);
  const raw = [
    "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=ext.test",
    "From: Bea <bea@ext.test>",
    `To: ${mailbox.to}`,
    `Subject: ${o.subject}`,
    `Message-ID: ${o.messageId}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    `Date: ${receivedAt.toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: ${o.html ? "text/html" : "text/plain"}; charset=utf-8`,
    "",
    o.html ?? o.text ?? "",
    "",
  ].join("\r\n");
  await env.MAIL_STORE.put(rawKey, raw, { customMetadata: { to: mailbox.to, from: "bea@ext.test" } });
  const result = await runIngest(env, { rawKey, receivedAt: receivedAt.toISOString() }, onceStep);
  if (result.status !== "stored") throw new Error(`not stored: ${result.status}`);
  return result;
}

const threadRow = async (threadId: string) => (await db.select().from(threads).where(eq(threads.id, threadId)))[0]!;
const inboxIds = async () =>
  ((await (await call("GET", "/threads?folder=inbox")).json()) as { threads: { id: string }[] }).threads.map((t) => t.id);

describe("sent conversations", () => {
  it("keeps outgoing-only mail in Sent, then shows the conversation in Inbox when a reply arrives", async () => {
    const rfcId = `<${id()}@sent.test>`;
    const subject = `Sent conversation ${id()}`;
    const threadId = await seedThread(db, mailbox, { folder: "sent", subject, subjectNorm: subject.toLowerCase(), participants: [mailbox.to, "bea@ext.test"], messageCount: 1, unread: false });
    await db.insert(messages).values(messageRow(mailbox, threadId, { direction: "outbound", fromEmail: mailbox.to, toEmails: ["bea@ext.test"], rfcMessageId: rfcId, sendStatus: "sent" }));
    const listed = async (folder: string) => ((await (await call("GET", `/threads?folder=${folder}`)).json()) as { threads: { id: string }[] }).threads.map(t => t.id);
    expect(await listed("sent")).toContain(threadId);
    expect(await inboxIds()).not.toContain(threadId);
    expect(await listed("archive")).not.toContain(threadId);
    const replyRfcId = `<${id()}@ext.test>`;
    const reply = await receive({ subject: `Re: ${subject}`, text: "Received reply", messageId: replyRfcId, inReplyTo: rfcId });
    expect(reply.threadId).toBe(threadId);
    expect(await inboxIds()).toContain(threadId);
    expect(await listed("sent")).toContain(threadId);
    expect(await threadRow(threadId)).toMatchObject({ folder: "inbox", unread: true, messageCount: 2 });
    const result = await queueOutbound({ ...env, SEND_WORKFLOW: { create: async () => ({}) } as unknown as typeof env.SEND_WORKFLOW }, {
      organizationId: mailbox.orgId, address: { id: mailbox.addressId, email: mailbox.to, displayName: null },
      threadId, to: ["bea@ext.test"], cc: [], bcc: [], subject, text: "My reply", html: null,
      attachments: [], inReplyTo: replyRfcId, references: rfcId,
    });
    expect(result.ok).toBe(true);
    expect(result.threadId).toBe(threadId);
    expect(await inboxIds()).toContain(threadId);
    expect(await threadRow(threadId)).toMatchObject({ folder: "inbox", messageCount: 3 });
  });

  it("restores outgoing-only mail to Sent and mixed conversations to Inbox", async () => {
    for (const withIncoming of [false, true]) {
      const threadId = await seedThread(db, mailbox, { folder: "trash" });
      await db.insert(messages).values(messageRow(mailbox, threadId, { direction: "outbound", sendStatus: "sent" }));
      if (withIncoming) await db.insert(messages).values(messageRow(mailbox, threadId));
      expect((await call("POST", `/threads/${threadId}/actions`, { action: "restore" })).status).toBe(200);
      expect((await threadRow(threadId)).folder).toBe(withIncoming ? "inbox" : "sent");
    }
  });
});

describe("quoted text", () => {
  it("folds gmail_quote and On ... wrote: blocks", async () => {
    const gmail =
      '<div dir="ltr">Sounds good, Thursday works.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Oct 12, 2026 at 9:14 AM Ann &lt;<a href="mailto:ann@x.test">ann@x.test</a>&gt; wrote:<br></div><blockquote class="gmail_quote">Can we meet Thursday?</blockquote></div>';
    const g = splitQuotedHtml(gmail);
    expect(g.body).toBe('<div dir="ltr">Sounds good, Thursday works.</div><br>');
    expect(g.quoted).toMatch(/^<div class="gmail_quote">/);
    expect(g.quoted).toContain("Can we meet Thursday?");

    const apple = "<p>Yes.</p><blockquote type=\"cite\">Earlier words</blockquote>";
    expect(splitQuotedHtml(apple)).toEqual({ body: "<p>Yes.</p>", quoted: '<blockquote type="cite">Earlier words</blockquote>' });

    const attribution = "<div>Thanks!</div><div>On Tue, Oct 13, 2026, Bea wrote:</div><div>&gt; old reply</div>";
    expect(splitQuotedHtml(attribution)).toEqual({
      body: "<div>Thanks!</div>",
      quoted: "<div>On Tue, Oct 13, 2026, Bea wrote:</div><div>&gt; old reply</div>",
    });

    // A message that is nothing but a quote stays visible.
    const onlyQuote = '<div class="gmail_quote">all quoted</div>';
    expect(splitQuotedHtml(onlyQuote)).toEqual({ body: onlyQuote, quoted: null });
    expect(splitQuotedHtml("<p>No history here.</p>")).toEqual({ body: "<p>No history here.</p>", quoted: null });

    const text = "Works for me.\n\nOn Mon, Oct 12, 2026 at 9:14 AM Ann <ann@x.test> wrote:\n> Can we meet?\n> Thursday?";
    expect(splitQuotedText(text)).toEqual({
      body: "Works for me.",
      quoted: "On Mon, Oct 12, 2026 at 9:14 AM Ann <ann@x.test> wrote:\n> Can we meet?\n> Thursday?",
    });
    const wrapped = "Fine.\nOn Mon, Oct 12, 2026 at 9:14 AM Ann Example\n<ann@x.test> wrote:\n> hi";
    expect(splitQuotedText(wrapped).body).toBe("Fine.");
    expect(splitQuotedText("Plain\n> trailing\n>\n> quote").quoted).toBe("> trailing\n>\n> quote");
    // An inline quote answered below it is not folded.
    expect(splitQuotedText("> question?\nanswer").quoted).toBeNull();
    expect(splitQuotedText("Body\n-- \nBea, Sales").quoted).toBe("-- \nBea, Sales");

    // Through the thread view: the body comes back split, the history beside it.
    const stored = await receive({ subject: `Fold ${id()}`, html: gmail, messageId: `<${id()}@ext.test>` });
    const res = await call("GET", `/threads/${stored.threadId}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { messages: { html: string; quotedHtml: string | null }[] };
    expect(detail.messages[0]!.html).toContain("Sounds good, Thursday works.");
    expect(detail.messages[0]!.html).not.toContain("Can we meet Thursday?");
    expect(detail.messages[0]!.quotedHtml).toContain("Can we meet Thursday?");
  });
});

describe("organising", () => {
  it("mute keeps later replies out of the inbox", async () => {
    const first = `<${id()}@ext.test>`;
    const subject = `Muted ${id()}`;
    const start = await receive({ subject, text: "First", messageId: first });
    expect(start.folder).toBe("inbox");
    expect(await inboxIds()).toContain(start.threadId);

    const muted = await call("POST", `/threads/${start.threadId}/mute`, { muted: true });
    expect(muted.status).toBe(200);
    expect(await threadRow(start.threadId)).toMatchObject({ muted: true, folder: "archive" });
    expect(await inboxIds()).not.toContain(start.threadId);

    const reply = await receive({ subject: `Re: ${subject}`, text: "A later reply", messageId: `<${id()}@ext.test>`, inReplyTo: first });
    expect(reply.threadId).toBe(start.threadId);
    expect(await threadRow(start.threadId)).toMatchObject({ muted: true, folder: "archive", messageCount: 2 });
    expect(await inboxIds()).not.toContain(start.threadId);

    // An unmuted conversation does come back on a reply.
    expect((await call("POST", `/threads/${start.threadId}/mute`, { muted: false })).status).toBe(200);
    await receive({ subject: `Re: ${subject}`, text: "Another", messageId: `<${id()}@ext.test>`, inReplyTo: first });
    expect((await threadRow(start.threadId)).folder).toBe("inbox");
    expect(await inboxIds()).toContain(start.threadId);
  });

  it("snooze returns the thread to the inbox when it wakes", async () => {
    const start = await receive({ subject: `Snooze ${id()}`, text: "Later please", messageId: `<${id()}@ext.test>` });
    await call("POST", `/threads/${start.threadId}/actions`, { action: "read" });
    const until = new Date(Date.now() + 3600_000);
    until.setMilliseconds(0);

    const instance = await introspectWorkflowInstance(env.SNOOZE_WORKFLOW, `snooze-${start.threadId}-${until.getTime()}`);
    try {
      await instance.modify(async (m) => {
        await m.disableSleeps();
      });
      const res = await call("POST", `/threads/${start.threadId}/snooze`, { until: until.toISOString() });
      expect(res.status).toBe(200);
      await instance.waitForStatus("complete");
      expect(await instance.getOutput()).toBe(true);
    } finally {
      await instance.dispose();
    }
    const woke = await threadRow(start.threadId);
    expect(woke).toMatchObject({ folder: "inbox", snoozedUntil: null, unread: true });
    expect(await inboxIds()).toContain(start.threadId);

    // While snoozed it is out of the inbox and in the snoozed view.
    const later = new Date(Date.now() + 2 * 3600_000);
    const snoozed = await call("POST", `/threads/${start.threadId}/snooze`, { until: later.toISOString() });
    expect(snoozed.status).toBe(200);
    expect(await inboxIds()).not.toContain(start.threadId);
    const view = (await (await call("GET", "/threads?folder=snoozed")).json()) as { threads: { id: string; snoozedUntil: string }[] };
    expect(view.threads.find((t) => t.id === start.threadId)?.snoozedUntil).toBe(later.toISOString());

    // A superseded wake-up is a no-op; only the current snooze brings it back.
    expect(await wakeSnoozed(db, start.threadId, until)).toBe(false);
    expect((await threadRow(start.threadId)).folder).toBe("archive");
    expect(await wakeSnoozed(db, start.threadId, later)).toBe(true);
    expect((await threadRow(start.threadId)).folder).toBe("inbox");

    expect((await call("POST", `/threads/${start.threadId}/snooze`, { until: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
  });

  it("labels threads and lists them by label", async () => {
    const start = await receive({ subject: `Label ${id()}`, text: "Tag me", messageId: `<${id()}@ext.test>` });
    const created = await call("POST", "/labels", { name: `Clients ${id()}`, color: "#3DA5F4" });
    expect(created.status).toBe(201);
    const { label } = (await created.json()) as { label: { id: string; name: string } };
    expect((await call("POST", "/labels", { name: label.name.toUpperCase() })).status).toBe(409);

    expect((await call("PUT", `/threads/${start.threadId}/labels/${label.id}`)).status).toBe(200);
    expect((await call("PUT", `/threads/${start.threadId}/labels/${label.id}`)).status).toBe(200);
    const listed = (await (await call("GET", `/threads?folder=label&labelId=${label.id}`)).json()) as {
      threads: { id: string; labels: { id: string }[] }[];
    };
    expect(listed.threads.map((t) => t.id)).toEqual([start.threadId]);
    expect(listed.threads[0]!.labels.map((l) => l.id)).toEqual([label.id]);
    const detail = (await (await call("GET", `/threads/${start.threadId}`)).json()) as { thread: { labels: { name: string }[]; participants: string[] } };
    expect(detail.thread.labels.map((l) => l.name)).toEqual([label.name]);
    expect(detail.thread.participants).toContain("bea@ext.test");

    expect((await call("DELETE", `/threads/${start.threadId}/labels/${label.id}`)).status).toBe(200);
    const after = (await (await call("GET", `/threads?folder=label&labelId=${label.id}`)).json()) as { threads: unknown[] };
    expect(after.threads).toEqual([]);
    expect((await call("PUT", `/threads/${start.threadId}/labels/missing`)).status).toBe(404);
  });
});
