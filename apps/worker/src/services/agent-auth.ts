import { SignJWT, jwtVerify } from "jose";
import type { Env } from "../env";

/**
 * Agent credential + token primitives (M3). Security-critical:
 *
 * - JWTs are HS256 only. Verification PINS `algorithms: ["HS256"]` and validates
 *   `aud="boxox-agent-api"` + `exp`; there is no other accepted algorithm, so an
 *   `alg:none` / RS256-confusion downgrade is impossible.
 * - Secrets and pairing codes carry >=128 bits from `crypto.getRandomValues`,
 *   emitted as base64url. They are never stored in plaintext — only their
 *   SHA-256 hash is persisted, and all secret-derived checks go through
 *   `constantTimeEqualHex` (workerd has no `crypto.subtle.timingSafeEqual`).
 * - Fail closed: `AGENT_JWT_SECRET` unset means every agent route 503s. Callers
 *   gate on `agentAuthConfigured` before doing anything else.
 *
 * `jti` is present but unstored: revocation is the per-request agent-status
 * check plus the status check at token issuance (documented tradeoff — a stolen
 * unexpired token stays valid for at most the 30-minute TTL unless the agent is
 * disabled, which zeroes its effective grants immediately).
 */

const AUDIENCE = "boxox-agent-api";
const TOKEN_TTL_SECONDS = 30 * 60;

/** A SHA-256 hex digest is always 64 chars; used as the "not found" placeholder. */
const DUMMY_HASH = "0".repeat(64);

export function agentAuthConfigured(env: Env): boolean {
  return typeof env.AGENT_JWT_SECRET === "string" && env.AGENT_JWT_SECRET.length > 0;
}

function signingKey(env: Env): Uint8Array {
  // HS256 accepts any byte string; the configured secret is 32B base64 (~44 chars
  // of key material). We feed its UTF-8 bytes directly rather than base64-decoding
  // so a non-base64 secret can't silently produce a short/empty key.
  return new TextEncoder().encode(env.AGENT_JWT_SECRET);
}

// ---------- random material ----------

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 24 random bytes (192 bits) → base64url. Client secret / pairing code material. */
function randomToken(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function generateClientSecret(): string {
  return randomToken(24);
}

export function generatePairingCode(): string {
  return randomToken(24);
}

/** Stable, non-secret public identifier assigned at agent creation. */
export function generateClientId(): string {
  return `boxox_agt_${randomToken(18)}`;
}

// ---------- hashing + constant-time compare ----------

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison over two SHA-256 hex digests. Both inputs are fixed
 * 64-char hashes, so the length guard leaks nothing; the XOR-accumulate loop
 * runs to completion regardless of where the first mismatch is.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a presented secret against a stored hash in constant time. When
 * `storedHash` is null (no such agent / never paired) we still hash the input
 * and compare against a dummy digest so absent-credential timing matches the
 * wrong-secret path.
 */
export async function verifySecret(
  presented: string,
  storedHash: string | null,
): Promise<boolean> {
  const presentedHash = await sha256Hex(presented);
  const target = storedHash ?? DUMMY_HASH;
  const match = constantTimeEqualHex(presentedHash, target);
  return storedHash !== null && match;
}

// ---------- JWT mint / verify ----------

export async function mintAgentToken(
  env: Env,
  agentId: string,
  organizationId: string,
): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ org: organizationId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(`agent:${agentId}`)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SECONDS)
    .setJti(randomToken(16))
    .sign(signingKey(env));
  return { token, expiresIn: TOKEN_TTL_SECONDS };
}

export interface AgentTokenClaims {
  agentId: string;
  organizationId: string;
}

export async function verifyAgentToken(
  env: Env,
  token: string,
): Promise<AgentTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(env), {
      algorithms: ["HS256"],
      audience: AUDIENCE,
    });
    const sub = payload.sub;
    const org = payload.org;
    if (typeof sub !== "string" || !sub.startsWith("agent:")) return null;
    if (typeof org !== "string" || org.length === 0) return null;
    const agentId = sub.slice("agent:".length);
    if (!agentId) return null;
    return { agentId, organizationId: org };
  } catch {
    return null;
  }
}
