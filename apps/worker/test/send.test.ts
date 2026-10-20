import { env } from "cloudflare:test";
import { fixture } from "./helpers/fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  addresses,
  appSettings,
  domains,
  messageEvents,
  messages,
  operationalEvents,
  suppressions,
  threads,
} from "@boxox/db";
import { createDb, type Db } from "../src/db";
import type { Env, SendParams } from "../src/env";
import { handleEmailEvents } from "../src/queues/cf-email-events";
import { queueOutbound } from "../src/services/outbound/queue";
import { runSend, type SendStep } from "../src/services/outbound/run";
import { BREAKER_MIN_SAMPLE } from "../src/services/outbound/safety";

/**
 * SendWorkflow and the cf-email-events consumer against a local D1 and R2
 * (workerd, via Miniflare) with the real migrations. The workflow engine and
 * the send_email binding are fakes that record what was called, in order.
 */
const ORG = "owner";

let DB: D1Database;
let MAIL_STORE: R2Bucket;
let db: Db;

beforeAll(() => {
  DB = env.DB;
  MAIL_STORE = env.MAIL_STORE;
  db = createDb({ DB });
});

beforeEach(async () => {
  // The breaker reads install-wide state; each test starts with it closed.
  await db.delete(messageEvents);
  await db.delete(appSettings);
});

const id = () => crypto.randomUUID();

async function seedAddress(domainName = `${id()}.test`, localPart = "me") {
  const domainId = id();
  await db.insert(domains).values({ id: domainId, organizationId: ORG, name: domainName, sendingEnabled: true });
  const addressId = id();
  await db.insert(addresses).values({ id: addressId, domainId, organizationId: ORG, localPart, createdBy: "owner" });
  return { domainId, address: { id: addressId, email: `${localPart}@${domainName}`, displayName: "Me" } };
}

/** An outbound message that has already been sent, as SendWorkflow leaves it. */
async function seedSent(addressId: string, fromEmail: string, sentMessageId: string, to: string[]) {
  const threadId = id();
  const messageId = id();
  await db.insert(threads).values({ id: threadId, organizationId: ORG, addressId, subject: "hello" });
  await db.insert(messages).values({
    id: messageId,
    threadId,
    organizationId: ORG,
    addressId,
    dedupeScope: addressId,
    direction: "outbound",
    fromEmail,
    toEmails: to,
    subject: "hello",
    r2Key: `sent/${ORG}/${messageId}.json`,
    sendStatus: "sent",
    sentMessageId,
    rfcMessageId: sentMessageId,
  });
  return messageId;
}

async function row(messageId: string) {
  const [r] = await db.select().from(messages).where(eq(messages.id, messageId));
  return r!;
}

async function events(messageId: string) {
  return db.select().from(messageEvents).where(eq(messageEvents.messageId, messageId));
}

/** Runs each step inline, as the Workflows engine would on a first run. */
function fakeStep(order: string[]) {
  const configs = new Map<string, unknown>();
  const sleepUntils: Date[] = [];
  const step = {
    async do(name: string, a: unknown, b?: unknown) {
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      if (typeof a !== "function") configs.set(name, a);
      order.push(`step:${name}`);
      return fn();
    },
    async sleep(name: string) {
      order.push(`sleep:${name}`);
    },
    async sleepUntil(name: string, at: Date | number) {
      order.push(`sleepUntil:${name}`);
      sleepUntils.push(new Date(at));
    },
  };
  return { step: step as unknown as SendStep, configs, sleepUntils };
}

function sendError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function fakeEmail(impl: (msg: Record<string, any>) => Promise<{ messageId: string }>) {
  const send = vi.fn(impl);
  return { send } as unknown as SendEmail & { send: typeof send };
}

function compose(address: { id: string; email: string; displayName: string | null }, to: string[]) {
  return {
    organizationId: ORG,
    address,
    threadId: null,
    to,
    cc: [],
    bcc: [],
    subject: "Quarterly numbers",
    text: "Numbers attached.",
    html: null,
    attachments: [{ filename: "q3.txt", content: btoa("revenue: up"), contentType: "text/plain" }],
    inReplyTo: null,
    references: null,
  };
}

/** A workflow binding that records instances without running them. */
function recordingWorkflow() {
  const created: { id: string; params: SendParams }[] = [];
  return {
    created,
    binding: {
      create: vi.fn(async (opts: { id: string; params: SendParams }) => {
        created.push(opts);
        return { id: opts.id };
      }),
    } as unknown as Workflow<SendParams>,
  };
}

function sendEnv(email: SendEmail, workflow: Workflow<SendParams>): Pick<Env, "DB" | "MAIL_STORE" | "EMAIL" | "SEND_WORKFLOW"> {
  return { DB, MAIL_STORE, EMAIL: email, SEND_WORKFLOW: workflow };
}

function batchOf(bodies: unknown[]) {
  const msgs = bodies.map((body, i) => ({
    id: `q${i}-${id()}`,
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return { batch: { queue: "cf-email-events", messages: msgs } as unknown as MessageBatch<unknown>, msgs };
}

function eventBody(type: "delivered" | "bounced", messageId: string, sender: string, recipient: string) {
  const body = structuredClone(fixture(type === "bounced" ? "event-bounced.json" : "event-delivered.json").body);
  body.payload.eventId = id();
  body.payload.messageId = messageId;
  body.payload.sender = sender;
  body.payload.recipient = recipient;
  body.metadata.eventTimestamp = new Date().toISOString();
  return body;
}

describe("SendWorkflow", () => {
  it("writes R2 and D1 before calling send", async () => {
    const { address } = await seedAddress();
    const order: string[] = [];
    const { step } = fakeStep(order);
    let seenAtSend: { status: string | null; body: unknown } | null = null;
    const email = fakeEmail(async (msg) => {
      order.push("send");
      const r = await row(msg.headers["X-Boxox-Message"]);
      const obj = await MAIL_STORE.get(r.r2Key);
      seenAtSend = { status: r.sendStatus, body: obj ? await obj.json() : null };
      return { messageId: "<sent-1@cf.test>" };
    });
    const workflow = {
      create: vi.fn(async (opts: { id: string; params: SendParams }) => {
        order.push("workflow.create");
        await runSend({ DB, MAIL_STORE, EMAIL: email }, opts.params, step);
        return { id: opts.id };
      }),
    } as unknown as Workflow<SendParams>;

    const result = await queueOutbound(sendEnv(email, workflow), compose(address, ["ann@example.com"]));

    expect(result.ok).toBe(true);
    expect(order.indexOf("workflow.create")).toBeLessThan(order.indexOf("send"));
    expect(email.send).toHaveBeenCalledTimes(1);
    // At the moment send() ran, the row and body were already durable.
    expect(seenAtSend).toEqual({
      status: "queued",
      body: {
        text: "Numbers attached.",
        html: null,
        attachments: [{ filename: "q3.txt", content: btoa("revenue: up"), contentType: "text/plain" }],
      },
    });
    const sent = email.send.mock.calls[0]![0];
    expect(sent.to).toEqual(["ann@example.com"]);
    expect(sent.headers["X-Boxox-Message"]).toBe(result.messageId);
    expect(new TextDecoder().decode(sent.attachments[0].content)).toBe("revenue: up");

    const after = await row(result.messageId);
    expect(after.sendStatus).toBe("sent");
    expect(after.sentMessageId).toBe("<sent-1@cf.test>");
    expect(after.rfcMessageId).toBe("<sent-1@cf.test>");
    expect(await db.query.threads.findFirst({ where: eq(threads.id, result.threadId) })).toMatchObject({ folder: "sent", unread: false });
    expect((await events(result.messageId)).map((e) => e.type)).toEqual(["sent"]);
  });

  it("sleeps until scheduled_at", async () => {
    const { address } = await seedAddress();
    const at = new Date(Date.now() + 3 * 3600 * 1000);
    const wf = recordingWorkflow();
    const email = fakeEmail(async () => ({ messageId: "<scheduled@cf.test>" }));

    const result = await queueOutbound(sendEnv(email, wf.binding), { ...compose(address, ["bo@example.com"]), scheduledAt: at });
    expect(result.ok && result.scheduled).toBe(true);
    expect(wf.created).toEqual([{ id: result.messageId, params: { messageId: result.messageId, scheduledAt: at.toISOString() } }]);
    const before = await row(result.messageId);
    expect(before.sendStatus).toBe("scheduled");
    expect(before.scheduledAt?.getTime()).toBe(at.getTime());
    expect((await events(result.messageId)).map((e) => e.type)).toEqual(["scheduled"]);

    const order: string[] = [];
    const { step, sleepUntils } = fakeStep(order);
    email.send.mockImplementation(async () => {
      order.push("send");
      return { messageId: "<scheduled@cf.test>" };
    });
    await runSend({ DB, MAIL_STORE, EMAIL: email }, wf.created[0]!.params, step);

    expect(sleepUntils.map((d) => d.getTime())).toEqual([at.getTime()]);
    expect(order[0]).toBe("sleepUntil:wait for scheduled time");
    expect(order.indexOf("sleepUntil:wait for scheduled time")).toBeLessThan(order.indexOf("send"));
    expect(email.send).toHaveBeenCalledTimes(1);
    expect((await row(result.messageId)).sendStatus).toBe("sent");
  });

  it("a canceled scheduled message is not sent when the sleep ends", async () => {
    const { address } = await seedAddress();
    const at = new Date(Date.now() + 3600 * 1000);
    const wf = recordingWorkflow();
    const email = fakeEmail(async () => ({ messageId: "<never@cf.test>" }));
    const result = await queueOutbound(sendEnv(email, wf.binding), { ...compose(address, ["cy@example.com"]), scheduledAt: at });
    await db.update(messages).set({ sendStatus: "canceled" }).where(eq(messages.id, result.messageId));

    const outcome = await runSend({ DB, MAIL_STORE, EMAIL: email }, wf.created[0]!.params, fakeStep([]).step);

    expect(outcome).toBe("canceled");
    expect(email.send).not.toHaveBeenCalled();
  });

  it("a permanent error marks the message failed without retry", async () => {
    const { address } = await seedAddress();
    const wf = recordingWorkflow();
    const recorded = fixture("send-error-sender-domain.json").error;
    const email = fakeEmail(async () => {
      throw sendError(recorded.code, recorded.message);
    });
    const result = await queueOutbound(sendEnv(email, wf.binding), compose(address, ["di@example.com"]));
    const order: string[] = [];
    const { step, configs } = fakeStep(order);

    const outcome = await runSend({ DB, MAIL_STORE, EMAIL: email }, wf.created[0]!.params, step);

    expect(outcome).toBe("failed");
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(order.filter((o) => o.startsWith("sleep"))).toEqual([]);
    expect(order.filter((o) => o.startsWith("step:send attempt"))).toEqual(["step:send attempt 1"]);
    expect(configs.get("send attempt 1")).toMatchObject({ retries: { limit: 0 } });
    const after = await row(result.messageId);
    expect(after.sendStatus).toBe("failed");
    expect(after.sendError).toContain("E_SENDER_DOMAIN_NOT_AVAILABLE");
    expect(after.sentMessageId).toBeNull();
    const [failed] = await events(result.messageId);
    expect(failed).toMatchObject({ type: "failed", detail: { reason: "permanent", attempts: 1 } });
  });

  it("an ambiguous error is not retried", async () => {
    const { address } = await seedAddress();
    const wf = recordingWorkflow();
    const email = fakeEmail(async () => {
      throw sendError("E_INTERNAL_SERVER_ERROR", "upstream reset");
    });
    const result = await queueOutbound(sendEnv(email, wf.binding), compose(address, ["ed@example.com"]));
    const order: string[] = [];

    const outcome = await runSend({ DB, MAIL_STORE, EMAIL: email }, wf.created[0]!.params, fakeStep(order).step);

    expect(outcome).toBe("unknown");
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(order.filter((o) => o.startsWith("step:send attempt"))).toEqual(["step:send attempt 1"]);
    expect(order.filter((o) => o.startsWith("sleep"))).toEqual([]);
    const after = await row(result.messageId);
    expect(after.sendStatus).toBe("failed");
    expect(after.sendError).toMatch(/^Delivery unknown: the message may have been sent/);
    expect(after.sendError).toContain("E_INTERNAL_SERVER_ERROR");

    // A step the engine kills mid-send (timeout) is ambiguous too, and never re-sent.
    const second = await queueOutbound(sendEnv(email, wf.binding), compose(address, ["fi@example.com"]));
    email.send.mockClear();
    const dying = fakeStep([]);
    const killed = {
      ...dying.step,
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name.startsWith("send attempt")) {
          await ((b ?? a) as () => Promise<unknown>)().catch(() => {});
          throw new Error("step timed out");
        }
        return (dying.step.do as any)(name, a, b);
      },
    } as unknown as SendStep;
    expect(await runSend({ DB, MAIL_STORE, EMAIL: email }, wf.created[1]!.params, killed)).toBe("unknown");
    expect(email.send).toHaveBeenCalledTimes(1);
    expect((await row(second.messageId)).sendError).toContain("step timed out");
  });

  it("a send step the engine runs again does not send twice", async () => {
    const { address } = await seedAddress();
    const wf = recordingWorkflow();
    let issued!: () => void;
    const firstIssued = new Promise<void>((resolve) => (issued = resolve));
    // The first send() goes out but its isolate dies before it returns.
    const email = fakeEmail(async () => {
      if (email.send.mock.calls.length === 1) {
        issued();
        return new Promise<never>(() => {});
      }
      return { messageId: "<twice@cf.test>" };
    });
    const result = await queueOutbound(sendEnv(email, wf.binding), compose(address, ["gu@example.com"]));
    const base = fakeStep([]);
    const replaying = {
      ...base.step,
      do: async (name: string, a: unknown, b?: unknown) => {
        const fn = (b ?? a) as () => Promise<unknown>;
        if (name.startsWith("send attempt")) {
          void fn();
          await firstIssued;
        }
        return fn();
      },
    } as unknown as SendStep;

    expect(await runSend({ DB, MAIL_STORE, EMAIL: email }, wf.created[0]!.params, replaying)).toBe("unknown");

    expect(email.send).toHaveBeenCalledTimes(1);
    const after = await row(result.messageId);
    expect(after.sendStatus).toBe("failed");
    expect(after.sendError).toMatch(/^Delivery unknown/);
  });

  it("retries a rate-limited send after backing off", async () => {
    const { address } = await seedAddress();
    const wf = recordingWorkflow();
    const email = fakeEmail(async () => {
      if (email.send.mock.calls.length === 1) throw sendError("E_RATE_LIMIT_EXCEEDED", "slow down");
      return { messageId: "<later@cf.test>" };
    });
    const result = await queueOutbound(sendEnv(email, wf.binding), compose(address, ["hu@example.com"]));
    const order: string[] = [];

    expect(await runSend({ DB, MAIL_STORE, EMAIL: email }, wf.created[0]!.params, fakeStep(order).step)).toBe("sent");

    expect(email.send).toHaveBeenCalledTimes(2);
    expect(order.filter((o) => o.startsWith("step:send") || o.startsWith("sleep:"))).toEqual([
      "step:send attempt 1",
      "sleep:back off after attempt 1",
      "step:send attempt 2",
    ]);
    expect((await row(result.messageId)).sendAttempts).toBe(2);
  });
});

describe("delivery events", () => {
  it("maps a recorded Cloudflare bounce event to bounced and suppresses the address", async () => {
    const recorded = fixture("event-bounced.json").body;
    const { domainId, address } = await seedAddress("boxox.dev", "spike");
    const messageId = await seedSent(address.id, address.email, recorded.payload.messageId, [recorded.payload.recipient]);
    const { batch, msgs } = batchOf([recorded]);

    await handleEmailEvents(batch, { DB });

    expect(msgs[0]!.ack).toHaveBeenCalled();
    expect((await row(messageId)).deliveryStatus).toBe("bounced");
    const recordedEvents = await events(messageId);
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]).toMatchObject({
      id: `cf:${recorded.payload.eventId}`,
      type: "bounced",
      recipient: "spike-reject@boxox.dev",
      detail: { bounceType: "hard", classification: "permanent_failure", smtpEnhancedStatusCode: "5.7.1" },
    });
    expect(recordedEvents[0]!.occurredAt.toISOString()).toBe(recorded.metadata.eventTimestamp);
    const supp = await db.select().from(suppressions).where(eq(suppressions.domainId, domainId));
    expect(supp).toMatchObject([{ email: "spike-reject@boxox.dev", reason: "bounce" }]);

    // Queue redelivery of the same event is deduplicated on Cloudflare's eventId.
    await handleEmailEvents(batchOf([recorded]).batch, { DB });
    expect(await events(messageId)).toHaveLength(1);

    // The next send to the suppressed address is refused without calling send().
    const wf = recordingWorkflow();
    const email = fakeEmail(async () => ({ messageId: "<x@cf.test>" }));
    const next = await queueOutbound(sendEnv(email, wf.binding), compose(address, ["Spike-Reject@boxox.dev"]));
    expect(await runSend({ DB, MAIL_STORE, EMAIL: email }, wf.created[0]!.params, fakeStep([]).step)).toBe("suppressed");
    expect(email.send).not.toHaveBeenCalled();
    const refused = await row(next.messageId);
    expect(refused.sendStatus).toBe("failed");
    expect(refused.sendError).toContain("suppression list");
    expect((await events(next.messageId)).map((e) => [e.type, e.recipient])).toEqual(
      expect.arrayContaining([["rejected", "spike-reject@boxox.dev"]]),
    );
  });

  it("tracks delivery per recipient and reports the worst outcome", async () => {
    const { address } = await seedAddress();
    const sentId = `<multi-${id()}@cf.test>`;
    const messageId = await seedSent(address.id, address.email, sentId, ["a@example.com", "b@example.com"]);
    const deferred = eventBody("delivered", sentId, address.email, "a@example.com");
    deferred.type = "cf.email.sending.message.deferred";
    deferred.metadata.eventTimestamp = new Date(Date.now() - 60_000).toISOString();

    await handleEmailEvents(batchOf([deferred]).batch, { DB });
    expect((await row(messageId)).deliveryStatus).toBe("deferred");

    await handleEmailEvents(
      batchOf([eventBody("delivered", sentId, address.email, "a@example.com"), eventBody("delivered", sentId, address.email, "b@example.com")]).batch,
      { DB },
    );
    expect((await row(messageId)).deliveryStatus).toBe("delivered");
    expect(await events(messageId)).toHaveLength(3);
  });

  it("pauses all sending when the bounce rate crosses the threshold", async () => {
    const { address } = await seedAddress();
    const sentId = `<bulk-${id()}@cf.test>`;
    const recipients = Array.from({ length: 40 }, (_, i) => `r${i}@example.com`);
    await seedSent(address.id, address.email, sentId, recipients);
    const paused = async () =>
      (await db.select().from(appSettings).where(eq(appSettings.id, 1)))[0]?.sendingPausedAt ?? null;

    // 1 bounce in 31 outcomes (3%) is under the 5% threshold.
    const healthy = [
      ...recipients.slice(0, 30).map((r) => eventBody("delivered", sentId, address.email, r)),
      eventBody("bounced", sentId, address.email, recipients[30]!),
    ];
    expect(healthy.length).toBeGreaterThanOrEqual(BREAKER_MIN_SAMPLE);
    await handleEmailEvents(batchOf(healthy).batch, { DB });
    expect(await paused()).toBeNull();

    // 3 in 33 (9%) trips it.
    await handleEmailEvents(
      batchOf(recipients.slice(31, 33).map((r) => eventBody("bounced", sentId, address.email, r))).batch,
      { DB },
    );
    expect(await paused()).toBeInstanceOf(Date);
    const [settings] = await db.select().from(appSettings);
    expect(settings!.sendingPausedReason).toMatch(/^Bounce rate 9\.1%/);
    const alerts = await db
      .select()
      .from(operationalEvents)
      .where(and(eq(operationalEvents.kind, "sending_paused"), eq(operationalEvents.level, "error")));
    expect(alerts.length).toBeGreaterThan(0);

    // While paused, nothing is sent, even to recipients that never bounced.
    const wf = recordingWorkflow();
    const email = fakeEmail(async () => ({ messageId: "<blocked@cf.test>" }));
    const next = await queueOutbound(sendEnv(email, wf.binding), compose(address, ["fresh@example.com"]));
    expect(await runSend({ DB, MAIL_STORE, EMAIL: email }, wf.created[0]!.params, fakeStep([]).step)).toBe("paused");
    expect(email.send).not.toHaveBeenCalled();
    const held = await row(next.messageId);
    expect(held.sendStatus).toBe("failed");
    expect(held.sendError).toMatch(/^Sending is paused: Bounce rate/);
    const n = await db.select({ n: sql<number>`count(*)` }).from(suppressions);
    expect(Number(n[0]!.n)).toBeGreaterThanOrEqual(3);
  });
});
