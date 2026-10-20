import { env, introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addressGrants, addresses, messages } from "@boxox/db";
import { createDb } from "../src/db";
import { notifyDeliveryStatus, notifyNewMessage, type HubEvent } from "../src/do/mailbox-hub";
import { inboundRawKey } from "../src/email";
import { id, messageRow, seedMailbox, seedThread } from "./helpers/seed";

/**
 * MailboxHub on the real Durable Object binding: clients connect over
 * hibernatable WebSockets the way the /realtime route forwards them, and
 * pushes come from the real IngestWorkflow and the notify helpers.
 */
const db = createDb(env);
const eml = import.meta.glob<string>("./fixtures/eml/plain.eml", { eager: true, import: "default", query: "?raw" });
const hub = () => env.MAILBOX_HUB.get(env.MAILBOX_HUB.idFromName("install"));

interface Client {
  ws: WebSocket;
  received: HubEvent[];
  next(): Promise<HubEvent>;
}

const open: WebSocket[] = [];
afterEach(() => {
  for (const ws of open.splice(0)) ws.close(1000, "done");
});

async function connect(email: string, opts: { admin?: boolean } = {}): Promise<Client> {
  const headers: Record<string, string> = { Upgrade: "websocket", "x-boxox-hub-user": email };
  if (opts.admin) headers["x-boxox-hub-admin"] = "1";
  const res = await hub().fetch("https://hub.internal/", { headers });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  open.push(ws);
  const received: HubEvent[] = [];
  const waiting: ((e: HubEvent) => void)[] = [];
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const event = JSON.parse(e.data as string) as HubEvent;
    received.push(event);
    waiting.shift()?.(event);
  });
  let read = 0;
  return {
    ws,
    received,
    next() {
      const i = read++;
      if (received[i]) return Promise.resolve(received[i]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no push for ${email}`)), 5_000);
        waiting.push((e) => {
          clearTimeout(timer);
          resolve(e);
        });
      });
    },
  };
}

async function grant(addressId: string, orgId: string, who: { email?: string; invite?: string }, permissions = ["read"]) {
  await db.insert(addressGrants).values({
    id: id(),
    addressId,
    organizationId: orgId,
    principalType: "user",
    principalId: who.email ?? null,
    inviteEmail: who.invite ?? null,
    permissions,
    createdBy: "owner@example.test",
  });
}

async function mailbox(localPart = "ann") {
  const orgId = `org-${id()}`;
  const domain = `${id()}.test`;
  const box = await seedMailbox(db, { orgId, domain, localPart });
  await db.update(addresses).set({ kind: "personal" }).where(eq(addresses.id, box.addressId));
  return { ...box, domain };
}

async function storedMessage(box: { orgId: string; addressId: string }) {
  const threadId = await seedThread(db, box);
  const row = messageRow(box, threadId);
  await db.insert(messages).values(row);
  return { threadId, messageId: row.id };
}

describe("MailboxHub", () => {
  it("pushes a new message to a connected client", async () => {
    const box = await mailbox();
    await grant(box.addressId, box.orgId, { email: "ann@people.test" });
    const ann = await connect("ANN@people.test");

    const receivedAt = new Date();
    const rawKey = inboundRawKey(receivedAt);
    const raw = new TextEncoder().encode(eml["./fixtures/eml/plain.eml"]!);
    await env.MAIL_STORE.put(rawKey, raw, { customMetadata: { to: `ann@${box.domain}`, from: "bounce@ext.test" } });

    // Through the real Workflows binding, as email() starts it.
    const instance = await introspectWorkflowInstance(env.INGEST_WORKFLOW, rawKey);
    try {
      await env.INGEST_WORKFLOW.create({ id: rawKey, params: { rawKey, receivedAt: receivedAt.toISOString() } });
      await instance.waitForStatus("complete");
      const output = (await instance.getOutput()) as { status: string; messageId: string; threadId: string; folder: string };
      expect(output.status).toBe("stored");

      const event = await ann.next();
      expect(event).toEqual({
        type: "message.new",
        addressId: box.addressId,
        threadId: output.threadId,
        messageId: output.messageId,
        folder: output.folder,
      });
      // Ids only: the subject and body never cross the socket.
      expect(JSON.stringify(ann.received)).not.toMatch(/Quarterly|Lovelace|Hi Ann/);
    } finally {
      await instance.dispose();
    }

    // Delivery status of a sent message reaches the same client.
    const sent = await storedMessage(box);
    await db
      .update(messages)
      .set({ direction: "outbound", sentMessageId: "cf-sent-1", deliveryStatus: "delivered" })
      .where(eq(messages.id, sent.messageId));
    await notifyDeliveryStatus(env, db, "cf-sent-1");
    expect(await ann.next()).toEqual({
      type: "message.status",
      addressId: box.addressId,
      threadId: sent.threadId,
      messageId: sent.messageId,
      deliveryStatus: "delivered",
    });
  });

  it("only pushes to users with a grant on the address", async () => {
    const a = await mailbox("a");
    const b = await mailbox("b");
    await grant(a.addressId, a.orgId, { email: "alice@people.test" });
    await grant(a.addressId, a.orgId, { invite: "ivy@people.test" });
    await grant(a.addressId, a.orgId, { email: "sam@people.test" }, ["send"]);
    await grant(b.addressId, b.orgId, { email: "bob@people.test" });

    const owner = await connect("owner@people.test", { admin: true });
    const alice = await connect("alice@people.test");
    const ivy = await connect("ivy@people.test");
    const sam = await connect("sam@people.test");
    const bob = await connect("bob@people.test");
    const stranger = await connect("eve@people.test");

    const onA = await storedMessage(a);
    await notifyNewMessage(env, db, onA.messageId, "inbox");
    for (const c of [owner, alice, ivy]) {
      expect(await c.next()).toMatchObject({ type: "message.new", addressId: a.addressId, messageId: onA.messageId });
    }

    // A push on B proves the others' sockets were live: B is the first thing Bob sees.
    const onB = await storedMessage(b);
    expect(await hub().broadcast({ type: "message.new", addressId: b.addressId, threadId: onB.threadId, messageId: onB.messageId, folder: "inbox" })).toBe(2);
    expect(await bob.next()).toMatchObject({ addressId: b.addressId, messageId: onB.messageId });
    expect(await owner.next()).toMatchObject({ addressId: b.addressId });
    expect(bob.received).toHaveLength(1);
    expect(sam.received).toHaveLength(0);
    expect(stranger.received).toHaveLength(0);
    expect(alice.received).toHaveLength(1);

    // Unrouted mail has no address, so only admins hear about it.
    expect(await hub().broadcast({ type: "message.new", addressId: null, threadId: "t-unrouted", messageId: "m-unrouted", folder: "unrouted" })).toBe(1);
    expect(await owner.next()).toMatchObject({ messageId: "m-unrouted" });

    // A revoked grant stops the very next push.
    await db.delete(addressGrants).where(eq(addressGrants.principalId, "alice@people.test"));
    expect(await hub().broadcast({ type: "message.new", addressId: a.addressId, threadId: onA.threadId, messageId: "m-after", folder: "inbox" })).toBe(2);
    expect(await ivy.next()).toMatchObject({ messageId: "m-after" });
    expect(alice.received.map((e) => e.messageId)).toEqual([onA.messageId]);
  });

  it("refuses non-WebSocket requests and sockets without a user", async () => {
    expect((await hub().fetch("https://hub.internal/")).status).toBe(426);
    expect((await hub().fetch("https://hub.internal/", { headers: { Upgrade: "websocket" } })).status).toBe(400);
  });

  it("answers keepalive pings", async () => {
    const c = await connect("ping@people.test");
    const pong = new Promise<string>((resolve) => c.ws.addEventListener("message", (e) => resolve(e.data as string), { once: true }));
    c.ws.send("ping");
    expect(await pong).toBe("pong");
  });
});
