import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { addressGrants, messages, spamFingerprints, spamTokens, spamTraining, threads } from "@boxox/db";
import { createDb } from "../src/db";
import { requireSameOrigin, type AppContext, type SessionUser } from "../src/middleware";
import { threadRoutes } from "../src/routes/threads";
import { id, messageRow, seedMailbox, seedThread } from "./helpers/seed";

const db = createDb(env);
const OWNER: SessionUser = { id: "owner@example.test", email: "owner@example.test", name: "Owner", role: "owner" };
const GUEST: SessionUser = { id: "guest@example.test", email: "guest@example.test", name: "Guest", role: "member" };
let user: SessionUser | null = OWNER;
const app = new Hono<AppContext>()
  .use("*", requireSameOrigin)
  .use("*", async (c, next) => { c.set("db", createDb(c.env)); if (user) c.set("user", user); await next(); })
  .route("/api/orgs/:orgId/threads", threadRoutes);

function call(orgId: string, path: string, action?: string, origin = "https://mail.test") {
  return app.request(`https://mail.test/api/orgs/${orgId}/threads${path}`, {
    method: action ? "POST" : "GET",
    headers: { "content-type": "application/json", origin, "x-boxox-csrf": "1" },
    body: action ? JSON.stringify({ action }) : undefined,
  }, env);
}

async function seed() {
  const box = await seedMailbox(db, { orgId: id() });
  const threadId = await seedThread(db, box, { subject: "Exclusive offer", counterpartyEmail: "news@ext.test" });
  const row = messageRow(box, threadId, { subject: "Exclusive offer", snippet: "Exclusive promotion" });
  await db.insert(messages).values(row);
  await env.MAIL_STORE.put(row.r2Key, JSON.stringify({ text: "Exclusive offers and amazing prizes await you today. Claim your promotion and free reward by entering your account details with our dedicated verification team. ".repeat(3) }));
  return { ...box, threadId, messageId: row.id! };
}

beforeEach(async () => {
  user = OWNER;
  await db.delete(spamFingerprints);
  await db.delete(spamTraining);
  await db.delete(spamTokens);
});

describe("owner spam feedback", () => {
  it("trains and reverses Bayes counts and fingerprints through spam/not-spam actions", async () => {
    const item = await seed();
    const outbound = messageRow(item, item.threadId, { direction: "outbound", subject: "My reply" });
    await db.insert(messages).values(outbound);
    const act = (action: string) => call(item.orgId, `/${item.threadId}/actions`, action);
    for (let i = 0; i < 2; i++) expect((await act("spam")).status).toBe(200);
    expect(await db.select().from(spamTraining)).toMatchObject([{ messageId: item.messageId, label: "spam" }]);
    expect(await db.select().from(spamTokens).where(eq(spamTokens.token, "exclusive"))).toMatchObject([{ spamCount: 1, hamCount: 0 }]);
    expect(await db.select().from(spamFingerprints)).toHaveLength(1);
    for (let i = 0; i < 2; i++) expect((await act("not_spam")).status).toBe(200);
    expect(await db.select().from(spamTraining)).toMatchObject([{ messageId: item.messageId, label: "ham" }]);
    expect(await db.select().from(spamTokens).where(eq(spamTokens.token, "exclusive"))).toMatchObject([{ spamCount: 0, hamCount: 1 }]);
    expect(await db.select().from(spamFingerprints)).toEqual([]);
    expect((await act("spam")).status).toBe(200);
    expect(await db.select().from(spamTokens).where(eq(spamTokens.token, "exclusive"))).toMatchObject([{ spamCount: 1, hamCount: 0 }]);
    expect(await db.select().from(spamFingerprints)).toHaveLength(1);
  });

  it("refuses unauthorized feedback and keeps member folder changes out of owner training", async () => {
    const item = await seed();
    const path = `/${item.threadId}/actions`;
    user = null;
    expect((await call(item.orgId, path, "spam")).status).toBe(401);
    user = OWNER;
    expect((await call(item.orgId, path, "spam", "https://evil.test")).status).toBe(403);
    expect((await call("other-org", path, "spam")).status).toBe(404);
    user = GUEST;
    expect((await call(item.orgId, path, "spam")).status).toBe(403);
    expect(await db.select().from(spamTraining)).toEqual([]);
    await db.insert(addressGrants).values({ id: id(), organizationId: item.orgId, addressId: item.addressId, principalType: "user", principalId: GUEST.id, permissions: ["read"], createdBy: OWNER.id });
    expect((await call(item.orgId, path, "spam")).status).toBe(200);
    expect(await db.select().from(spamTraining)).toEqual([]);
    expect(await db.select().from(spamFingerprints)).toEqual([]);
  });

  it("trains block-sender feedback after validating its sender", async () => {
    const item = await seed();
    await db.update(threads).set({ counterpartyEmail: null }).where(eq(threads.id, item.threadId));
    expect((await call(item.orgId, `/${item.threadId}/actions`, "block_sender")).status).toBe(409);
    expect(await db.select().from(spamTraining)).toEqual([]);
    await db.update(threads).set({ counterpartyEmail: "news@ext.test" }).where(eq(threads.id, item.threadId));
    expect((await call(item.orgId, `/${item.threadId}/actions`, "block_sender")).status).toBe(200);
    expect(await db.select().from(spamTraining)).toMatchObject([{ messageId: item.messageId, label: "spam" }]);
    expect((await call(item.orgId, `/${item.threadId}/actions`, "not_spam")).status).toBe(200);
    expect(await db.select().from(spamFingerprints)).toEqual([]);
  });
});

describe("priority and category views", () => {
  it("filters stored classification fields with mailbox grants and exposes their badges' data", async () => {
    const box = await seedMailbox(db, { orgId: id() });
    const high = await seedThread(db, box, { subject: "High", priority: 3, category: "work" });
    const low = await seedThread(db, box, { subject: "Low", priority: 0, category: "work" });
    const spam = await seedThread(db, box, { subject: "Spam", priority: 3, category: "work", folder: "spam" });
    await seedThread(db, box, { priority: 3, category: "work", folder: "trash" });
    const privateBox = await seedMailbox(db, { orgId: box.orgId });
    const hidden = await seedThread(db, privateBox, { priority: 3, category: "work" });
    user = GUEST;
    await db.insert(addressGrants).values({ id: id(), organizationId: box.orgId, addressId: box.addressId, principalType: "user", principalId: GUEST.id, permissions: ["read"], createdBy: OWNER.id });
    const priority = await call(box.orgId, "?folder=priority");
    expect(await priority.json()).toMatchObject({ threads: [{ id: high, priority: 3, category: "work" }] });
    const category = await (await call(box.orgId, "?folder=category&category=work")).json() as { threads: { id: string }[] };
    expect(new Set(category.threads.map((t) => t.id))).toEqual(new Set([high, low, spam]));
    expect(category.threads.some((t) => t.id === hidden)).toBe(false);
    expect((await call(box.orgId, "?folder=category&category=unknown")).status).toBe(400);
    expect(await (await call(box.orgId, `/${high}`)).json()).toMatchObject({ thread: { priority: 3, category: "work" } });
  });
});
