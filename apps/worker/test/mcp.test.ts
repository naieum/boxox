import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { agents, auditEvents, mcpClients, messages } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import { createDomainKey, createManagementKey } from "../src/dev/keys";
import type { Env } from "../src/env";
import type { AppContext } from "../src/middleware";
import { stripQuotedText } from "../src/mcp/quotes";
import { mcpClientRoutes } from "../src/oauth/clients";
import { consentRoutes } from "../src/oauth/consent";
import { withOAuth } from "../src/oauth/provider";
import { SETUP_ORG_ID } from "../src/routes/setup";
import { messageRow, seedMailbox, seedThread } from "./helpers/seed";

/**
 * The OAuth + MCP flow end to end against local D1, R2 and KV: dynamic client
 * registration, the owner's consent page, S256 PKCE token exchange, then MCP
 * calls through createMcpHandler. The app stub stands in for Access by setting
 * the user (and role) from a test header.
 */
const ORIGIN = "https://box.test";
const ORG = SETUP_ORG_ID;
const OWNER = "owner@example.test";
const SECRET = "dGVzdC1hZ2VudC1qd3Qtc2VjcmV0LTMyLWJ5dGVzISE=";
const REDIRECT = "https://client.example/callback";
const LOOPBACK = "http://127.0.0.1:8123/cb";

let db: Db;

function testEnv(): Env {
  return { ...env, AGENT_JWT_SECRET: SECRET, BOXOX_SIGNING_SECRET: SECRET } as Env;
}

const app = new Hono<AppContext>()
  .use("*", async (c, next) => {
    c.set("db", createDb(c.env));
    const role = c.req.header("x-test-role");
    if (role) c.set("user", { id: OWNER, email: OWNER, name: "Owner", role });
    await next();
  })
  .route("/oauth", consentRoutes)
  .route("/api/orgs/:orgId/mcp-clients", mcpClientRoutes);

const worker = withOAuth(app);

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker(new Request(`${ORIGIN}${path}`, init), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(() => {
  db = createDb(env);
});

// ---------- OAuth helpers ----------

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function register(
  opts: { redirectUris?: string[]; confidential?: boolean; ip?: string } = {},
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": opts.ip ?? `10.0.0.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({
      client_name: "Test MCP client",
      redirect_uris: opts.redirectUris ?? [REDIRECT],
      token_endpoint_auth_method: opts.confidential ? "client_secret_basic" : "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string; client_secret?: string };
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

function authorizePath(
  clientId: string,
  opts: { redirectUri?: string; challenge?: string; method?: string | null; scope?: string[] } = {},
): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: opts.redirectUri ?? REDIRECT,
    state: "st-123",
  });
  if (opts.challenge) q.set("code_challenge", opts.challenge);
  if (opts.method !== null) q.set("code_challenge_method", opts.method ?? "S256");
  if (opts.scope) q.set("scope", opts.scope.join(" "));
  return `/oauth/authorize?${q}`;
}

function consentGet(path: string, role: string | null = "owner") {
  return send(path, { headers: { accept: "application/json", ...(role ? { "x-test-role": role } : {}) } });
}

function consentPost(path: string, body: unknown, role: string | null = "owner") {
  return send(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(role ? { "x-test-role": role } : {}) },
    body: JSON.stringify(body),
  });
}

function tokenRequest(params: Record<string, string>) {
  return send("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

interface Connected {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  agentId: string;
  mailbox: { orgId: string; addressId: string };
}

/** Register, approve on the consent page as the owner, and exchange the code with PKCE. */
async function connect(permissions: string[] = ["read", "send"]): Promise<Connected> {
  const mailbox = await seedMailbox(db, { orgId: ORG });
  const { clientId } = await register();
  const { verifier, challenge } = await pkce();
  const path = authorizePath(clientId, { challenge });
  const approved = await consentPost(path, {
    decision: "approve",
    grants: [{ addressId: mailbox.addressId, permissions }],
  });
  expect(approved.status).toBe(200);
  const redirect = new URL(((await approved.json()) as { redirectTo: string }).redirectTo);
  expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
  expect(redirect.searchParams.get("state")).toBe("st-123");
  const code = redirect.searchParams.get("code")!;
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  expect(tokens.expires_in).toBeLessThanOrEqual(3600);
  const row = (await db.select().from(mcpClients).where(eq(mcpClients.clientId, clientId)))[0]!;
  return {
    clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    agentId: row.agentId!,
    mailbox,
  };
}

// ---------- MCP helpers ----------

async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const res = await send("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await res.text();
  let body: any = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    body = data.length ? JSON.parse(data[data.length - 1]!) : null;
  } else if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return { status: res.status, body };
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  return res.body.result as { content: { type: string; text: string }[]; isError?: boolean };
}

// ---------- tests ----------

describe("OAuth for MCP", () => {
  it("reviews requested mailbox scopes and grants exactly that access through MCP", async () => {
    const domain = `${crypto.randomUUID()}.test`;
    const mailbox = await seedMailbox(db, { orgId: ORG, domain, localPart: "hello" });
    const otherDomain = `${crypto.randomUUID()}.test`;
    await seedMailbox(db, { orgId: ORG, domain: otherDomain });
    const { clientId } = await register();
    const { verifier, challenge } = await pkce();
    const scope = [`boxox:read:hello@${domain}`, `boxox:read:hello@${domain}`, "offline_access"];
    const path = authorizePath(clientId, { challenge, scope });
    const view = await consentGet(path);
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({
      requested: [{ addressId: mailbox.addressId, email: `hello@${domain}`, permissions: ["read"] }],
      addresses: [{ id: mailbox.addressId, email: `hello@${domain}` }], agents: [],
    });
    const html = await (await send(path, { headers: { "x-test-role": "owner" } })).text();
    expect(html).toContain("Approve requested access");
    expect(html).toContain(`hello@${domain}`);
    expect(html).not.toContain(otherDomain);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("Send to new recipients");

    // The server derives grants from the request, rather than trusting hidden form fields.
    const approved = await consentPost(path, { decision: "approve" });
    expect(approved.status).toBe(200);
    const code = new URL(((await approved.json()) as { redirectTo: string }).redirectTo).searchParams.get("code")!;
    const token = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    expect(token.status).toBe(200);
    const { access_token } = await token.json() as { access_token: string };
    const mine = await callTool(access_token, "list_addresses");
    expect(JSON.parse(mine.content[0]!.text).addresses).toEqual([{ addressId: mailbox.addressId, permissions: ["read"] }]);
    const deniedSend = await callTool(access_token, "send_email", { fromAddressId: mailbox.addressId, to: ["person@example.test"], subject: "No", text: "No" });
    expect(deniedSend.isError).toBe(true);
  });

  it("rejects unknown mailbox requests and forged grants before creating an agent", async () => {
    const domain = `${crypto.randomUUID()}.test`;
    const mailbox = await seedMailbox(db, { orgId: ORG, domain, localPart: "hello" });
    const other = await seedMailbox(db, { orgId: ORG });
    const broad = await connect(["read", "send_new"]);
    const { clientId } = await register();
    const { challenge } = await pkce();
    const count = (await db.select().from(agents)).length;
    for (const scope of [["boxox:read:absent@example.test"], [`boxox:owner:hello@${domain}`], ["boxox:read"]]) {
      const path = authorizePath(clientId, { challenge, scope });
      expect((await consentGet(path)).status).toBe(400);
      expect((await consentPost(path, { decision: "approve" })).status).toBe(400);
    }
    const path = authorizePath(clientId, { challenge, scope: [`boxox:read:hello@${domain}`] });
    for (const body of [
      { grants: [{ addressId: mailbox.addressId, permissions: ["read", "send_new"] }] },
      { grants: [{ addressId: other.addressId, permissions: ["read"] }] },
      { agentId: broad.agentId },
    ]) {
      expect((await consentPost(path, { decision: "approve", ...body })).status).toBe(400);
    }
    expect((await db.select().from(agents)).length).toBe(count);
    expect(await db.select().from(mcpClients).where(eq(mcpClients.clientId, clientId))).toHaveLength(0);
    const denied = await consentPost(path, { decision: "deny" });
    expect(denied.status).toBe(200);
    expect(new URL(((await denied.json()) as { redirectTo: string }).redirectTo).searchParams.get("error")).toBe("access_denied");
  });

  it("keeps clients without mailbox scopes on an explicit manual fallback", async () => {
    const { clientId } = await register();
    const { challenge } = await pkce();
    const path = authorizePath(clientId, { challenge });
    const html = await (await send(path, { headers: { "x-test-role": "owner" } })).text();
    expect(html).toContain("This app did not specify any mailboxes");
    expect(html).toContain("<details><summary>Choose access manually</summary>");
    expect(html).not.toContain("<details open");
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect((await consentPost(path, { decision: "deny" })).status).toBe(200);
  });

  it("reuses the approved agent on retry so issued MCP tokens keep working", async () => {
    const c = await connect(["read"]);
    const count = (await db.select().from(agents)).length;
    const { challenge } = await pkce();
    const path = authorizePath(c.clientId, { challenge });
    const body = { decision: "approve", grants: [{ addressId: c.mailbox.addressId, permissions: ["read"] }] };
    expect((await consentPost(path, body)).status).toBe(200);
    const row = (await db.select().from(mcpClients).where(eq(mcpClients.clientId, c.clientId)))[0]!;
    expect(row.agentId).toBe(c.agentId);
    expect((await db.select().from(agents)).length).toBe(count);
    expect((await rpc(c.accessToken, "tools/list")).status).toBe(200);
  });

  it("requires PKCE", async () => {
    // A confidential client, which the provider alone would let skip PKCE.
    const { clientId, clientSecret } = await register({ confidential: true });
    expect(clientSecret).toBeTruthy();

    const missing = authorizePath(clientId, { method: null });
    const page = await consentGet(missing);
    expect(page.status).toBe(400);
    expect(JSON.stringify(await page.json())).toMatch(/PKCE/);
    expect((await consentPost(missing, { decision: "approve", grants: [] })).status).toBe(400);

    const plain = authorizePath(clientId, { challenge: "x".repeat(43), method: "plain" });
    expect((await consentGet(plain)).status).toBe(400);
    expect((await consentPost(plain, { decision: "approve", grants: [] })).status).toBe(400);

    // Nothing was approved for this client.
    expect(await db.select().from(mcpClients).where(eq(mcpClients.clientId, clientId))).toHaveLength(0);

    // With S256 the consent page renders, and the code only redeems with the matching verifier.
    const { challenge } = await pkce();
    const s256 = authorizePath(clientId, { challenge });
    expect((await consentGet(s256)).status).toBe(200);
    const approved = await consentPost(s256, { decision: "approve", grants: [] });
    expect(approved.status).toBe(200);
    const code = new URL(((await approved.json()) as { redirectTo: string }).redirectTo).searchParams.get("code")!;
    const basic = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
    const exchange = (code_verifier: string) =>
      send("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier }),
      });
    const wrong = await exchange((await pkce()).verifier);
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects a redirect_uri that is not an exact match", async () => {
    const { clientId } = await register({ redirectUris: [REDIRECT, LOOPBACK] });
    const { verifier, challenge } = await pkce();

    for (const redirectUri of [
      `${REDIRECT}/`,
      `${REDIRECT}?next=/evil`,
      "https://client.example/callback/../steal",
      "https://evil.example/callback",
      // Same loopback host and path on another port: the provider would allow it, Box Ox doesn't.
      "http://127.0.0.1:9999/cb",
    ]) {
      const path = authorizePath(clientId, { redirectUri, challenge });
      expect((await consentGet(path)).status, redirectUri).toBe(400);
      expect((await consentPost(path, { decision: "approve", grants: [] })).status, redirectUri).toBe(400);
    }
    expect(await db.select().from(mcpClients).where(eq(mcpClients.clientId, clientId))).toHaveLength(0);

    // The registered URIs, byte for byte, work.
    expect((await consentGet(authorizePath(clientId, { redirectUri: LOOPBACK, challenge }))).status).toBe(200);
    const approved = await consentPost(authorizePath(clientId, { challenge }), { decision: "approve", grants: [] });
    expect(approved.status).toBe(200);
    const code = new URL(((await approved.json()) as { redirectTo: string }).redirectTo).searchParams.get("code")!;

    // The token request must name the same redirect_uri the code was issued for.
    const mismatch = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: LOOPBACK,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("a client must be approved by the owner", async () => {
    const mailbox = await seedMailbox(db, { orgId: ORG });
    const { clientId } = await register();
    const { challenge } = await pkce();
    const path = authorizePath(clientId, { challenge });
    const decision = { decision: "approve", grants: [{ addressId: mailbox.addressId, permissions: ["read"] }] };
    const agentsBefore = (await db.select().from(agents)).length;

    // A signed-in member (or no identity at all) can neither see nor approve the consent.
    for (const role of ["member", null]) {
      expect((await consentGet(path, role)).status).toBe(403);
      const res = await consentPost(path, decision, role);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }
    expect(await db.select().from(mcpClients).where(eq(mcpClients.clientId, clientId))).toHaveLength(0);
    expect((await db.select().from(agents)).length).toBe(agentsBefore);

    // Registration alone grants nothing: MCP without an owner-approved token is refused.
    expect((await rpc(null, "tools/list")).status).toBe(401);
    expect((await rpc(`${clientId}:not-a-token`, "tools/list")).status).toBe(401);

    // The owner sees the client, then approves it.
    const view = await consentGet(path);
    expect(view.status).toBe(200);
    const consent = (await view.json()) as { client: { clientId: string }; addresses: { id: string }[] };
    expect(consent.client.clientId).toBe(clientId);
    expect(consent.addresses.map((a) => a.id)).toContain(mailbox.addressId);

    const c = await connect(["read"]);
    const row = (await db.select().from(mcpClients).where(eq(mcpClients.clientId, c.clientId)))[0]!;
    expect(row.approvedBy).toBe(OWNER);
    expect(row.approvedAt).toBeInstanceOf(Date);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.targetId, c.clientId));
    expect(audit.map((a) => a.action)).toContain("mcp_client.approved");
    expect((await rpc(c.accessToken, "tools/list")).status).toBe(200);

    // Approval is re-checked on every call: without it, an issued token stops working.
    await db.update(mcpClients).set({ approvedAt: null }).where(eq(mcpClients.clientId, c.clientId));
    expect((await rpc(c.accessToken, "tools/list")).status).toBe(401);
  });

  it("a revoked client loses access", async () => {
    const c = await connect(["read"]);
    const threadId = await seedThread(db, c.mailbox, { subject: "hi" });
    const before = await callTool(c.accessToken, "list_threads", { addressId: c.mailbox.addressId });
    expect(before.isError).toBeUndefined();
    expect(JSON.parse(before.content[0]!.text).threads.map((t: { id: string }) => t.id)).toContain(threadId);

    // Only the owner can revoke.
    const revokePath = `/api/orgs/${ORG}/mcp-clients/${encodeURIComponent(c.clientId)}/revoke`;
    expect((await send(revokePath, { method: "POST", headers: { "x-test-role": "member" } })).status).toBe(403);
    expect((await rpc(c.accessToken, "tools/list")).status).toBe(200);

    const listed = await send(`/api/orgs/${ORG}/mcp-clients`, { headers: { "x-test-role": "owner" } });
    const clients = ((await listed.json()) as { clients: { clientId: string; revokedAt: string | null }[] }).clients;
    expect(clients.find((x) => x.clientId === c.clientId)?.revokedAt).toBeNull();

    const revoked = await send(revokePath, { method: "POST", headers: { "x-test-role": "owner" } });
    expect(revoked.status).toBe(200);

    // The live access token, the refresh token and a fresh authorization all fail.
    expect((await rpc(c.accessToken, "tools/list")).status).toBe(401);
    expect((await rpc(c.accessToken, "tools/call", { name: "list_threads", arguments: { addressId: c.mailbox.addressId } })).status).toBe(401);
    const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: c.clientId });
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    const { challenge } = await pkce();
    expect((await consentGet(authorizePath(c.clientId, { challenge }))).status).toBe(400);

    const row = (await db.select().from(mcpClients).where(eq(mcpClients.clientId, c.clientId)))[0]!;
    expect(row.revokedAt).toBeInstanceOf(Date);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.targetId, c.clientId));
    expect(audit.map((a) => a.action)).toContain("mcp_client.revoked");
  });
});

describe("MCP tools", () => {
  it("MCP refuses management-key and owner-level operations", async () => {
    const c = await connect(["read", "send"]);
    const owner = { type: "owner" as const, email: OWNER };
    const domainId = (await db.query.addresses.findFirst({ where: (a, { eq }) => eq(a.id, c.mailbox.addressId) }))!.domainId;
    const management = await createManagementKey(db, ORG, owner, {
      name: "mgmt",
      domains: [{ domainId, grantablePermissions: ["send"] }],
    } as Parameters<typeof createManagementKey>[3]);
    const domainKey = await createDomainKey(db, ORG, owner, { name: "dk", domainId, permissions: ["send", "read_log"] });

    // Real, valid API keys are not MCP credentials.
    for (const secret of [management.secret, domainKey.secret]) {
      const res = await rpc(secret, "tools/list");
      expect(res.status).toBe(401);
    }

    // The tool surface is mail operations only.
    const list = await rpc(c.accessToken, "tools/list");
    expect(list.status).toBe(200);
    const names = (list.body.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["claim_message", "complete_message", "complete_messages", "get_message", "get_thread", "list_addresses", "list_changes", "list_threads", "list_work", "mark_read", "renew_claim", "retry_message", "send_email", "trash_thread"]);
    for (const n of names) expect(n).not.toMatch(/key|agent|client|kill|setup|domain|grant|approve|revoke|delete/);

    // Owner-level operations don't exist over MCP, whatever they're called.
    for (const name of ["create_management_key", "create_domain_key", "set_kill_switch", "approve_client", "revoke_client", "create_agent", "delete_thread"]) {
      const res = await callTool(c.accessToken, name, { name: "x", disabled: true });
      expect(res.isError, name).toBe(true);
      expect(res.content[0]!.text).toMatch(/Unknown tool/);
    }

    // The token's reach is the bound agent's grants and nothing else.
    const other = await seedMailbox(db, { orgId: ORG });
    const foreign = await callTool(c.accessToken, "list_threads", { addressId: other.addressId });
    expect(foreign.isError).toBe(true);
    const mine = await callTool(c.accessToken, "list_addresses");
    expect(JSON.parse(mine.content[0]!.text).addresses).toEqual([
      { addressId: c.mailbox.addressId, permissions: ["read", "send"] },
    ]);
  });

  it("get_thread returns messages without quoted text", async () => {
    const c = await connect(["read"]);
    const threadId = await seedThread(db, c.mailbox, { subject: "Tuesday" });
    const bodies = [
      "Can we meet Tuesday?\n\nSam",
      "Tuesday works for me.\n\nOn Mon, Oct 12, 2026 at 9:00 AM Sam <sam@ext.test> wrote:\n> Can we meet Tuesday?\n> QUOTED-MARKER-1",
      "Great, see you then.\n\n> Tuesday works for me.\n> QUOTED-MARKER-2\n\nFrom: Me <me@box.test>\nSent: Tuesday, October 13, 2026 8:00 AM\nTo: Sam <sam@ext.test>\nSubject: Re: Tuesday\n\nQUOTED-MARKER-3",
    ];
    const ids: string[] = [];
    for (const [i, text] of bodies.entries()) {
      const row = messageRow(c.mailbox, threadId, { scanStatus: "scanned",
        fromEmail: i === 1 ? "me@box.test" : "sam@ext.test",
        direction: i === 1 ? "outbound" : "inbound",
        authenticated: true,
        subject: "Tuesday",
        occurredAt: new Date(Date.UTC(2026, 9, 12 + i)),
      });
      await env.MAIL_STORE.put(row.r2Key, JSON.stringify({ text }));
      await db.insert(messages).values(row);
      ids.push(row.id!);
    }

    const res = await callTool(c.accessToken, "get_thread", { threadId, includeBody: true });
    expect(res.isError).toBeUndefined();
    const raw = res.content[0]!.text;
    expect(raw).not.toMatch(/QUOTED-MARKER|wrote:|Sent: Tuesday/);
    const detail = JSON.parse(raw) as { thread: { id: string }; messages: { id: string; text: string }[] };
    expect(detail.thread.id).toBe(threadId);
    expect(detail.messages.map((m) => m.id)).toEqual(ids);
    expect(detail.messages.map((m) => m.text)).toEqual([
      "Can we meet Tuesday?\n\nSam",
      "Tuesday works for me.",
      "Great, see you then.",
    ]);

    expect(stripQuotedText("Sounds good.\n\nOn Tue, Oct 13, 2026 at 10:02 AM Sam Example <\nsam@ext.test> wrote:\n> hi")).toBe(
      "Sounds good.",
    );
  });
});

it("OAuth MCP agents can resume, fetch bounded content, lease and acknowledge work", async () => {
  const c = await connect(["read"]);
  const threadId = await seedThread(db, c.mailbox, { subject: "Process this" });
  const row = messageRow(c.mailbox, threadId, { scanStatus: "scanned", snippet: "A short preview" });
  await env.MAIL_STORE.put(row.r2Key, JSON.stringify({ text: "The complete request" }));
  await db.insert(messages).values(row);
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const result = await callTool(c.accessToken, name, args);
    expect(result.isError, name + ": " + result.content[0]?.text).toBeUndefined();
    return JSON.parse(result.content[0]!.text);
  };
  const changes = await invoke("list_changes", { addressId: c.mailbox.addressId });
  expect(changes.changes.length).toBeGreaterThan(0);
  expect((await invoke("list_changes", { addressId: c.mailbox.addressId, cursor: changes.nextCursor })).changes).toEqual([]);
  const metadata = await invoke("get_thread", { threadId });
  expect(metadata.messages[0].text).toBeNull();
  expect((await invoke("get_message", { messageId: row.id, includeBody: true })).message.text).toBe("The complete request");
  const pending = await invoke("list_work", { addressId: c.mailbox.addressId, group: "support" });
  expect(pending.messages.some((m: any) => m.messageId === row.id)).toBe(true);
  const claim = await invoke("claim_message", { messageId: row.id, group: "support" });
  await invoke("renew_claim", { messageId: row.id, group: "support", claimToken: claim.claimToken });
  await invoke("complete_message", { messageId: row.id, group: "support", claimToken: claim.claimToken });
  expect((await invoke("list_work", { addressId: c.mailbox.addressId, group: "support" })).messages).toEqual([]);
});
