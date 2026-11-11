import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../env";
import type { AppContext, SessionUser } from "../middleware";

/**
 * Box Ox sign-in: passkeys, for installations without Cloudflare Access.
 *
 * Nothing here can be guessed or replayed into a session. A passkey proves
 * possession of a device key and a local unlock. A person gets their first
 * passkey only through a single-use link: the owner's is written to the
 * database by the installer (whoever controls the Cloudflare account), and a
 * member's is made by the owner.
 */

export const SESSION_COOKIE = "__Host-boxox-session";
const CHALLENGE_COOKIE = "__Host-boxox-signin";
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;
const CHALLENGE_SECONDS = 300;
export const OWNER_LINK_MS = 24 * 3_600_000;
export const MEMBER_LINK_MS = 7 * 86_400_000;

export function signinMode(env: Pick<Env, "ACCESS_AUD" | "TEAM_DOMAIN">): "access" | "native" {
  return env.ACCESS_AUD?.trim() && env.TEAM_DOMAIN?.trim() ? "access" : "native";
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const normalEmail = (value: string) => value.trim().toLowerCase();

/** The passkey is bound to the app's own hostname; another site cannot use it. */
function relyingParty(c: Context<AppContext>) {
  const url = new URL(c.env.PUBLIC_URL || c.req.url);
  return { id: url.hostname, origin: url.origin, name: "Box Ox" };
}
const roleOf = (env: Env, email: string) => (normalEmail(env.OWNER_EMAIL ?? "") === email ? "owner" : "member");

// Sessions

export async function startSession(c: Context<AppContext>, email: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO auth_sessions (token_hash, user_email, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), email, now, now, now + SESSION_MS).run();
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86_400 });
}

export async function sessionUser(c: Context<AppContext>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const hash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    "SELECT s.user_email AS email, s.expires_at AS expiresAt, s.last_seen_at AS lastSeenAt, u.name AS name FROM auth_sessions s JOIN auth_users u ON u.email = s.user_email WHERE s.token_hash = ?",
  ).bind(hash).first<{ email: string; expiresAt: number; lastSeenAt: number; name: string }>();
  const now = Date.now();
  if (!row || row.expiresAt <= now) return null;
  // Slide the expiry at most hourly so reading mail does not write on every request.
  if (now - row.lastSeenAt > 3_600_000) {
    await c.env.DB.prepare("UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").bind(now, now + SESSION_MS, hash).run();
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86_400 });
  }
  return { id: row.email, email: row.email, name: row.name || row.email, role: roleOf(c.env, row.email) };
}

export async function endSession(c: Context<AppContext>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token && token.length <= 128) await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { secure: true, path: "/" });
}

// Challenges: one per browser, five minutes, single use.

interface Challenge { challenge: string; kind: "invite" | "login" | "add"; email?: string; inviteHash?: string }

async function saveChallenge(c: Context<AppContext>, value: Challenge): Promise<void> {
  const id = randomToken();
  await c.env.KV.put(`signin-challenge:${id}`, JSON.stringify(value), { expirationTtl: CHALLENGE_SECONDS });
  setCookie(c, CHALLENGE_COOKIE, id, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: CHALLENGE_SECONDS });
}

async function takeChallenge(c: Context<AppContext>, kind: Challenge["kind"]): Promise<Challenge | null> {
  const id = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { secure: true, path: "/" });
  if (!id || id.length > 128) return null;
  const key = `signin-challenge:${id}`;
  const raw = await c.env.KV.get(key);
  if (!raw) return null;
  await c.env.KV.delete(key);
  const value = JSON.parse(raw) as Challenge;
  return value.kind === kind ? value : null;
}

// Invites

export async function createInvite(db: D1Database, input: { email: string; name: string; createdBy: string; ttlMs: number }): Promise<string> {
  const code = randomToken();
  const now = Date.now();
  await db.prepare("INSERT INTO auth_invites (code_hash, user_email, user_name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(code), normalEmail(input.email), input.name.trim(), input.createdBy, now, now + input.ttlMs).run();
  return code;
}

async function openInvite(db: D1Database, code: string) {
  if (!code || code.length > 128) return null;
  const hash = await sha256Hex(code);
  const row = await db.prepare("SELECT user_email AS email, user_name AS name FROM auth_invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(hash, Date.now()).first<{ email: string; name: string }>();
  return row ? { ...row, hash } : null;
}

// Passkeys

interface PasskeyRow { credentialId: string; email: string; publicKey: string; counter: number; transports: string }
const passkeysOf = (db: D1Database, email: string) =>
  db.prepare("SELECT credential_id AS credentialId, transports FROM auth_passkeys WHERE user_email = ?").bind(email).all<{ credentialId: string; transports: string }>();
const transportsOf = (json: string) => { try { return JSON.parse(json) as AuthenticatorTransportFuture[]; } catch { return []; } };

async function registrationOptions(c: Context<AppContext>, email: string, name: string) {
  const rp = relyingParty(c);
  const existing = await passkeysOf(c.env.DB, email);
  return generateRegistrationOptions({
    rpName: rp.name, rpID: rp.id, userName: email, userDisplayName: name || email,
    userID: new TextEncoder().encode(email) as Uint8Array<ArrayBuffer>,
    attestationType: "none",
    excludeCredentials: existing.results.map((p) => ({ id: p.credentialId, transports: transportsOf(p.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
}

async function verifiedRegistration(c: Context<AppContext>, response: RegistrationResponseJSON, challenge: string) {
  const rp = relyingParty(c);
  const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true });
  if (!result.verified || !result.registrationInfo) return null;
  return result.registrationInfo.credential;
}

const insertPasskey = (db: D1Database, email: string, credential: { id: string; publicKey: Uint8Array; counter: number; transports?: AuthenticatorTransportFuture[] }, name: string) =>
  db.prepare("INSERT INTO auth_passkeys (credential_id, user_email, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(credential.id, email, b64url(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), name.trim().slice(0, 80) || "Passkey", Date.now());

/** Step 1 of a link: show who it is for and ask the browser to create a passkey. */
export async function beginInvite(c: Context<AppContext>, code: string) {
  const invite = await openInvite(c.env.DB, code);
  if (!invite) return null;
  const options = await registrationOptions(c, invite.email, invite.name);
  await saveChallenge(c, { challenge: options.challenge, kind: "invite", email: invite.email, inviteHash: invite.hash });
  return { options, email: invite.email, role: roleOf(c.env, invite.email) };
}

/** Step 2: the link is spent in the same statement that checks it, then the person is signed in. */
export async function finishInvite(c: Context<AppContext>, response: RegistrationResponseJSON, deviceName: string): Promise<SessionUser | null> {
  const pending = await takeChallenge(c, "invite");
  if (!pending?.email || !pending.inviteHash) return null;
  const credential = await verifiedRegistration(c, response, pending.challenge).catch(() => null);
  if (!credential) return null;
  const now = Date.now();
  const spent = await c.env.DB.prepare("UPDATE auth_invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_name AS name")
    .bind(now, pending.inviteHash, now).first<{ name: string }>();
  if (!spent) return null;
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO auth_users (email, name, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = CASE WHEN excluded.name = '' THEN auth_users.name ELSE excluded.name END")
      .bind(pending.email, spent.name, now),
    insertPasskey(c.env.DB, pending.email, credential, deviceName),
  ]);
  await startSession(c, pending.email);
  return { id: pending.email, email: pending.email, name: spent.name || pending.email, role: roleOf(c.env, pending.email) };
}

/** No address is typed: the browser offers the passkeys it holds for this app. */
export async function beginLogin(c: Context<AppContext>) {
  const options = await generateAuthenticationOptions({ rpID: relyingParty(c).id, userVerification: "required", allowCredentials: [] });
  await saveChallenge(c, { challenge: options.challenge, kind: "login" });
  return options;
}

export async function finishLogin(c: Context<AppContext>, response: AuthenticationResponseJSON): Promise<SessionUser | null> {
  const pending = await takeChallenge(c, "login");
  if (!pending || typeof response?.id !== "string" || response.id.length > 1024) return null;
  const row = await c.env.DB.prepare(
    "SELECT p.credential_id AS credentialId, p.user_email AS email, p.public_key AS publicKey, p.counter, p.transports, u.name AS name FROM auth_passkeys p JOIN auth_users u ON u.email = p.user_email WHERE p.credential_id = ?",
  ).bind(response.id).first<PasskeyRow & { name: string }>();
  if (!row) return null;
  const rp = relyingParty(c);
  const result = await verifyAuthenticationResponse({
    response, expectedChallenge: pending.challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true,
    credential: { id: row.credentialId, publicKey: fromB64url(row.publicKey), counter: row.counter, transports: transportsOf(row.transports) },
  }).catch(() => null);
  if (!result?.verified) return null;
  await c.env.DB.prepare("UPDATE auth_passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?").bind(result.authenticationInfo.newCounter, Date.now(), row.credentialId).run();
  await startSession(c, row.email);
  return { id: row.email, email: row.email, name: row.name || row.email, role: roleOf(c.env, row.email) };
}

/** A signed-in person adds another device. */
export async function beginAddPasskey(c: Context<AppContext>) {
  const user = c.get("user");
  const options = await registrationOptions(c, user.email, user.name);
  await saveChallenge(c, { challenge: options.challenge, kind: "add", email: user.email });
  return options;
}

export async function finishAddPasskey(c: Context<AppContext>, response: RegistrationResponseJSON, deviceName: string): Promise<boolean> {
  const pending = await takeChallenge(c, "add");
  if (!pending || pending.email !== c.get("user").email) return false;
  const credential = await verifiedRegistration(c, response, pending.challenge).catch(() => null);
  if (!credential) return false;
  await insertPasskey(c.env.DB, pending.email, credential, deviceName).run();
  return true;
}

export async function ownerClaimed(env: Env): Promise<boolean> {
  const owner = normalEmail(env.OWNER_EMAIL ?? "");
  if (!owner) return false;
  return !!(await env.DB.prepare("SELECT 1 AS present FROM auth_passkeys WHERE user_email = ? LIMIT 1").bind(owner).first());
}
