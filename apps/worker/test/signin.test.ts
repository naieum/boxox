import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { createInvite, OWNER_LINK_MS, SESSION_COOKIE, sha256Hex } from "../src/services/signin";

const ORIGIN = "https://mail.example.test";
const OWNER = "owner@example.test";
// The per-IP limiter is exercised by its own test; every other test shares one test IP.
const bindings = { ...env, ACCESS_AUD: undefined, TEAM_DOMAIN: undefined, OWNER_EMAIL: OWNER, PUBLIC_URL: ORIGIN, SIGNIN_RATE_LIMIT: undefined };

beforeEach(async () => {
  for (const table of ["auth_sessions", "auth_passkeys", "auth_invites", "auth_users"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
});

// A software authenticator: enough of WebAuthn to register and assert with ES256.
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const utf8 = (text: string) => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return concat(head(3, utf8(value).length), utf8(value));
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}
function der(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array) => { let i = 0; while (i < bytes.length - 1 && bytes[i] === 0) i++; let v = bytes.slice(i); if (v[0]! & 0x80) v = concat(Uint8Array.of(0), v); return concat(Uint8Array.of(2, v.length), v); };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}
async function authenticator(options: { origin?: string; rpId?: string; userVerified?: boolean } = {}) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
  const coord = (v: string) => Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
  const id = crypto.getRandomValues(new Uint8Array(16));
  const rpHash = await sha256(utf8(options.rpId ?? "mail.example.test"));
  const origin = options.origin ?? ORIGIN;
  const uv = options.userVerified === false ? 0 : 0x04;
  let counter = 0;
  const clientData = (type: string, challenge: string) => utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64url(id),
    async create(challenge: string) {
      const key = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, coord(jwk.x!)], [-3, coord(jwk.y!)]]));
      const authData = concat(rpHash, Uint8Array.of(0x41 | uv), Uint8Array.of(0, 0, 0, 0), new Uint8Array(16), Uint8Array.of(0, id.length), id, key);
      const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return { id: b64url(id), rawId: b64url(id), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64url(clientData("webauthn.create", challenge)), attestationObject: b64url(attestationObject), transports: ["internal"] } };
    },
    async get(challenge: string) {
      const authData = concat(rpHash, Uint8Array.of(0x01 | uv), Uint8Array.of(0, 0, 0, ++counter));
      const client = clientData("webauthn.get", challenge);
      const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, concat(authData, await sha256(client))));
      return { id: b64url(id), rawId: b64url(id), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64url(client), authenticatorData: b64url(authData), signature: b64url(der(signature)) } };
    },
  };
}

/** A browser: keeps cookies between calls. */
function browser() {
  const jar = new Map<string, string>();
  return {
    jar,
    async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(ORIGIN + path, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { origin: ORIGIN, "x-boxox-csrf": "1", "content-type": "application/json", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...extra },
      }), bindings, ctx);
      await waitOnExecutionContext(ctx);
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attributes] = line.split(";");
        const [name, value] = pair!.split("=");
        if (!value || attributes.some((a) => /max-age=0/i.test(a))) jar.delete(name!); else jar.set(name!, value);
      }
      return response;
    },
  };
}
const invite = (email = OWNER, name = "Owner") => createInvite(env.DB, { email, name, createdBy: "installer", ttlMs: OWNER_LINK_MS });
async function claim(b: ReturnType<typeof browser>, code: string, device = authenticator()) {
  const key = await device;
  const begin = await b.call("POST", "/api/auth/invite/begin", { code });
  if (begin.status !== 200) return { begin, key };
  const { options } = await begin.json() as { options: { challenge: string } };
  const finish = await b.call("POST", "/api/auth/invite/finish", { response: await key.create(options.challenge), name: "Laptop" });
  return { begin, finish, key };
}
async function login(b: ReturnType<typeof browser>, key: Awaited<ReturnType<typeof authenticator>>) {
  const { options } = await (await b.call("POST", "/api/auth/login/begin")).json() as { options: { challenge: string } };
  return b.call("POST", "/api/auth/login/finish", { response: await key.get(options.challenge) });
}

describe("Box Ox sign-in", () => {
  it("the installer's link makes the owner a passkey, signs them in, and cannot be used twice", async () => {
    const code = await invite(), b = browser();
    const { finish, key } = await claim(b, code);
    expect(finish!.status).toBe(200);
    expect(await finish!.json()).toEqual({ user: { id: OWNER, email: OWNER, name: "Owner", role: "owner" } });
    const me = await b.call("GET", "/api/me");
    expect(await me.json()).toMatchObject({ user: { email: OWNER, role: "owner" }, signin: "native" });
    expect((await (await b.call("GET", "/api/auth/state")).json() as { ownerReady: boolean }).ownerReady).toBe(true);

    // The cookie is unguessable, HttpOnly and only its hash is stored.
    const token = b.jar.get(SESSION_COOKIE)!;
    const row = await env.DB.prepare("SELECT token_hash FROM auth_sessions").first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await sha256Hex(token));
    expect(row!.token_hash).not.toBe(token);
    const stored = await env.DB.prepare("SELECT code_hash, used_at FROM auth_invites").first<{ code_hash: string; used_at: number }>();
    expect(stored!.code_hash).not.toContain(code);
    expect(stored!.used_at).toBeGreaterThan(0);

    const again = await claim(browser(), code);
    expect(again.begin.status).toBe(404);
    expect(await login(browser(), key).then((r) => r.status)).toBe(200);
  });

  it("refuses unknown, expired and half-used links, and passkeys nobody registered", async () => {
    expect((await claim(browser(), "x".repeat(43))).begin.status).toBe(404);
    const expired = await createInvite(env.DB, { email: OWNER, name: "", createdBy: "installer", ttlMs: -1 });
    expect((await claim(browser(), expired)).begin.status).toBe(404);

    // Two browsers open the same link; only the first to finish gets in.
    const code = await invite(), first = browser(), second = browser();
    const keyA = await authenticator(), keyB = await authenticator();
    const a = await (await first.call("POST", "/api/auth/invite/begin", { code })).json() as { options: { challenge: string } };
    const bb = await (await second.call("POST", "/api/auth/invite/begin", { code })).json() as { options: { challenge: string } };
    expect((await first.call("POST", "/api/auth/invite/finish", { response: await keyA.create(a.options.challenge) })).status).toBe(200);
    expect((await second.call("POST", "/api/auth/invite/finish", { response: await keyB.create(bb.options.challenge) })).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_passkeys").first()).toEqual({ n: 1 });

    const stranger = await login(browser(), keyB);
    expect(stranger.status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_sessions").first()).toEqual({ n: 1 });
  });

  it("rejects a passkey made for another site, without the device unlock, or against a replayed challenge", async () => {
    for (const forged of [{ origin: "https://evil.example.test" }, { rpId: "evil.example.test" }, { userVerified: false }]) {
      const result = await claim(browser(), await invite(), authenticator(forged));
      expect(result.finish!.status, JSON.stringify(forged)).toBe(400);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_passkeys").first()).toEqual({ n: 0 });

    const b = browser(), { key } = await claim(b, await invite());
    const fresh = browser();
    const { options } = await (await fresh.call("POST", "/api/auth/login/begin")).json() as { options: { challenge: string } };
    const assertion = await key.get(options.challenge);
    expect((await fresh.call("POST", "/api/auth/login/finish", { response: assertion })).status).toBe(200);
    // The challenge is gone after one use, even from the same browser.
    expect((await fresh.call("POST", "/api/auth/login/finish", { response: assertion })).status).toBe(401);
    // And a challenge issued to one browser is useless in another.
    const other = browser();
    const begun = await (await browser().call("POST", "/api/auth/login/begin")).json() as { options: { challenge: string } };
    expect((await other.call("POST", "/api/auth/login/finish", { response: await key.get(begun.options.challenge) })).status).toBe(401);
  });

  it("signing out ends the session on the server, and cross-site requests are refused", async () => {
    const b = browser();
    await claim(b, await invite());
    const stolen = b.jar.get(SESSION_COOKIE)!;
    expect((await b.call("POST", "/api/auth/logout", undefined, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await b.call("GET", "/api/me")).status).toBe(200);
    expect((await b.call("POST", "/api/auth/logout")).status).toBe(200);
    const thief = browser(); thief.jar.set(SESSION_COOKIE, stolen);
    expect((await thief.call("GET", "/api/me")).status).toBe(401);
    await env.DB.prepare("INSERT INTO auth_sessions (token_hash, user_email, created_at, last_seen_at, expires_at) VALUES (?, ?, 1, 1, 2)").bind(await sha256Hex("old-session-token"), OWNER).run();
    const late = browser(); late.jar.set(SESSION_COOKIE, "old-session-token");
    expect((await late.call("GET", "/api/me")).status).toBe(401);
  });

  it("only the owner invites and removes members; a removed member is signed out everywhere", async () => {
    const owner = browser();
    await claim(owner, await invite());
    const made = await owner.call("POST", "/api/auth/members", { email: "Pat@Example.Test", name: "Pat" });
    const { link, email } = await made.json() as { link: string; email: string };
    expect(email).toBe("pat@example.test");
    expect(link.startsWith(`${ORIGIN}/welcome#`)).toBe(true);

    const member = browser();
    const joined = await claim(member, link.split("#")[1]!);
    expect(await joined.finish!.json()).toMatchObject({ user: { email: "pat@example.test", role: "member" } });
    expect((await member.call("GET", "/api/settings/processing")).status).toBe(403);
    expect((await member.call("GET", "/api/auth/members")).status).toBe(403);
    expect((await member.call("POST", "/api/auth/members", { email: "friend@example.test" })).status).toBe(403);
    expect((await member.call("DELETE", `/api/auth/members/${encodeURIComponent(OWNER)}`)).status).toBe(403);

    const list = await (await owner.call("GET", "/api/auth/members")).json() as { members: { email: string; role: string; passkeys: number }[] };
    expect(list.members.map((m) => [m.email, m.role, m.passkeys])).toEqual([[OWNER, "owner", 1], ["pat@example.test", "member", 1]]);
    expect((await owner.call("DELETE", `/api/auth/members/${encodeURIComponent(OWNER)}`)).status).toBe(409);
    expect((await owner.call("DELETE", "/api/auth/members/pat%40example.test")).status).toBe(200);
    expect((await member.call("GET", "/api/me")).status).toBe(401);
    expect((await login(browser(), joined.key)).status).toBe(401);
  });

  it("a person can add a second passkey and cannot remove their last one", async () => {
    const b = browser(), { key } = await claim(b, await invite());
    expect((await b.call("DELETE", `/api/auth/passkeys/${key.id}`)).status).toBe(409);
    const second = await authenticator();
    const { options } = await (await b.call("POST", "/api/auth/passkeys/begin")).json() as { options: { challenge: string; excludeCredentials: { id: string }[] } };
    expect(options.excludeCredentials.map((c) => c.id)).toEqual([key.id]);
    expect((await b.call("POST", "/api/auth/passkeys/finish", { response: await second.create(options.challenge), name: "Phone" })).status).toBe(200);
    const list = await (await b.call("GET", "/api/auth/passkeys")).json() as { passkeys: { id: string; name: string }[] };
    expect(list.passkeys.map((p) => p.name)).toEqual(["Laptop", "Phone"]);
    expect((await b.call("DELETE", `/api/auth/passkeys/${key.id}`)).status).toBe(200);
    expect((await login(browser(), key)).status).toBe(401);
    expect((await login(browser(), second)).status).toBe(200);
  });

  it("limits attempts per address before doing any work", async () => {
    const keys: string[] = [];
    const limited = { ...bindings, SIGNIN_RATE_LIMIT: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: false }; } } };
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${ORIGIN}/api/auth/invite/begin`, { method: "POST", body: JSON.stringify({ code: await invite() }), headers: { origin: ORIGIN, "x-boxox-csrf": "1", "cf-connecting-ip": "203.0.113.9" } }), limited as never, ctx);
    expect(response.status).toBe(429);
    expect(keys).toEqual(["203.0.113.9"]);
    await waitOnExecutionContext(ctx);
  });

  it("with Cloudflare Access configured, Box Ox sign-in is switched off", async () => {
    const ctx = createExecutionContext();
    const access = { ...bindings, ACCESS_AUD: "aud", TEAM_DOMAIN: "https://your-team.cloudflareaccess.com" };
    const response = await worker.fetch(new Request(`${ORIGIN}/api/auth/login/begin`, { method: "POST", headers: { origin: ORIGIN, "x-boxox-csrf": "1" } }), access, ctx);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { message: "Cloudflare Access login required" } });
    await waitOnExecutionContext(ctx);
  });
});
