import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditEvents, domains, appSettings } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import {
  keyCoversDomain,
  keyMayReadAddress,
  keyMaySendFrom,
  requireApiKey,
  requireDomainKey,
  type DevContext,
} from "../src/dev/auth";
import { authenticateSecret, hashSecret } from "../src/dev/keys";
import { devKeyRoutes, ownerKeyRoutes } from "../src/dev/keys-routes";
import { devMessageRoutes } from "../src/dev/messages-routes";
import { runApiSend, type ApiSendStep } from "../src/dev/messages";
import { handleEmailEvents } from "../src/queues/cf-email-events";
import { fixture } from "./helpers/fixtures";
import type { Env } from "../src/env";
import { createAccessMiddleware } from "../src/middleware";

const ORG = "owner";
const OWNER = "owner@example.test";

let db: Db;

beforeAll(() => {
  db = createDb({ DB: env.DB });
});

/**
 * The real key routes, plus stand-ins for the mail routes guarded the way
 * later phases guard them: requireApiKey + requireDomainKey + domain checks.
 */
const app = new Hono<DevContext>()
  .use("*", async (c, next) => {
    c.set("db", db);
    c.set("user", { id: OWNER, email: OWNER, name: "Owner", role: "owner" });
    await next();
  })
  .route("/dev/v1/keys", devKeyRoutes)
  .post("/dev/v1/messages", requireApiKey, requireDomainKey("send"), async (c) => {
    const { from } = await c.req.json<{ from: string }>();
    if (!keyMaySendFrom(c.get("apiKey"), from)) {
      return c.json({ error: { code: "forbidden", message: "From is not allowed", param: "from" } }, 403);
    }
    return c.json({ id: "msg_1" }, 202);
  })
  .get("/dev/v1/messages", requireApiKey, requireDomainKey("read_log"), (c) => c.json({ data: [] }))
  .get("/dev/v1/received", requireApiKey, requireDomainKey("read_received"), (c) => c.json({ data: [] }))
  .route(`/api/orgs/:orgId/dev/keys`, ownerKeyRoutes);

const id = () => crypto.randomUUID();

async function seedDomain() {
  const domainId = id();
  const name = `${domainId.slice(0, 8)}.test`;
  await db.insert(domains).values({ id: domainId, organizationId: ORG, name });
  return { id: domainId, name };
}

function call(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  return app.request(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

interface Created {
  key: { id: string; display: string; dailySendCap: number | null; permissions: string[] };
  secret: string;
}

async function ownerManagementKey(
  grants: { domainId: string; grantablePermissions: string[]; dailySendBudget?: number }[],
): Promise<Created> {
  const res = await call("POST", `/api/orgs/${ORG}/dev/keys/management`, { body: { name: "ci", domains: grants } });
  expect(res.status).toBe(201);
  return res.json();
}

async function ownerDomainKey(domainId: string, permissions: string[], extra: Record<string, unknown> = {}): Promise<Created> {
  const res = await call("POST", `/api/orgs/${ORG}/dev/keys/domain`, {
    body: { name: "app", domainId, permissions, ...extra },
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function mintChild(mgmt: string, domain: string, body: Record<string, unknown>) {
  return call("POST", "/dev/v1/keys", { key: mgmt, body: { name: "child", domain, ...body } });
}

async function managementKeyCount() {
  const rows = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.kind, "management"));
  return rows.length;
}

describe("dev keys", () => {
  it("a management key cannot be created through the API", async () => {
    const d = await seedDomain();
    const mgmt = await ownerManagementKey([{ domainId: d.id, grantablePermissions: ["send"] }]);
    const domainKey = await ownerDomainKey(d.id, ["send"]);
    const before = await managementKeyCount();

    for (const key of [mgmt.secret, domainKey.secret]) {
      const res = await mintChild(key, d.name, { kind: "management", permissions: ["send"] });
      expect(res.status).toBe(403);
    }
    const asMgmt = await mintChild(mgmt.secret, d.name, { kind: "management", permissions: ["send"] });
    expect(((await asMgmt.json()) as { error: { param: string } }).error.param).toBe("kind");

    // The owner-only route is not reachable with an API key on /dev/v1…
    const viaDev = await call("POST", "/dev/v1/keys/management", {
      key: mgmt.secret,
      body: { name: "x", domains: [{ domainId: d.id, grantablePermissions: ["send"] }] },
    });
    expect(viaDev.status).toBe(404);

    // …and behind Access a bearer key is not a session: fails closed without Access, 401 with it.
    const behindAccess = new Hono<DevContext>()
      .use("*", createAccessMiddleware({ keys: () => async () => { throw new Error("no keys"); } }))
      .use("*", async (c, next) => {
        c.set("db", db);
        await next();
      })
      .route("/api/orgs/:orgId/dev/keys", ownerKeyRoutes);
    const req = () =>
      new Request(`https://mail.example.test/api/orgs/${ORG}/dev/keys/management`, {
        method: "POST",
        headers: { authorization: `Bearer ${mgmt.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "x", domains: [{ domainId: d.id, grantablePermissions: ["send"] }] }),
      });
    expect((await behindAccess.fetch(req(), {} as Env)).status).toBe(503);
    const configured = { ACCESS_AUD: "aud", TEAM_DOMAIN: "https://t.cloudflareaccess.com" } as Env;
    expect((await behindAccess.fetch(req(), configured)).status).toBe(401);

    expect(await managementKeyCount()).toBe(before);
  });

  it("a management key cannot create a key for a domain outside its list", async () => {
    const app1 = await seedDomain();
    const app2 = await seedDomain();
    const mgmt = await ownerManagementKey([{ domainId: app1.id, grantablePermissions: ["send", "read_log"] }]);

    const ok = await mintChild(mgmt.secret, app1.name, { permissions: ["send"] });
    expect(ok.status).toBe(201);
    const child = (await ok.json()) as Created;
    expect(child.secret.startsWith("bxk_")).toBe(true);

    for (const domain of [app2.name, "not-onboarded.test"]) {
      const res = await mintChild(mgmt.secret, domain, { permissions: ["send"] });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("domain_not_allowed");
    }
    const onApp2 = await db.select().from(apiKeys).where(eq(apiKeys.domainId, app2.id));
    expect(onApp2).toHaveLength(0);

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, child.key.id));
    expect(row?.parentKeyId).toBe(mgmt.key.id);
    expect(row?.createdBy).toBe(`key:${mgmt.key.id}`);
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, child.key.id), eq(auditEvents.action, "api_key.created")));
    expect(event?.actorType).toBe("api_key");
    expect(event?.actorId).toBe(mgmt.key.id);
  });

  it("a child key cannot exceed its parent's permissions or caps", async () => {
    const d = await seedDomain();
    const mgmt = await ownerManagementKey([
      { domainId: d.id, grantablePermissions: ["send", "read_log"], dailySendBudget: 1000 },
    ]);

    const tooMany = await mintChild(mgmt.secret, d.name, { permissions: ["send", "webhooks"] });
    expect(tooMany.status).toBe(403);
    expect(((await tooMany.json()) as { error: { code: string; param: string } }).error).toMatchObject({
      code: "exceeds_parent",
      param: "permissions",
    });

    const overCap = await mintChild(mgmt.secret, d.name, { permissions: ["send"], dailySendCap: 1001 });
    expect(overCap.status).toBe(403);

    const first = await mintChild(mgmt.secret, d.name, { permissions: ["send"], dailySendCap: 600 });
    expect(first.status).toBe(201);
    // The budget is shared across children: only 400 left.
    const second = await mintChild(mgmt.secret, d.name, { permissions: ["send"], dailySendCap: 500 });
    expect(second.status).toBe(403);
    // Without an explicit cap the child gets what is left, never unlimited.
    const third = await mintChild(mgmt.secret, d.name, { permissions: ["send", "read_log"] });
    expect(third.status).toBe(201);
    expect(((await third.json()) as Created).key.dailySendCap).toBe(400);
    const exhausted = await mintChild(mgmt.secret, d.name, { permissions: ["send"] });
    expect(exhausted.status).toBe(403);

    const children = await db.select().from(apiKeys).where(eq(apiKeys.parentKeyId, mgmt.key.id));
    expect(children.map((c) => c.dailySendCap).sort()).toEqual([400, 600]);
    expect(children.every((c) => c.permissions.every((p) => ["send", "read_log"].includes(p)))).toBe(true);
  });

  it("a management key cannot send or read mail", async () => {
    const d = await seedDomain();
    const mgmt = await ownerManagementKey([
      { domainId: d.id, grantablePermissions: ["send", "read_log", "read_received"] },
    ]);

    const send = await call("POST", "/dev/v1/messages", { key: mgmt.secret, body: { from: `noreply@${d.name}` } });
    expect(send.status).toBe(403);
    expect((await call("GET", "/dev/v1/messages", { key: mgmt.secret })).status).toBe(403);
    expect((await call("GET", "/dev/v1/received", { key: mgmt.secret })).status).toBe(403);

    const auth = await authenticateSecret(db, mgmt.secret);
    expect(auth?.kind).toBe("management");
    expect(keyMaySendFrom(auth!, `noreply@${d.name}`)).toBe(false);
    expect(keyMayReadAddress(auth!, `support@${d.name}`)).toBe(false);
    expect(keyCoversDomain(auth!, d.id)).toBe(false);

    // A child it mints with those permissions can, so the refusal is about the key kind.
    const child = (await (await mintChild(mgmt.secret, d.name, { permissions: ["send", "read_log"] })).json()) as Created;
    expect((await call("POST", "/dev/v1/messages", { key: child.secret, body: { from: `noreply@${d.name}` } })).status).toBe(202);
    expect((await call("GET", "/dev/v1/messages", { key: child.secret })).status).toBe(200);
    expect((await call("GET", "/dev/v1/received", { key: child.secret })).status).toBe(403);
  });

  it("a domain key cannot act on another domain", async () => {
    const app1 = await seedDomain();
    const app2 = await seedDomain();
    const k1 = await ownerDomainKey(app1.id, ["send", "read_received"], { allowedFrom: [`noreply@${app1.name}`] });
    const k2 = await ownerDomainKey(app2.id, ["send"]);

    expect((await call("POST", "/dev/v1/messages", { key: k1.secret, body: { from: `noreply@${app2.name}` } })).status).toBe(403);
    expect(
      (await call("POST", "/dev/v1/messages", { key: k1.secret, body: { from: `Ops <noreply@${app2.name}>` } })).status,
    ).toBe(403);
    expect(
      (await call("POST", "/dev/v1/messages", { key: k1.secret, body: { from: `noreply@sub.${app1.name}` } })).status,
    ).toBe(403);
    // Inside its own domain, still only the From addresses it was limited to.
    expect((await call("POST", "/dev/v1/messages", { key: k1.secret, body: { from: `billing@${app1.name}` } })).status).toBe(403);
    expect((await call("POST", "/dev/v1/messages", { key: k1.secret, body: { from: `noreply@${app1.name}` } })).status).toBe(202);

    const auth = (await authenticateSecret(db, k1.secret))!;
    expect(keyCoversDomain(auth, app1.id)).toBe(true);
    expect(keyCoversDomain(auth, app2.id)).toBe(false);
    expect(keyMayReadAddress(auth, `support@${app1.name}`)).toBe(true);
    expect(keyMayReadAddress(auth, `support@${app2.name}`)).toBe(false);

    // Domain keys can't manage keys at all, on any domain.
    expect((await call("GET", "/dev/v1/keys", { key: k1.secret })).status).toBe(403);
    expect((await mintChild(k1.secret, app2.name, { permissions: ["send"] })).status).toBe(403);
    expect((await call("POST", `/dev/v1/keys/${k2.key.id}/revoke`, { key: k1.secret })).status).toBe(403);

    // A management key for app1 can't see or touch app2's keys.
    const mgmt = await ownerManagementKey([{ domainId: app1.id, grantablePermissions: ["send"] }]);
    expect((await call("POST", `/dev/v1/keys/${k2.key.id}/rotate`, { key: mgmt.secret })).status).toBe(404);
    expect((await call("POST", `/dev/v1/keys/${k2.key.id}/revoke`, { key: mgmt.secret })).status).toBe(404);
    const listed = (await (await call("GET", "/dev/v1/keys", { key: mgmt.secret })).json()) as { data: { id: string }[] };
    expect(listed.data.map((k) => k.id)).toContain(k1.key.id);
    expect(listed.data.map((k) => k.id)).not.toContain(k2.key.id);
    expect(await authenticateSecret(db, k2.secret)).not.toBeNull();
  });

  it("revoking a management key keeps children unless cascade is chosen", async () => {
    const d = await seedDomain();
    const grants = [{ domainId: d.id, grantablePermissions: ["send"] }];

    const keep = await ownerManagementKey(grants);
    const keptChild = (await (await mintChild(keep.secret, d.name, { permissions: ["send"] })).json()) as Created;
    const res = await call("POST", `/api/orgs/${ORG}/dev/keys/${keep.key.id}/revoke`, { body: {} });
    expect(res.status).toBe(200);
    expect(await authenticateSecret(db, keep.secret)).toBeNull();
    expect((await call("GET", "/dev/v1/keys", { key: keep.secret })).status).toBe(401);
    expect((await mintChild(keep.secret, d.name, { permissions: ["send"] })).status).toBe(401);
    expect((await call("POST", "/dev/v1/messages", { key: keptChild.secret, body: { from: `a@${d.name}` } })).status).toBe(202);

    const cascade = await ownerManagementKey(grants);
    const goneChild = (await (await mintChild(cascade.secret, d.name, { permissions: ["send"] })).json()) as Created;
    const res2 = await call("POST", `/api/orgs/${ORG}/dev/keys/${cascade.key.id}/revoke`, { body: { cascade: true } });
    expect(((await res2.json()) as { revoked: string[] }).revoked.sort()).toEqual([cascade.key.id, goneChild.key.id].sort());
    expect(await authenticateSecret(db, cascade.secret)).toBeNull();
    expect(await authenticateSecret(db, goneChild.secret)).toBeNull();
    expect((await call("POST", "/dev/v1/messages", { key: goneChild.secret, body: { from: `a@${d.name}` } })).status).toBe(401);
    // The first tree is untouched by the second revocation.
    expect(await authenticateSecret(db, keptChild.secret)).not.toBeNull();

    const revocations = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "api_key.revoked"), eq(auditEvents.actorId, OWNER)));
    expect(revocations.map((e) => e.targetId)).toEqual(
      expect.arrayContaining([keep.key.id, cascade.key.id, goneChild.key.id]),
    );
    expect(revocations.map((e) => e.targetId)).not.toContain(keptChild.key.id);
  });

  it("rotation keeps both secrets valid during the overlap window", async () => {
    const d = await seedDomain();
    const mgmt = await ownerManagementKey([{ domainId: d.id, grantablePermissions: ["send"] }]);
    const child = (await (await mintChild(mgmt.secret, d.name, { permissions: ["send"] })).json()) as Created;

    const res = await call("POST", `/dev/v1/keys/${child.key.id}/rotate`, { key: mgmt.secret, body: { overlapHours: 24 } });
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as Created;
    expect(rotated.secret).not.toBe(child.secret);
    expect(rotated.key.id).toBe(child.key.id);

    for (const secret of [child.secret, rotated.secret]) {
      expect((await call("POST", "/dev/v1/messages", { key: secret, body: { from: `a@${d.name}` } })).status).toBe(202);
    }

    const in23h = new Date(Date.now() + 23 * 3600_000);
    const in25h = new Date(Date.now() + 25 * 3600_000);
    expect((await authenticateSecret(db, child.secret, in23h))?.id).toBe(child.key.id);
    expect(await authenticateSecret(db, child.secret, in25h)).toBeNull();
    expect((await authenticateSecret(db, rotated.secret, in25h))?.id).toBe(child.key.id);

    // Once the window has passed the old secret is refused over HTTP too.
    await db.update(apiKeys).set({ previousSecretExpiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, child.key.id));
    expect((await call("POST", "/dev/v1/messages", { key: child.secret, body: { from: `a@${d.name}` } })).status).toBe(401);
    expect((await call("POST", "/dev/v1/messages", { key: rotated.secret, body: { from: `a@${d.name}` } })).status).toBe(202);

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "api_key.rotated"), eq(auditEvents.targetId, child.key.id)));
    expect(event?.actorId).toBe(mgmt.key.id);
  });

  it("keys are stored hashed and shown once", async () => {
    const d = await seedDomain();
    const mgmt = await ownerManagementKey([{ domainId: d.id, grantablePermissions: ["send"] }]);
    const child = (await (await mintChild(mgmt.secret, d.name, { permissions: ["send"] })).json()) as Created;

    for (const [created, prefix] of [[mgmt, "bxm_"], [child, "bxk_"]] as const) {
      expect(created.secret).toMatch(new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`));
      expect(created.key.display).toBe(`${prefix}…${created.secret.slice(-4)}`);
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.key.id));
      expect(row!.secretHash).toBe(await hashSecret(created.secret));
      expect(row!.secretHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(created.secret.slice(prefix.length));
      expect(JSON.stringify(created.key)).not.toContain(row!.secretHash);
    }

    const tree = await (await call("GET", `/api/orgs/${ORG}/dev/keys`)).text();
    const list = await (await call("GET", "/dev/v1/keys", { key: mgmt.secret })).text();
    const audits = JSON.stringify(await db.select().from(auditEvents));
    for (const text of [tree, list, audits]) {
      expect(text).not.toContain(mgmt.secret.slice(4));
      expect(text).not.toContain(child.secret.slice(4));
      expect(text).not.toContain(await hashSecret(child.secret));
    }
    expect(tree).toContain(`bxk_…${child.secret.slice(-4)}`);
    const parsedTree = JSON.parse(tree) as { management: { id: string; children: { id: string }[] }[] };
    expect(parsedTree.management.find((m) => m.id === mgmt.key.id)?.children.map((c) => c.id)).toEqual([child.key.id]);

    // A near-miss secret never authenticates; neither does presenting the stored hash.
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, child.key.id));
    expect(await authenticateSecret(db, child.secret.slice(0, -1) + (child.secret.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await authenticateSecret(db, row!.secretHash)).toBeNull();
    expect((await authenticateSecret(db, child.secret))?.id).toBe(child.key.id);
  });
});


it("a domain key's daily send cap feeds the circuit breaker", async () => {
  const d = await seedDomain();
  await db.update(domains).set({ sendingEnabled: true }).where(eq(domains.id, d.id));
  const key = await ownerDomainKey(d.id, ["send"], { dailySendCap: 1 });
  const creates: { params: { kind: "api"; messageId: string } }[] = [];
  const bindings = { ...env, SEND_WORKFLOW: { create: vi.fn(async (opts: typeof creates[0]) => { creates.push(opts); return { id: opts.params.messageId }; }) } } as unknown as Env;
  const real = new Hono<DevContext>().use("*", async (c, next) => { c.set("db", db); await next(); }).route("/dev/v1/messages", devMessageRoutes);
  const recipients = Array.from({ length: 20 }, (_, i) => `recipient-${i}@outside.test`);
  const from = `noreply@${d.name}`;
  const send = () => real.request("/dev/v1/messages", { method: "POST", headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" }, body: JSON.stringify({ from, to: recipients, subject: "Synthetic cap check", text: "test" }) }, bindings);
  expect((await send()).status).toBe(202);
  const refused = await send();
  expect(refused.status).toBe(429);
  expect(await refused.json()).toMatchObject({ error: { code: "daily_cap_exceeded" } });
  expect(creates).toHaveLength(1);
  const sentId = `<synthetic-${id()}@cf.test>`;
  const email = { send: vi.fn(async () => ({ messageId: sentId })) } as unknown as SendEmail;
  const step = { do: async (_: string, a: unknown, b?: unknown) => ((typeof a === "function" ? a : b) as () => Promise<unknown>)() } as unknown as ApiSendStep;
  expect(await runApiSend({ ...bindings, EMAIL: email }, creates[0]!.params, step)).toBe("sent");
  const outcomes = recipients.map((recipient, i) => {
    const event = fixture(i < 18 ? "event-delivered.json" : "event-bounced.json").body;
    event.payload.eventId = id(); event.payload.messageId = sentId; event.payload.sender = from; event.payload.recipient = recipient;
    event.metadata.eventTimestamp = new Date().toISOString();
    return { id: id(), body: event, ack: vi.fn(), retry: vi.fn() };
  });
  await handleEmailEvents({ messages: outcomes } as unknown as MessageBatch<unknown>, { DB: env.DB });
  expect(outcomes.every((o) => o.ack.mock.calls.length === 1 && o.retry.mock.calls.length === 0)).toBe(true);
  const settings = await db.query.appSettings.findFirst({ where: eq(appSettings.id, 1) });
  expect(settings?.sendingPausedAt).toBeInstanceOf(Date);
  expect(settings?.sendingPausedReason).toMatch(/Bounce rate 10.0%/);
});
