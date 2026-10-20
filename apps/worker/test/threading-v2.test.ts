import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { labels, messages, threadLabels, threadOverrides, threads } from "@boxox/db";
import { batch, createDb } from "../src/db";
import { storeInbound, type InboundSummary } from "../src/services/ingest/store";
import type { InboundRoute } from "../src/services/ingest/route";
import { MAX_THREAD_MESSAGES, decideThread, mergeThreads, splitMessage, threadingResolver } from "../src/services/threading";
import { id, messageRow, seedMailbox } from "./helpers/seed";

/**
 * Gmail-style threading on real D1: inbound copies go through storeInbound
 * with the threading resolver, exactly as IngestWorkflow stores them.
 */
const db = createDb(env);

async function mailbox(localPart = "me", orgId = `org-${id()}`) {
  const domain = `${id()}.test`;
  const box = await seedMailbox(db, { orgId, domain, localPart });
  const route: InboundRoute = {
    kind: "deliver",
    orgId,
    domainId: box.domainId,
    addressId: box.addressId,
    addressKind: "role",
    via: "exact",
    senderBlocked: false,
  };
  return { ...box, email: `${localPart}@${domain}`, route };
}

type Box = Awaited<ReturnType<typeof mailbox>>;

let clock = Date.now() - 24 * 3600 * 1000;

async function receive(
  box: Box,
  mail: { from: string; to?: string[]; cc?: string[]; subject: string; rfcId?: string; inReplyTo?: string; references?: string },
) {
  const rawKey = `inbound/${id()}`;
  const rfcMessageId = mail.rfcId ?? `<${id()}@ext.test>`;
  const summary: InboundSummary = {
    rawKey,
    rawSize: 100,
    bodyKey: `body/${rawKey}`,
    quarantineReason: null,
    fromEmail: mail.from,
    fromName: null,
    toEmails: mail.to ?? [box.email],
    ccEmails: mail.cc ?? [],
    subject: mail.subject,
    rfcMessageId,
    inReplyTo: mail.inReplyTo ?? null,
    references: mail.references ?? null,
    authenticated: true,
    snippet: "",
    searchText: null,
    hasText: true,
    hasHtml: false,
    attachments: [],
    attachmentBytes: 0,
  };
  clock += 60_000;
  const result = await storeInbound(db, box.route, summary, new Date(clock), threadingResolver);
  if (result.status !== "stored") throw new Error(`not stored: ${result.status}`);
  const row = await db.query.messages.findFirst({ where: eq(messages.id, result.messageId) });
  return { ...result, rfcMessageId, newParticipant: row!.newParticipant };
}

const thread = (threadId: string) => db.query.threads.findFirst({ where: eq(threads.id, threadId) });

describe("threading service", () => {
  it("a three-person group thread stays one conversation", async () => {
    const box = await mailbox();
    const group = [box.email, "bob@ext.test", "cat@ext.test"];
    const first = await receive(box, { from: "ann@ext.test", to: group, subject: "Offsite plans" });
    // Bob's client sends no In-Reply-To; only the subject and the people tie it together.
    const bob = await receive(box, { from: "bob@ext.test", to: ["ann@ext.test", box.email], cc: ["cat@ext.test"], subject: "Re: Offsite plans" });
    const cat = await receive(box, {
      from: "cat@ext.test",
      to: ["ann@ext.test", "bob@ext.test", box.email],
      subject: "RE: Offsite plans",
      inReplyTo: bob.rfcMessageId,
      references: `${first.rfcMessageId} ${bob.rfcMessageId}`,
    });
    const ann = await receive(box, { from: "ann@ext.test", to: group.slice(1), cc: [box.email], subject: "Re: Re: Offsite plans" });

    expect(new Set([first.threadId, bob.threadId, cat.threadId, ann.threadId]).size).toBe(1);
    const conv = await thread(first.threadId);
    expect(conv?.messageCount).toBe(4);
    expect(conv?.participants).toEqual(expect.arrayContaining(["ann@ext.test", "bob@ext.test", "cat@ext.test"]));
    // v1 keyed the fallback on one counterparty, so Bob's reply would have split off.
    expect([bob.newParticipant, cat.newParticipant, ann.newParticipant]).toEqual([false, false, false]);

    // A stranger reusing the subject shares nobody but the mailbox itself, so it is a new conversation.
    const stranger = await receive(box, { from: "eve@spam.test", subject: "Re: Offsite plans" });
    expect(stranger.threadId).not.toBe(first.threadId);
  });

  it("a changed subject starts a new conversation", async () => {
    const box = await mailbox();
    const root = await receive(box, { from: "ann@ext.test", subject: "Q3 invoice" });
    const same = await receive(box, { from: "ann@ext.test", subject: "Re: Q3 invoice", inReplyTo: root.rfcMessageId, references: root.rfcMessageId });
    expect(same.threadId).toBe(root.threadId);

    const changed = await receive(box, {
      from: "ann@ext.test",
      subject: "Re: Totally different topic",
      inReplyTo: same.rfcMessageId,
      references: `${root.rfcMessageId} ${same.rfcMessageId}`,
    });
    expect(changed.threadId).not.toBe(root.threadId);
    expect((await thread(changed.threadId))?.subjectNorm).toBe("totally different topic");
    expect((await thread(root.threadId))?.messageCount).toBe(2);

    // Replies on the new subject follow the new conversation.
    const followUp = await receive(box, { from: "ann@ext.test", subject: "Re: Totally different topic", inReplyTo: changed.rfcMessageId });
    expect(followUp.threadId).toBe(changed.threadId);
  });

  it("the 101st message starts a new conversation", async () => {
    const box = await mailbox();
    const root = await receive(box, { from: "ann@ext.test", subject: "Daily standup" });
    const rows = Array.from({ length: MAX_THREAD_MESSAGES - 1 }, (_, i) =>
      messageRow(box, root.threadId, { fromEmail: "ann@ext.test", subject: "Re: Daily standup", rfcMessageId: `<standup-${i}-${root.threadId}@ext.test>` }),
    );
    await batch(db, rows.map((row) => db.insert(messages).values(row)));
    await db.update(threads).set({ messageCount: MAX_THREAD_MESSAGES }).where(eq(threads.id, root.threadId));
    const last = rows.at(-1)!.rfcMessageId!;

    const overflow = await receive(box, { from: "ann@ext.test", subject: "Re: Daily standup", inReplyTo: last, references: `${root.rfcMessageId} ${last}` });
    expect(overflow.threadId).not.toBe(root.threadId);
    expect((await thread(root.threadId))?.messageCount).toBe(MAX_THREAD_MESSAGES);
    expect((await thread(overflow.threadId))?.messageCount).toBe(1);

    // A later reply to the full conversation continues in the new one rather than starting a third.
    const next = await receive(box, { from: "ann@ext.test", subject: "Re: Daily standup", inReplyTo: last });
    expect(next.threadId).toBe(overflow.threadId);
  });

  it("a forged References header pointing at another mailbox does not join", async () => {
    const victim = await mailbox("ceo");
    // Same org, so only the per-mailbox scope keeps it out.
    const attacker = await mailbox("support", victim.orgId);
    const secret = await receive(victim, { from: "board@ext.test", subject: "Acquisition terms" });
    const forged = await receive(attacker, {
      from: "board@ext.test",
      subject: "Re: Acquisition terms",
      inReplyTo: secret.rfcMessageId,
      references: secret.rfcMessageId,
    });
    expect(forged.threadId).not.toBe(secret.threadId);
    expect((await thread(forged.threadId))?.addressId).toBe(attacker.addressId);
    expect((await thread(secret.threadId))?.messageCount).toBe(1);
    expect(await db.select().from(messages).where(and(eq(messages.threadId, secret.threadId), eq(messages.addressId, attacker.addressId)))).toEqual([]);
  });

  it("an unknown sender joining is marked new participant", async () => {
    const box = await mailbox();
    const root = await receive(box, { from: "ann@ext.test", subject: "Contract draft" });
    const known = await receive(box, { from: "ann@ext.test", subject: "Re: Contract draft", inReplyTo: root.rfcMessageId });
    expect(known.threadId).toBe(root.threadId);
    expect(known.newParticipant).toBe(false);

    // Mallory quotes a real Message-ID; the join is allowed but flagged.
    const mallory = await receive(box, { from: "mallory@evil.test", subject: "Re: Contract draft", inReplyTo: root.rfcMessageId, references: root.rfcMessageId });
    expect(mallory.threadId).toBe(root.threadId);
    expect(mallory.newParticipant).toBe(true);

    // Once in the conversation, she is no longer new.
    const again = await receive(box, { from: "mallory@evil.test", subject: "Re: Contract draft", inReplyTo: mallory.rfcMessageId });
    expect(again.threadId).toBe(root.threadId);
    expect(again.newParticipant).toBe(false);
  });

  it("replies to our own sent messages always attach", async () => {
    const box = await mailbox();
    const other = await mailbox("sales", box.orgId);
    const threadId = `thr-${id()}`;
    await db.insert(threads).values({ id: threadId, organizationId: box.orgId, addressId: box.addressId, subject: "Proposal", subjectNorm: "proposal", participants: [box.email, "dan@ext.test"], messageCount: 1 });
    const sentId = `<${id()}@${box.email.split("@")[1]}>`;
    await db.insert(messages).values(
      messageRow(box, threadId, { direction: "outbound", fromEmail: box.email, toEmails: ["dan@ext.test"], subject: "Proposal", rfcMessageId: sentId, sendStatus: "sent", sentMessageId: sentId }),
    );

    const reply = await receive(box, { from: "dan@ext.test", subject: "Re: Proposal", inReplyTo: sentId, references: sentId });
    expect(reply.threadId).toBe(threadId);
    // Even an edited subject stays: the Message-ID came from our own send and can't be guessed.
    const renamed = await receive(box, { from: "dan@ext.test", subject: "Re: Proposal (signed)", inReplyTo: sentId });
    expect(renamed.threadId).toBe(threadId);
    expect((await thread(threadId))?.messageCount).toBe(3);

    // Still per mailbox: the same id quoted to another mailbox does not reach this conversation.
    const elsewhere = await receive(other, { from: "dan@ext.test", subject: "Re: Proposal", inReplyTo: sentId });
    expect(elsewhere.threadId).not.toBe(threadId);

    expect(
      decideThread(
        { subject: "Re: Something else", participants: ["dan@ext.test"], ancestry: [sentId], occurredAt: new Date(), self: [box.email] },
        {
          ancestors: [{ rfcMessageId: sentId, threadId, direction: "outbound", subject: "Proposal" }],
          threads: [{ id: threadId, subjectNorm: "proposal", participants: [], messageCount: 3, lastMessageAt: new Date() }],
          fallback: [],
          merges: new Map(),
        },
      ),
    ).toEqual({ threadId, rule: "own_sent" });
  });

  it("split and merge are recorded and respected", async () => {
    const box = await mailbox();
    const root = await receive(box, { from: "ann@ext.test", subject: "Kitchen remodel" });
    const tangent = await receive(box, { from: "ann@ext.test", subject: "Re: Kitchen remodel", inReplyTo: root.rfcMessageId, references: root.rfcMessageId });
    expect(tangent.threadId).toBe(root.threadId);

    const split = await splitMessage(db, { orgId: box.orgId, messageId: tangent.messageId, by: "owner@example.test" });
    expect(split.threadId).not.toBe(root.threadId);
    const [splitRow] = await db.select().from(threadOverrides).where(eq(threadOverrides.messageId, tangent.messageId));
    expect(splitRow).toMatchObject({ kind: "split", sourceThreadId: root.threadId, targetThreadId: split.threadId });
    expect((await thread(root.threadId))?.messageCount).toBe(1);
    expect((await thread(split.threadId))?.messageCount).toBe(1);

    // A reply to the split-out message follows it instead of re-joining the original.
    const replyToTangent = await receive(box, {
      from: "ann@ext.test",
      subject: "Re: Kitchen remodel",
      inReplyTo: tangent.rfcMessageId,
      references: `${root.rfcMessageId} ${tangent.rfcMessageId}`,
    });
    expect(replyToTangent.threadId).toBe(split.threadId);
    const replyToRoot = await receive(box, { from: "ann@ext.test", subject: "Re: Kitchen remodel", inReplyTo: root.rfcMessageId });
    expect(replyToRoot.threadId).toBe(root.threadId);

    // Merge two conversations with different subjects.
    const tiles = await receive(box, { from: "bob@ext.test", subject: "Tile samples" });
    const labelId = id();
    await db.insert(labels).values({ id: labelId, name: `reno-${labelId}`, createdBy: "owner@example.test" });
    await db.insert(threadLabels).values({ threadId: tiles.threadId, labelId });
    const merged = await mergeThreads(db, { orgId: box.orgId, sourceThreadId: tiles.threadId, targetThreadId: root.threadId, by: "owner@example.test" });
    expect(merged.threadId).toBe(root.threadId);
    expect(await thread(tiles.threadId)).toBeUndefined();
    const [mergeRow] = await db.select().from(threadOverrides).where(and(eq(threadOverrides.kind, "merge"), eq(threadOverrides.sourceThreadId, tiles.threadId)));
    expect(mergeRow?.targetThreadId).toBe(root.threadId);
    const target = await thread(root.threadId);
    expect(target?.messageCount).toBe(3);
    expect(target?.participants).toEqual(expect.arrayContaining(["ann@ext.test", "bob@ext.test"]));
    expect(await db.select({ labelId: threadLabels.labelId }).from(threadLabels).where(eq(threadLabels.threadId, root.threadId))).toEqual([{ labelId }]);

    // A reply to the merged-in conversation keeps its own subject and still lands in the merged one.
    const tileReply = await receive(box, { from: "bob@ext.test", subject: "Re: Tile samples", inReplyTo: tiles.rfcMessageId });
    expect(tileReply.threadId).toBe(root.threadId);
    expect(tileReply.newParticipant).toBe(false);

    // The resolver also honours a recorded merge whose source id is still referenced.
    expect(
      decideThread(
        { subject: "Re: Tile samples", participants: ["bob@ext.test"], ancestry: ["<x@ext.test>"], occurredAt: new Date(), self: [box.email] },
        {
          ancestors: [{ rfcMessageId: "<x@ext.test>", threadId: tiles.threadId, direction: "inbound", subject: "Tile samples" }],
          threads: [{ id: root.threadId, subjectNorm: "kitchen remodel", participants: [], messageCount: 4, lastMessageAt: new Date() }],
          fallback: [],
          merges: new Map([[tiles.threadId, root.threadId]]),
        },
      ),
    ).toEqual({ threadId: root.threadId, rule: "ancestor" });

    // Threads never span mailboxes.
    const other = await mailbox("sales", box.orgId);
    const foreign = await receive(other, { from: "bob@ext.test", subject: "Elsewhere" });
    await expect(mergeThreads(db, { orgId: box.orgId, sourceThreadId: foreign.threadId, targetThreadId: root.threadId, by: "owner@example.test" })).rejects.toThrow(
      /different mailboxes/,
    );
  });
});
