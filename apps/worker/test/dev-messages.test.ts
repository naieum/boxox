import { env } from "cloudflare:test";
import { fixture } from "./helpers/fixtures";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { apiMessages, domains, idempotencyKeys } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import type { DevContext } from "../src/dev/auth";
import { createDomainKey } from "../src/dev/keys";
import { runApiSend, type ApiSendStep } from "../src/dev/messages";
import { devMessageRoutes } from "../src/dev/messages-routes";
import type { SendParams } from "../src/env";
import { handleEmailEvents } from "../src/queues/cf-email-events";

/**
 * /dev/v1/messages against a local D1 and R2 (workerd, via Miniflare) with the
 * real migrations. The Workflows binding and send_email are fakes that record
 * what was called.
 */
const ORG = "owner";
const OWNER = { type: "owner" as const, email: "owner@example.test" };

let DB: D1Database;
let MAIL_STORE: R2Bucket;
let db: Db;

beforeAll(() => {
  DB = env.DB;
  MAIL_STORE = env.MAIL_STORE;
  db = createDb({ DB });
});

/** Records instances; `hold()` makes the next create() wait until released. */
function fakeWorkflow() {
  const created: { id: string; params: SendParams }[] = [];
  const terminated: string[] = [];
  let held: { started: () => void; release: Promise<void> } | null = null;
  const binding = {
    async create(opts: { id: string; params: SendParams }) {
      if (held) {
        const h = held;
        held = null;
        h.started();
        await h.release;
      }
      created.push(opts);
      return { id: opts.id };
    },
    async get(id: string) {
      return { id, terminate: async () => void terminated.push(id) };
    },
  };
  return {
    created,
    terminated,
    binding: binding as unknown as Workflow<SendParams>,
    hold() {
      let started!: () => void;
      let release!: () => void;
      const startedP = new Promise<void>((r) => (started = r));
      held = { started, release: new Promise<void>((r) => (release = r)) };
      return { started: startedP, release };
    },
  };
}

function fakeStep() {
  const sleepUntils: Date[] = [];
  const step = {
    async do(_name: string, a: unknown, b?: unknown) {
      return ((typeof a === "function" ? a : b) as () => Promise<unknown>)();
    },
    async sleep() {},
    async sleepUntil(_name: string, at: Date | number) {
      sleepUntils.push(new Date(at));
    },
  };
  return { step: step as unknown as ApiSendStep, sleepUntils };
}

const app = new Hono<DevContext>()
  .use("*", async (c, next) => {
    c.set("db", db);
    await next();
  })
  .route("/dev/v1/messages", devMessageRoutes);

async function seedDomain() {
  const domainId = crypto.randomUUID();
  const name = `${domainId.slice(0, 8)}.test`;
  await db.insert(domains).values({ id: domainId, organizationId: ORG, name, sendingEnabled: true });
  return { id: domainId, name };
}

async function domainKey(domainId: string, permissions = ["send", "read_log"], caps: { dailySendCap?: number; rateLimitPerMinute?: number } = {}) {
  const created = await createDomainKey(db, ORG, OWNER, {
    name: "app",
    domainId,
    permissions: permissions as ("send" | "read_log")[],
    ...caps,
  });
  return created.secret;
}

function call(
  wf: ReturnType<typeof fakeWorkflow>,
  method: string,
  path: string,
  opts: { key: string; body?: unknown; idem?: string },
) {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${opts.key}` };
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  return app.request(
    path,
    { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
    { DB, MAIL_STORE, SEND_WORKFLOW: wf.binding },
  );
}

async function rowsFor(domainId: string) {
  return db.select().from(apiMessages).where(eq(apiMessages.domainId, domainId));
}

const message = (domain: string, extra: Record<string, unknown> = {}) => ({
  from: `App <noreply@${domain}>`,
  to: "person@example.com",
  subject: "Welcome",
  html: "<p>Hello <b>there</b></p>",
  tags: { kind: "welcome" },
  ...extra,
});

describe("dev messages", () => {
  it("parallel sends cannot overrun per-key caps or partially commit a batch", async () => {
    for (const caps of [{ dailySendCap: 1 }, { rateLimitPerMinute: 1 }]) {
      const d = await seedDomain();
      const key = await domainKey(d.id, ["send"], caps);
      const wf = fakeWorkflow();
      const replies = await Promise.all(Array.from({ length: 4 }, () => call(wf, "POST", "/dev/v1/messages", { key, body: message(d.name) })));
      expect(replies.map((r) => r.status).sort()).toEqual([202, 429, 429, 429]);
      expect(await rowsFor(d.id)).toHaveLength(1);
      expect(wf.created).toHaveLength(1);
    }
  });

  it("a racing batch rolls back all rows when only part would fit the cap", async () => {
    const d = await seedDomain();
    const key = await domainKey(d.id, ["send"], { dailySendCap: 3 });
    const wf = fakeWorkflow();
    const send = () => call(wf, "POST", "/dev/v1/messages/batch", { key, body: { mode: "all_or_nothing", messages: [message(d.name), message(d.name)] } });
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 429]);
    expect(await rowsFor(d.id)).toHaveLength(2);
    expect(wf.created).toHaveLength(2);
  });

  it("same idempotency key and body returns the original response", async () => {
    const d = await seedDomain();
    const key = await domainKey(d.id);
    const wf = fakeWorkflow();

    const first = await call(wf, "POST", "/dev/v1/messages", { key, body: message(d.name), idem: "order-1" });
    expect(first.status).toBe(202);
    const original = (await first.json()) as { id: string; status: string };
    expect(original.status).toBe("queued");

    const again = await call(wf, "POST", "/dev/v1/messages", { key, body: message(d.name), idem: "order-1" });
    expect(again.status).toBe(202);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual(original);

    expect(await rowsFor(d.id)).toHaveLength(1);
    expect(wf.created).toEqual([{ id: original.id, params: { kind: "api", messageId: original.id } }]);

    const [stored] = await rowsFor(d.id);
    expect(stored).toMatchObject({ fromEmail: `App <noreply@${d.name}>`, toEmails: ["person@example.com"], status: "queued" });
    const body = (await (await MAIL_STORE.get(stored!.r2Key))!.json()) as { text: string };
    expect(body.text).toBe("Hello there");

    // Another key's identical Idempotency-Key is its own namespace.
    const other = await domainKey(d.id);
    const third = await call(wf, "POST", "/dev/v1/messages", { key: other, body: message(d.name), idem: "order-1" });
    expect(third.status).toBe(202);
    expect(((await third.json()) as { id: string }).id).not.toBe(original.id);
  });

  it("same key with a different body returns 409", async () => {
    const d = await seedDomain();
    const key = await domainKey(d.id);
    const wf = fakeWorkflow();

    const first = await call(wf, "POST", "/dev/v1/messages", { key, body: message(d.name), idem: "k-409" });
    expect(first.status).toBe(202);

    const changed = await call(wf, "POST", "/dev/v1/messages", {
      key,
      body: message(d.name, { subject: "Different" }),
      idem: "k-409",
    });
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { error: { code: string } }).error.code).toBe("idempotency_key_reused");

    // The same key on the batch route is a different request too.
    const onBatch = await call(wf, "POST", "/dev/v1/messages/batch", {
      key,
      body: { messages: [message(d.name)] },
      idem: "k-409",
    });
    expect(onBatch.status).toBe(409);

    expect(await rowsFor(d.id)).toHaveLength(1);
    expect(wf.created).toHaveLength(1);
  });

  it("concurrent duplicates get 409", async () => {
    const d = await seedDomain();
    const key = await domainKey(d.id);
    const wf = fakeWorkflow();
    const gate = wf.hold();

    // The first request is stopped mid-flight, after its row is written.
    const firstP = call(wf, "POST", "/dev/v1/messages", { key, body: message(d.name), idem: "race" });
    await gate.started;
    const [stored] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, "race"));
    expect(stored?.status).toBe("in_progress");

    const dupes = await Promise.all(
      [1, 2, 3].map(() => call(wf, "POST", "/dev/v1/messages", { key, body: message(d.name), idem: "race" })),
    );
    for (const dupe of dupes) {
      expect(dupe.status).toBe(409);
      expect(((await dupe.json()) as { error: { code: string } }).error.code).toBe("idempotency_in_progress");
    }

    gate.release();
    const first = await firstP;
    expect(first.status).toBe(202);
    const { id } = (await first.json()) as { id: string };

    const after = await call(wf, "POST", "/dev/v1/messages", { key, body: message(d.name), idem: "race" });
    expect(after.status).toBe(202);
    expect(((await after.json()) as { id: string }).id).toBe(id);
    expect(await rowsFor(d.id)).toHaveLength(1);
    expect(wf.created).toHaveLength(1);
  });

  it("partial batch mode reports per-message errors", async () => {
    const d = await seedDomain();
    const elsewhere = await seedDomain();
    const key = await domainKey(d.id);
    const wf = fakeWorkflow();
    const messages = [
      message(d.name, { to: ["a@example.com", "b@example.com"] }),
      message(elsewhere.name),
      message(d.name, { to: "not-an-address" }),
      message(d.name, { sendAt: new Date(Date.now() + 3600_000).toISOString() }),
      message(d.name, { headers: { "Message-ID": "<x@y>" } }),
    ];

    const strict = await call(wf, "POST", "/dev/v1/messages/batch", { key, body: { messages } });
    expect(strict.status).toBe(422);
    const strictBody = (await strict.json()) as { error: { code: string }; errors: { index: number }[] };
    expect(strictBody.error.code).toBe("batch_rejected");
    expect(strictBody.errors.map((e) => e.index)).toEqual([1, 2, 4]);
    expect(await rowsFor(d.id)).toHaveLength(0);
    expect(wf.created).toHaveLength(0);

    const partial = await call(wf, "POST", "/dev/v1/messages/batch", { key, body: { mode: "partial", messages } });
    expect(partial.status).toBe(202);
    const body = (await partial.json()) as {
      data: { index: number; id: string; status: string }[];
      errors: { index: number; code: string; param?: string }[];
    };
    expect(body.data.map((r) => [r.index, r.status])).toEqual([
      [0, "queued"],
      [3, "scheduled"],
    ]);
    expect(body.errors).toEqual([
      expect.objectContaining({ index: 1, code: "from_not_allowed", param: "from" }),
      expect.objectContaining({ index: 2, code: "bad_request", param: "to" }),
      expect.objectContaining({ index: 4, code: "header_not_allowed", param: "headers.Message-ID" }),
    ]);
    const rows = await rowsFor(d.id);
    expect(rows.map((r) => r.id).sort()).toEqual(body.data.map((r) => r.id).sort());
    expect(wf.created.map((c) => c.params.messageId).sort()).toEqual(body.data.map((r) => r.id).sort());
    expect(await rowsFor(elsewhere.id)).toHaveLength(0);
  });

  it("a domain key cannot send from another domain", async () => {
    const app1 = await seedDomain();
    const app2 = await seedDomain();
    const key1 = await domainKey(app1.id);
    const key2 = await domainKey(app2.id);
    const wf = fakeWorkflow();

    for (const from of [`noreply@${app2.name}`, `App <noreply@${app2.name}>`, `noreply@sub.${app1.name}`]) {
      const res = await call(wf, "POST", "/dev/v1/messages", { key: key1, body: message(app1.name, { from }) });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string; param: string } }).error).toMatchObject({
        code: "from_not_allowed",
        param: "from",
      });
    }
    expect(await rowsFor(app2.id)).toHaveLength(0);
    expect(wf.created).toHaveLength(0);

    // app2's own messages are invisible and untouchable with app1's key.
    const sendAt = new Date(Date.now() + 3600_000).toISOString();
    const own = await call(wf, "POST", "/dev/v1/messages", { key: key2, body: message(app2.name, { sendAt }) });
    const { id } = (await own.json()) as { id: string };
    expect((await call(wf, "GET", `/dev/v1/messages/${id}`, { key: key1 })).status).toBe(404);
    expect((await call(wf, "POST", `/dev/v1/messages/${id}/cancel`, { key: key1 })).status).toBe(404);
    expect((await call(wf, "PATCH", `/dev/v1/messages/${id}`, { key: key1, body: { sendAt } })).status).toBe(404);
    const list = (await (await call(wf, "GET", "/dev/v1/messages", { key: key1 })).json()) as { data: unknown[] };
    expect(list.data).toHaveLength(0);
    const [row] = await db.select().from(apiMessages).where(eq(apiMessages.id, id));
    expect(row?.status).toBe("scheduled");

    // A key without `send` can't send even from its own domain.
    const readOnly = await domainKey(app1.id, ["read_log"]);
    const denied = await call(wf, "POST", "/dev/v1/messages", { key: readOnly, body: message(app1.name) });
    expect(denied.status).toBe(403);
  });

  it("the log shows a status timeline", async () => {
    const d = await seedDomain();
    const key = await domainKey(d.id);
    const wf = fakeWorkflow();
    const at1 = new Date(Date.now() + 3600_000);
    const at2 = new Date(Date.now() + 7200_000);

    const res = await call(wf, "POST", "/dev/v1/messages", {
      key,
      body: message(d.name, { to: "spike-inbox2@boxox.dev", sendAt: at1.toISOString(), tags: { kind: "receipt" } }),
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const firstInstance = wf.created[0]!;
    expect(firstInstance.id).toBe(`${id}-${at1.getTime()}`);

    // Reschedule: the old instance is terminated and a new one sleeps until the new time.
    const moved = await call(wf, "PATCH", `/dev/v1/messages/${id}`, { key, body: { sendAt: at2.toISOString() } });
    expect(moved.status).toBe(200);
    expect(wf.terminated).toEqual([firstInstance.id]);
    const secondInstance = wf.created[1]!;
    expect(secondInstance).toEqual({ id: `${id}-${at2.getTime()}`, params: { kind: "api", messageId: id, scheduledAt: at2.toISOString() } });

    const recorded = fixture("event-delivered.json").body;
    const email = { send: vi.fn(async (_msg: EmailMessageBuilder) => ({ messageId: recorded.payload.messageId as string })) };
    const env = { DB, MAIL_STORE, EMAIL: email as unknown as SendEmail };

    // An instance left over from the old schedule wakes and does nothing.
    expect(await runApiSend(env, firstInstance.params, fakeStep().step)).toBe("rescheduled");
    expect(email.send).not.toHaveBeenCalled();

    const run = fakeStep();
    expect(await runApiSend(env, secondInstance.params, run.step)).toBe("sent");
    expect(run.sleepUntils).toEqual([at2]);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0]![0]).toMatchObject({
      from: { name: "App", email: `noreply@${d.name}` },
      to: ["spike-inbox2@boxox.dev"],
      subject: "Welcome",
      html: "<p>Hello <b>there</b></p>",
      text: "Hello there",
    });

    // The recorded event, as it would arrive just after this send.
    recorded.metadata.eventTimestamp = new Date().toISOString();
    const ack = vi.fn();
    await handleEmailEvents(
      { messages: [{ id: "q1", body: recorded, ack, retry: vi.fn() }] } as unknown as MessageBatch<unknown>,
      { DB },
    );
    expect(ack).toHaveBeenCalled();

    const got = await call(wf, "GET", `/dev/v1/messages/${id}`, { key });
    expect(got.status).toBe(200);
    const detail = (await got.json()) as {
      status: string;
      sentMessageId: string;
      timeline: { type: string; recipient: string | null; detail: Record<string, unknown> | null }[];
      body: { html: string; text: string };
    };
    expect(detail.status).toBe("delivered");
    expect(detail.sentMessageId).toBe(recorded.payload.messageId);
    expect(detail.timeline.map((e) => e.type)).toEqual(["queued", "scheduled", "scheduled", "sent", "delivered"]);
    expect(detail.timeline[1]!.detail).toEqual({ scheduledAt: at1.toISOString() });
    expect(detail.timeline[2]!.detail).toEqual({ scheduledAt: at2.toISOString(), previous: at1.toISOString() });
    expect(detail.timeline[4]!.recipient).toBe("spike-inbox2@boxox.dev");
    expect(detail.body).toMatchObject({ html: "<p>Hello <b>there</b></p>", text: "Hello there" });

    // A sent message can no longer be canceled; a scheduled one can.
    expect((await call(wf, "POST", `/dev/v1/messages/${id}/cancel`, { key })).status).toBe(409);
    const later = await call(wf, "POST", "/dev/v1/messages", {
      key,
      body: message(d.name, { to: "other@example.com", sendAt: at1.toISOString() }),
    });
    const laterId = ((await later.json()) as { id: string }).id;
    const canceled = await call(wf, "POST", `/dev/v1/messages/${laterId}/cancel`, { key });
    expect(canceled.status).toBe(200);
    expect(wf.terminated).toContain(`${laterId}-${at1.getTime()}`);
    expect(await runApiSend(env, wf.created.at(-1)!.params, fakeStep().step)).toBe("canceled");
    expect(email.send).toHaveBeenCalledTimes(1);
    const canceledDetail = (await (await call(wf, "GET", `/dev/v1/messages/${laterId}`, { key })).json()) as {
      timeline: { type: string }[];
    };
    expect(canceledDetail.timeline.map((e) => e.type)).toEqual(["queued", "scheduled", "canceled"]);

    // The list filters by status, tag and recipient, newest first, with a cursor.
    const list = async (q: string) =>
      ((await (await call(wf, "GET", `/dev/v1/messages?${q}`, { key })).json()) as {
        data: { id: string }[];
        nextCursor: string | null;
      });
    expect((await list("status=delivered")).data.map((m) => m.id)).toEqual([id]);
    expect((await list("tag=kind:receipt")).data.map((m) => m.id)).toEqual([id]);
    expect((await list("recipient=other@example.com")).data.map((m) => m.id)).toEqual([laterId]);
    const page1 = await list("limit=1");
    expect(page1.data.map((m) => m.id)).toEqual([laterId]);
    const page2 = await list(`limit=1&cursor=${page1.nextCursor}`);
    expect(page2.data.map((m) => m.id)).toEqual([id]);
    expect(page2.nextCursor).toBeNull();
  });
});
