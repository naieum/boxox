import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { addresses, blockedSenders, domains, messages, threads } from "@boxox/db";
import { createDb, searchThreads } from "../src/db";
import { inboundRawKey } from "../src/email";
import { CLOUDFLARE_AUTHSERV_ID, isAuthenticated } from "../src/services/ingest/auth";
import { MIME_LIMITS, parseMessage } from "../src/services/ingest/parse";
import { bodyKeyFor, runIngest, type IngestStep } from "../src/services/ingest/run";
import type { ThreadResolver } from "../src/services/ingest/thread";
import { id, seedMailbox } from "./helpers/seed";

/**
 * IngestWorkflow against recorded and hand-built .eml fixtures
 * (fixtures/eml/), on real D1 and R2. Steps run through a fake step that can
 * replay each callback, or through the real Workflows binding.
 */
const db = createDb(env);
const eml = import.meta.glob<string>("./fixtures/eml/*.eml", { eager: true, import: "default", query: "?raw" });

function fixture(name: string): Uint8Array {
  const text = eml[`./fixtures/eml/${name}`];
  if (text === undefined) throw new Error(`no fixture ${name}`);
  return new TextEncoder().encode(text);
}

/** What email() leaves behind: the raw message in R2 with the envelope in its metadata. */
async function deliver(raw: Uint8Array, to: string, from = "bounce@ext.test") {
  const receivedAt = new Date();
  const rawKey = inboundRawKey(receivedAt);
  await env.MAIL_STORE.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { to, from } });
  return { rawKey, receivedAt: receivedAt.toISOString() };
}

/** A step that runs every callback `times` times in a row, like a step retried after its write landed. */
function replayingStep(times: number) {
  const calls = new Map<string, number>();
  const step = {
    async do(name: string, a: unknown, b?: unknown) {
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      let out: unknown;
      for (let i = 0; i < times; i++) {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        out = await fn();
      }
      return out;
    },
  };
  return { step: step as unknown as IngestStep, calls };
}

async function ingest(raw: Uint8Array, to: string, from?: string) {
  const params = await deliver(raw, to, from);
  const result = await runIngest(env, params, replayingStep(1).step);
  return { params, result };
}

async function domainWith(opts: { policy?: "hold" | "catch_all" | "drop" } = {}) {
  const orgId = `org-${id()}`;
  const name = `${id()}.test`;
  const mailbox = await seedMailbox(db, { orgId, domain: name, localPart: "ann" });
  await db.update(addresses).set({ kind: "personal" }).where(eq(addresses.id, mailbox.addressId));
  const support = id();
  await db.insert(addresses).values({ id: support, domainId: mailbox.domainId, organizationId: orgId, localPart: "support", kind: "role", createdBy: "owner@example.test" });
  if (opts.policy) {
    await db
      .update(domains)
      .set({ unknownMailPolicy: opts.policy, catchAllAddressId: opts.policy === "catch_all" ? mailbox.addressId : null })
      .where(eq(domains.id, mailbox.domainId));
  }
  return { ...mailbox, name, support };
}

async function threadOf(messageId: string) {
  const [m] = await db.select().from(messages).where(eq(messages.id, messageId));
  const [t] = await db.select().from(threads).where(eq(threads.id, m!.threadId));
  return { message: m!, thread: t! };
}

describe("IngestWorkflow", () => {
  it("running every step twice creates one message", async () => {
    const box = await domainWith();
    const params = await deliver(fixture("plain.eml"), `ann@${box.name}`);
    const twice = replayingStep(2);

    const first = await runIngest(env, params, twice.step);
    // Every step really ran twice, and a whole second run changes nothing either.
    expect([...twice.calls.values()]).toEqual([2, 2, 2]);
    const again = await runIngest(env, params, replayingStep(2).step);

    expect(first.status).toBe("stored");
    expect(again).toEqual(first);
    const rows = await db.select().from(messages).where(eq(messages.addressId, box.addressId));
    expect(rows).toHaveLength(1);
    const boxThreads = await db.select().from(threads).where(eq(threads.addressId, box.addressId));
    expect(boxThreads).toHaveLength(1);
    expect(boxThreads[0]).toMatchObject({ messageCount: 1, unread: true, folder: "inbox", subject: "Quarterly numbers" });
    const fts = await env.DB.prepare("SELECT count(*) AS n FROM threads_fts_docs WHERE message_id = ?").bind(rows[0]!.id).first<{ n: number }>();
    expect(fts?.n).toBe(1);

    // The same Message-ID under a new raw key (a sender retry) dedupes and leaves no empty thread behind.
    const retry = await deliver(fixture("plain.eml"), `ann@${box.name}`);
    const dup = await runIngest(env, retry, replayingStep(2).step);
    expect(dup).toMatchObject({ status: "duplicate", messageId: rows[0]!.id });
    expect(await db.select().from(messages).where(eq(messages.addressId, box.addressId))).toHaveLength(1);
    expect(await db.select().from(threads).where(eq(threads.addressId, box.addressId))).toHaveLength(1);
    expect(await db.select().from(threads).where(eq(threads.id, `thr-${retry.rawKey}`))).toHaveLength(0);

    // Two raw copies racing each other: one message, one thread, no empty thread from the loser.
    const racer = await domainWith();
    const copies = await Promise.all([1, 2, 3].map(() => deliver(fixture("plain.eml"), `ann@${racer.name}`)));
    const raced = await Promise.all(copies.map((p) => runIngest(env, p, replayingStep(1).step)));
    expect(new Set(raced.map((r) => (r as { messageId: string }).messageId)).size).toBe(1);
    expect(await db.select().from(messages).where(eq(messages.addressId, racer.addressId))).toHaveLength(1);
    expect(await db.select().from(threads).where(eq(threads.addressId, racer.addressId))).toHaveLength(1);

    // A message without a Message-ID dedupes on its raw key.
    const anon = await deliver(fixture("no-message-id.eml"), `ann@${box.name}`);
    const a1 = await runIngest(env, anon, replayingStep(2).step);
    const a2 = await runIngest(env, anon, replayingStep(1).step);
    expect(a2).toEqual(a1);
    const [anonRow] = await db.select().from(messages).where(eq(messages.id, (a1 as { messageId: string }).messageId));
    expect(anonRow?.rfcMessageId).toBe(`syn:${anon.rawKey}`);
    expect(await db.select().from(messages).where(eq(messages.addressId, box.addressId))).toHaveLength(2);
  });

  it("a deeply nested MIME message is quarantined, not retried forever", async () => {
    const raw = fixture("deeply-nested.eml");
    const parsed = await parseMessage(raw);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toMatch(/nesting depth of 32/);

    const box = await domainWith();
    const params = await deliver(raw, `ann@${box.name}`);
    // Through the real Workflows binding: the instance completes instead of retrying the parse.
    const instance = await introspectWorkflowInstance(env.INGEST_WORKFLOW, params.rawKey);
    try {
      await env.INGEST_WORKFLOW.create({ id: params.rawKey, params });
      await instance.waitForStatus("complete");
      const output = (await instance.getOutput()) as { status: string; messageId: string; folder: string };
      expect(output).toMatchObject({ status: "stored", folder: "quarantine" });

      const { message, thread } = await threadOf(output.messageId);
      expect(thread.folder).toBe("quarantine");
      expect(thread.addressId).toBe(box.addressId);
      expect(message).toMatchObject({ rawMimeKey: params.rawKey, authenticated: false, fromEmail: "bounce@ext.test" });
      const body = await (await env.MAIL_STORE.get(bodyKeyFor(params.rawKey)))!.json<{ quarantine: { reason: string } }>();
      expect(body.quarantine.reason).toMatch(/nesting depth/);
      // The raw message stays in R2 for inspection.
      expect(await env.MAIL_STORE.head(params.rawKey)).not.toBeNull();
    } finally {
      await instance.dispose();
    }

    // Each step ran once: the parse failure is a result, not a thrown error to retry.
    const again = await deliver(raw, `ann@${box.name}`);
    const once = replayingStep(1);
    await runIngest(env, again, once.step);
    expect(once.calls.get("parse message")).toBe(1);
  });

  it("giant headers are rejected by the parser limits", async () => {
    const giant = `X-Giant: ${"a".repeat(70)}${"\r\n\t".concat("b".repeat(70)).repeat(4000)}\r\n`;
    const raw = new TextEncoder().encode(`${giant}From: big@ext.test\r\nSubject: big\r\nMessage-ID: <giant@ext.test>\r\n\r\nbody\r\n`);
    expect(raw.byteLength).toBeGreaterThan(MIME_LIMITS.maxHeadersSize);
    const parsed = await parseMessage(raw);
    expect(parsed).toEqual({ ok: false, reason: expect.stringMatching(/header size of 262144 bytes exceeded/) });

    // Many small headers hit the header-count limit instead.
    const many = await parseMessage(fixture("many-headers.eml"));
    expect(many).toEqual({ ok: false, reason: expect.stringMatching(/headers, over the 1000-header limit/) });
    // An ordinary message passes the same limits.
    expect((await parseMessage(fixture("plain.eml"))).ok).toBe(true);

    const box = await domainWith();
    const { result } = await ingest(raw, `ann@${box.name}`);
    expect(result).toMatchObject({ status: "stored", folder: "quarantine" });
  });

  it("trusts Cloudflare's authserv-id for authentication results", async () => {
    expect(CLOUDFLARE_AUTHSERV_ID).toBe("mx.cloudflare.net");
    const authenticated = async (name: string) => {
      const p = await parseMessage(fixture(name));
      if (!p.ok) throw new Error(p.reason);
      return p.mail.authenticated;
    };
    // Recorded from Cloudflare's own receiver in the email spike.
    expect(await authenticated("cloudflare-dmarc-pass.eml")).toBe(true);
    expect(await authenticated("plain.eml")).toBe(true);
    // A pass vouched for by anyone else, or a second header claiming Cloudflare's id, is not trusted.
    expect(await authenticated("spoofed-authserv.eml")).toBe(false);
    expect(await authenticated("forged-auth.eml")).toBe(false);
    expect(await authenticated("unauthenticated.eml")).toBe(false);

    const ar = (value: string) => ({ key: "authentication-results", value });
    expect(isAuthenticated([ar("mx.cloudflare.net; dkim=pass header.d=acme.test; dmarc=none")], "a@mail.acme.test")).toBe(true);
    expect(isAuthenticated([ar("mx.cloudflare.net; dkim=pass header.d=other.test; spf=pass")], "a@acme.test")).toBe(false);
    expect(isAuthenticated([ar("mx.cloudflare.net; dmarc=pass header.from=other.test")], "a@acme.test")).toBe(false);
    expect(isAuthenticated([ar("mx.cloudflare.net (dmarc=pass); dmarc=fail")], "a@acme.test")).toBe(false);
    expect(isAuthenticated([ar("mx.cloudflare.net.attacker.test; dmarc=pass")], "a@acme.test")).toBe(false);
    expect(isAuthenticated([], "a@acme.test")).toBe(false);
    // Two headers claiming Cloudflare's id: one is forged, so neither is believed.
    expect(isAuthenticated([ar("mx.cloudflare.net; dmarc=pass"), ar("mx.cloudflare.net; dmarc=pass")], "a@acme.test")).toBe(false);
    // Only the topmost header counts; an upstream relay's own result below it is ignored.
    expect(
      isAuthenticated([ar("MX.CLOUDFLARE.NET; DMARC=PASS header.from=acme.test"), ar("relay.example; dmarc=fail")], "a@acme.test"),
    ).toBe(true);
    expect(isAuthenticated([ar("relay.example; dmarc=fail"), ar("mx.cloudflare.net; dmarc=pass")], "a@acme.test")).toBe(false);

    const box = await domainWith();
    const { result } = await ingest(fixture("forged-auth.eml"), `ann@${box.name}`);
    const { message } = await threadOf((result as { messageId: string }).messageId);
    expect(message.authenticated).toBe(false);
  });

  it("routes to the right address and folder", async () => {
    const box = await domainWith();
    const stored = async (raw: string, to: string) => {
      const { result } = await ingest(fixture(raw), to);
      expect(result.status).toBe("stored");
      return threadOf((result as { messageId: string }).messageId);
    };

    // Exact address, +tag stripped, any case.
    const ann = await stored("plain.eml", `Ann+Board@${box.name.toUpperCase()}`);
    expect(ann.thread).toMatchObject({ addressId: box.addressId, folder: "inbox", counterpartyEmail: "ada@ext.test" });
    expect(ann.message).toMatchObject({ addressId: box.addressId, authenticated: true, fromName: "Ada Lovelace", ccEmails: ["grace@ext.test"] });

    // Unauthenticated mail: spam on a role address, inbox on a personal one.
    expect((await stored("unauthenticated.eml", `support@${box.name}`)).thread).toMatchObject({ addressId: box.support, folder: "spam" });
    expect((await stored("spoofed-authserv.eml", `ann@${box.name}`)).thread).toMatchObject({ addressId: box.addressId, folder: "inbox" });

    // A blocked sender lands in spam even when authenticated.
    await db.insert(blockedSenders).values({ id: id(), organizationId: box.orgId, email: "grace@ext.test", createdBy: "owner@example.test" });
    const blocked = await stored("attachment.eml", `ann@${box.name}`);
    expect(blocked.thread.folder).toBe("spam");
    const [att] = blocked.message.attachmentsMeta as { filename: string; r2Key: string; size: number }[];
    expect(att).toMatchObject({ filename: "notes.txt", r2Key: expect.stringMatching(/^att\/[0-9a-f]{64}$/) });
    expect(await (await env.MAIL_STORE.get(att!.r2Key))!.text()).toContain("Ship the ingest workflow");

    // Unknown local part on a hold domain: Unrouted, claimable per domain.
    const held = await stored("html-alternative.eml", `nobody@${box.name}`);
    expect(held.thread).toMatchObject({ addressId: null, domainId: box.domainId, originalRecipient: `nobody@${box.name}`, folder: "unrouted" });
    expect(held.message.dedupeScope).toBe(`held:nobody@${box.name}`);

    // catch_all delivers to the designated mailbox; unauthenticated catch-all mail is spam.
    const ca = await domainWith({ policy: "catch_all" });
    expect((await stored("plain.eml", `typo@${ca.name}`)).thread).toMatchObject({ addressId: ca.addressId, folder: "inbox" });
    expect((await stored("spoofed-authserv.eml", `typo@${ca.name}`)).thread).toMatchObject({ addressId: ca.addressId, folder: "spam" });

    // drop stores nothing, and neither does mail for a domain this install doesn't have.
    const drop = await domainWith({ policy: "drop" });
    expect((await ingest(fixture("plain.eml"), `ghost@${drop.name}`)).result).toEqual({ status: "dropped" });
    expect(await db.select().from(threads).where(and(eq(threads.domainId, drop.domainId), isNull(threads.addressId)))).toHaveLength(0);
    expect((await ingest(fixture("plain.eml"), `ann@${id()}.invalid`)).result).toEqual({ status: "unknown_domain" });
  });

  it("joins replies through the threading hook and indexes them for search", async () => {
    const box = await domainWith();
    const { result: first } = await ingest(fixture("plain.eml"), `ann@${box.name}`);
    const { result: reply } = await ingest(fixture("reply.eml"), `ann@${box.name}`);
    const root = await threadOf((first as { messageId: string }).messageId);
    const second = await threadOf((reply as { messageId: string }).messageId);
    expect(second.thread.id).toBe(root.thread.id);
    expect(second.thread.messageCount).toBe(2);
    expect(second.thread.snippet).toMatch(/^One more thing/);
    expect(second.message).toMatchObject({ inReplyTo: "<plain-1@ext.test>", references: "<plain-1@ext.test>", newParticipant: false });

    // The same Message-ID in another mailbox never threads across mailboxes.
    const other = await domainWith();
    const { result: elsewhere } = await ingest(fixture("reply.eml"), `ann@${other.name}`);
    expect((await threadOf((elsewhere as { messageId: string }).messageId)).thread.id).not.toBe(root.thread.id);

    // Decoded subject and body text are searchable.
    const { result: alt } = await ingest(fixture("html-alternative.eml"), `ann@${box.name}`);
    const altThread = (await threadOf((alt as { messageId: string }).messageId)).thread;
    expect(altThread.subject).toBe("Café menu for Friday");
    expect((await searchThreads(db, { query: "croissants", addressIds: [box.addressId] })).map((h) => h.threadId)).toEqual([altThread.id]);
    expect((await searchThreads(db, { query: "analytical engine", addressIds: [box.addressId] })).map((h) => h.threadId)).toEqual([root.thread.id]);

    // A custom resolver replaces the default rules.
    const seen: string[] = [];
    const resolver: ThreadResolver = async (_db, q) => {
      seen.push(q.subject);
      return { threadId: altThread.id };
    };
    const params = await deliver(fixture("attachment.eml"), `ann@${box.name}`);
    const hooked = await runIngest(env, params, replayingStep(1).step, resolver);
    expect(seen).toEqual(["Meeting notes"]);
    const joined = await threadOf((hooked as { messageId: string }).messageId);
    expect(joined.thread.id).toBe(altThread.id);
    // grace@ wasn't in that conversation, so she is flagged as a new participant.
    expect(joined.message.newParticipant).toBe(true);
    expect(joined.thread.participants).toContain("grace@ext.test");
  });
});
