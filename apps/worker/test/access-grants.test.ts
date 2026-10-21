import { env } from "cloudflare:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addressGrants, addresses, blockedSenders } from "@boxox/db";
import { createDb } from "../src/db";
import type { AppContext, SessionUser } from "../src/middleware";
import { addressRoutes } from "../src/routes/addresses";
import { domainRoutes } from "../src/routes/domains";
import { labelRoutes } from "../src/routes/labels";
import { threadRoutes } from "../src/routes/threads";
import { id, seedMailbox, seedThread } from "./helpers/seed";

const db = createDb(env);
const member: SessionUser = { id: "guest@example.test", email: "guest@example.test", name: "Guest", role: "member" };
const owner: SessionUser = { id: "owner@example.test", email: "owner@example.test", name: "Owner", role: "owner" };
const appAs = (user: SessionUser) => new Hono<AppContext>()
  .use("*", async (c, next) => { c.set("db", db); c.set("user", user); await next(); })
  .route("/api/orgs/:orgId/threads", threadRoutes)
  .route("/api/orgs/:orgId/addresses", addressRoutes)
  .route("/api/orgs/:orgId/domains", domainRoutes)
  .route("/api/orgs/:orgId/labels", labelRoutes);
const body = (value: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const action = (org: string, thread: string) => `/api/orgs/${org}/threads/${thread}/actions`;

async function fixture() {
  const box = await seedMailbox(db, { orgId: id() });
  const other = await seedMailbox(db, { orgId: box.orgId });
  const visible = await seedThread(db, box, { counterpartyEmail: "sender@outside.test" });
  const hidden = await seedThread(db, other, { subject: "PRIVATE-OTHER-MAILBOX" });
  await db.insert(addressGrants).values({ id: id(), organizationId: box.orgId, addressId: box.addressId, principalType: "user", principalId: member.id, createdBy: owner.id, permissions: ["read"] });
  return { box, other, visible, hidden };
}

describe("mailbox grants at HTTP entrypoints", () => {
  it("a user without a grant cannot read another address's threads", async () => {
    const { box, visible, hidden } = await fixture();
    const app = appAs(member);
    expect((await app.request(`/api/orgs/${box.orgId}/threads/${visible}`, {}, env)).status).toBe(200);
    const denied = await app.request(`/api/orgs/${box.orgId}/threads/${hidden}`, {}, env);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("PRIVATE-OTHER-MAILBOX");
    const listed = await app.request(`/api/orgs/${box.orgId}/threads`, {}, env);
    expect(listed.status).toBe(200);
    expect(await listed.text()).not.toContain(hidden);
    expect((await app.request(action(box.orgId, hidden), body({ action: "trash" }), env)).status).toBe(403);
  });

  it("admin routes are owner-only", async () => {
    const { box, other } = await fixture();
    const path = `/api/orgs/${box.orgId}/addresses/${other.addressId}`;
    const edit = { ...body({ displayName: "Changed" }), method: "PATCH" };
    expect((await appAs(member).request(path, edit, env)).status).toBe(403);
    expect((await db.query.addresses.findFirst({ where: eq(addresses.id, other.addressId) }))?.displayName).not.toBe("Changed");
    expect((await appAs(owner).request(path, edit, env)).status).toBe(200);
    const grant = `/api/orgs/${box.orgId}/addresses/${other.addressId}/grants`;
    expect((await appAs(member).request(grant, body({ inviteEmail: member.email, permissions: ["read", "send"] }), env)).status).toBe(403);
  });

  it("members cannot enumerate domains, other people's grants, or the sending quota", async () => {
    const { box, other } = await fixture();
    await db.insert(addressGrants).values({ id: id(), organizationId: box.orgId, addressId: other.addressId, principalType: "user", inviteEmail: "SOMEONE-ELSE@example.test", createdBy: owner.id, permissions: ["read"] });
    for (const path of [`/api/orgs/${box.orgId}/domains`, `/api/orgs/${box.orgId}/domains/${other.domainId}/addresses`, `/api/orgs/${box.orgId}/domains/quota`]) {
      const denied = await appAs(member).request(path, {}, env);
      expect(denied.status, path).toBe(403);
      expect(await denied.text()).not.toContain("SOMEONE-ELSE");
    }
    expect((await appAs(member).request(`/api/orgs/${box.orgId}/domains/${other.domainId}/health`, { method: "POST" }, env)).status).toBe(403);
    expect((await appAs(owner).request(`/api/orgs/${box.orgId}/domains`, {}, env)).status).toBe(200);
    const listed = await appAs(owner).request(`/api/orgs/${box.orgId}/domains/${other.domainId}/addresses`, {}, env);
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("SOMEONE-ELSE@example.test");
  });

  it("shared labels can only be changed by the owner or whoever created them", async () => {
    const { box } = await fixture();
    const labels = `/api/orgs/${box.orgId}/labels`;
    const ownersLabel = (await (await appAs(owner).request(labels, body({ name: `Owner ${id()}` }), env)).json()) as { label: { id: string } };
    const guestsLabel = (await (await appAs(member).request(labels, body({ name: `Guest ${id()}` }), env)).json()) as { label: { id: string } };
    const rename = { ...body({ name: `Renamed ${id()}` }), method: "PATCH" };
    expect((await appAs(member).request(`${labels}/${ownersLabel.label.id}`, rename, env)).status).toBe(403);
    expect((await appAs(member).request(`${labels}/${guestsLabel.label.id}`, { ...body({ name: `Mine ${id()}` }), method: "PATCH" }, env)).status).toBe(200);
    expect((await appAs(owner).request(`${labels}/${guestsLabel.label.id}`, { ...body({ name: `Theirs ${id()}` }), method: "PATCH" }, env)).status).toBe(200);
  });

  it("read-grant members cannot alter the installation-wide sender blocklist", async () => {
    const { box, visible } = await fixture();
    const path = action(box.orgId, visible);
    expect((await appAs(member).request(path, body({ action: "block_sender" }), env)).status).toBe(403);
    expect(await db.select().from(blockedSenders).where(eq(blockedSenders.organizationId, box.orgId))).toHaveLength(0);
    expect((await appAs(owner).request(path, body({ action: "block_sender" }), env)).status).toBe(200);
    expect((await appAs(member).request(path, body({ action: "not_spam" }), env)).status).toBe(200);
    expect(await db.select().from(blockedSenders).where(eq(blockedSenders.organizationId, box.orgId))).toHaveLength(1);
    expect((await appAs(owner).request(path, body({ action: "not_spam" }), env)).status).toBe(200);
    expect(await db.select().from(blockedSenders).where(eq(blockedSenders.organizationId, box.orgId))).toHaveLength(0);
  });
});
