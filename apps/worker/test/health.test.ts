import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

describe("deployment health", () => {
  it("mounts processing settings behind verified installer access", async () => {
    const issuer = "https://mount-check.cloudflareaccess.com";
    const pair = await generateKeyPair("RS256");
    const key = { ...await exportJWK(pair.publicKey), kid: "mount", alg: "RS256" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${issuer}/cdn-cgi/access/certs`);
      return Response.json({ keys: [key] });
    }));
    try {
      for (const [email, expected] of [["owner@example.test", 200], ["member@example.test", 403]] as const) {
        const token = await new SignJWT({ email })
          .setProtectedHeader({ alg: "RS256", kid: "mount" })
          .setIssuer(issuer).setAudience("mount-aud").setExpirationTime("5m").sign(pair.privateKey);
        const ctx = createExecutionContext();
        const response = await worker.fetch(new Request("https://mail.test/api/settings/processing", {
          headers: { "cf-access-jwt-assertion": token },
        }), { ...env, TEAM_DOMAIN: issuer, ACCESS_AUD: "mount-aud", OWNER_EMAIL: "owner@example.test" }, ctx);
        expect(response.status).toBe(expected);
        if (expected === 200) expect(await response.json()).toMatchObject({ processing: { ai: null } });
        await waitOnExecutionContext(ctx);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the source commit without requiring Access or exposing secrets", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://mail.test/health"), {
      ...env,
      BUILD_SHA: "test-source-commit",
      AGENT_JWT_SECRET: "never-return-this",
      BOXOX_SIGNING_SECRET: "never-return-this-either",
    }, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "test-source-commit" });
    await waitOnExecutionContext(ctx);
  });

  it("keeps the application closed until Access is configured", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://mail.test/"), {
      ...env,
      ACCESS_AUD: undefined,
      TEAM_DOMAIN: undefined,
    }, ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "access_not_configured" } });
    await waitOnExecutionContext(ctx);
  });
});
