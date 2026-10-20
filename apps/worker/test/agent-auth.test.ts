import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  agentAuthConfigured,
  constantTimeEqualHex,
  generateClientId,
  generatePairingCode,
  generateClientSecret,
  mintAgentToken,
  sha256Hex,
  verifyAgentToken,
  verifySecret,
} from "../src/services/agent-auth";

function envWith(secret?: string): Env {
  return { AGENT_JWT_SECRET: secret } as unknown as Env;
}

const SECRET = "dGVzdC1hZ2VudC1qd3Qtc2VjcmV0LTMyLWJ5dGVzISE="; // 32B base64

describe("agentAuthConfigured", () => {
  it("is false without a secret and true with one", () => {
    expect(agentAuthConfigured(envWith(undefined))).toBe(false);
    expect(agentAuthConfigured(envWith(""))).toBe(false);
    expect(agentAuthConfigured(envWith(SECRET))).toBe(true);
  });
});

describe("constantTimeEqualHex", () => {
  it("matches equal digests and rejects different ones", async () => {
    const a = await sha256Hex("hello");
    const b = await sha256Hex("hello");
    const c = await sha256Hex("world");
    expect(constantTimeEqualHex(a, b)).toBe(true);
    expect(constantTimeEqualHex(a, c)).toBe(false);
  });
  it("rejects length mismatches without throwing", () => {
    expect(constantTimeEqualHex("abcd", "abcde")).toBe(false);
  });
});

describe("credential material", () => {
  it("client ids carry the stable prefix and enough entropy", () => {
    const id = generateClientId();
    expect(id.startsWith("boxox_agt_")).toBe(true);
    expect(id.length).toBeGreaterThan("boxox_agt_".length + 20);
    expect(generateClientId()).not.toBe(id);
  });
  it("secrets and pairing codes are unique and >=128 bits", () => {
    const s1 = generateClientSecret();
    const s2 = generateClientSecret();
    const p1 = generatePairingCode();
    expect(s1).not.toBe(s2);
    expect(s1).not.toBe(p1);
    // 24 random bytes -> ~32 base64url chars
    expect(s1.length).toBeGreaterThanOrEqual(22);
  });
});

describe("verifySecret", () => {
  it("accepts the right secret and rejects the wrong one or a null hash", async () => {
    const secret = generateClientSecret();
    const hash = await sha256Hex(secret);
    expect(await verifySecret(secret, hash)).toBe(true);
    expect(await verifySecret("not-it", hash)).toBe(false);
    expect(await verifySecret(secret, null)).toBe(false);
  });
});

describe("agent token round-trip", () => {
  it("mints and verifies HS256 tokens with agent + org claims", async () => {
    const env = envWith(SECRET);
    const { token, expiresIn } = await mintAgentToken(env, "agent-1", "org-1");
    expect(expiresIn).toBe(30 * 60);
    const claims = await verifyAgentToken(env, token);
    expect(claims).toEqual({ agentId: "agent-1", organizationId: "org-1" });
  });

  it("rejects tokens signed with a different secret", async () => {
    const { token } = await mintAgentToken(envWith(SECRET), "agent-1", "org-1");
    const claims = await verifyAgentToken(envWith("another-secret-entirely"), token);
    expect(claims).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const { token } = await mintAgentToken(envWith(SECRET), "agent-1", "org-1");
    const tampered = token.slice(0, -3) + "AAA";
    expect(await verifyAgentToken(envWith(SECRET), tampered)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyAgentToken(envWith(SECRET), "not.a.jwt")).toBeNull();
  });
});
