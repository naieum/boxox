import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { log, redact } from "../src/log";
import {
  createAccessMiddleware,
  CSRF_HEADER,
  requireSameOrigin,
  requireSession,
  requireOwner,
  securityHeaders,
  type AppContext,
} from "../src/middleware";

const AUD = "test-aud-0001";
const TEAM = "https://boxox-test.cloudflareaccess.com";
const APP = "https://mail.example.test";

let privateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

function accessJwt(claims: { aud?: string; iss?: string; email?: string } = {}) {
  return new SignJWT({ email: claims.email ?? "Owner@Example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(claims.iss ?? TEAM)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function buildApp() {
  const app = new Hono<AppContext>()
    .use("*", securityHeaders)
    .use("*", createAccessMiddleware({ keys: () => keys }))
    .use("*", requireSameOrigin);
  for (const path of ["/api/orgs/o1/threads", "/setup", "/oauth/authorize", "/"]) {
    app.get(path, requireSession, (c) => c.json({ user: c.get("user") }));
  }
  app.post("/api/orgs/o1/send", requireSession, (c) => c.json({ sent: true }));
  app.put("/api/setup/processing", requireSession, requireOwner, (c) => c.json({ updated: true }));
  for (const path of [
    "/mcp",
    "/oauth/token",
    "/oauth/register",
    "/.well-known/oauth-authorization-server",
    "/api/agent/pair",
    "/api/agent/v1/threads",
    "/dev/v1/messages",
    "/t/open/abc",
    "/f/file123",
  ]) {
    app.all(path, (c) => c.json({ reached: path }));
  }
  app.get("/attachment", (c) =>
    c.body("x", 200, { "Content-Security-Policy": "sandbox", "Content-Disposition": "attachment" }),
  );
  return app;
}

function env(overrides: Partial<Env> = {}): Env {
  return { ACCESS_AUD: AUD, TEAM_DOMAIN: TEAM, ...overrides } as Env;
}

describe("Access middleware", () => {
  it("refuses installation changes by invited members", async () => {
    const app = buildApp();
    for (const [email, expected] of [["owner@example.test", 200], ["invited@example.test", 403]] as const) {
      const response = await app.request(`${APP}/api/setup/processing`, {
        method: "PUT",
        headers: { "cf-access-jwt-assertion": await accessJwt({ email }), origin: APP, [CSRF_HEADER]: "1" },
      }, env({ OWNER_EMAIL: "owner@example.test" }));
      expect(response.status).toBe(expected);
    }
  });

  it("grants owner access only to the configured verified installer identity", async () => {
    const app = buildApp();
    for (const [configured, expected] of [[" OWNER@example.test ", "owner"], ["other@example.test", "member"], [undefined, "member"]] as const) {
      const response = await app.request(`${APP}/`, {
        headers: { "cf-access-jwt-assertion": await accessJwt() },
      }, env({ OWNER_EMAIL: configured }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ user: { email: "owner@example.test", role: expected } });
    }
  });

  it("refuses every app request while ACCESS_AUD or TEAM_DOMAIN is unset", async () => {
    const app = buildApp();
    const token = await accessJwt();
    const unset: Partial<Env>[] = [
      { ACCESS_AUD: undefined },
      { TEAM_DOMAIN: undefined },
      { ACCESS_AUD: "", TEAM_DOMAIN: "" },
      { ACCESS_AUD: "  " },
    ];
    for (const overrides of unset) {
      for (const path of ["/api/orgs/o1/threads", "/setup", "/oauth/authorize", "/"]) {
        const res = await app.request(
          `${APP}${path}`,
          { headers: { "cf-access-jwt-assertion": token } },
          env(overrides),
        );
        expect(res.status, `${path} with ${JSON.stringify(overrides)}`).toBe(503);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("access_not_configured");
      }
    }

    // Configured, the same token is accepted, so the refusals above were the missing settings.
    const ok = await app.request(
      `${APP}/api/orgs/o1/threads`,
      { headers: { "cf-access-jwt-assertion": token } },
      env(),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ user: { email: "owner@example.test" } });
  });

  it("rejects a missing, forged or wrong-audience Access JWT", async () => {
    const app = buildApp();
    const cases: Record<string, string>[] = [
      {},
      { "cf-access-jwt-assertion": "not-a-jwt" },
      { "cf-access-jwt-assertion": await accessJwt({ aud: "other-app" }) },
      { "cf-access-jwt-assertion": await accessJwt({ iss: "https://evil.cloudflareaccess.com" }) },
    ];
    const other = await generateKeyPair("RS256");
    cases.push({
      "cf-access-jwt-assertion": await new SignJWT({ email: "x@evil.test" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(TEAM)
        .setAudience(AUD)
        .setExpirationTime("5m")
        .sign(other.privateKey),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const headers of cases) {
      const res = await app.request(`${APP}/api/orgs/o1/threads`, { headers }, env());
      expect(res.status).toBe(401);
    }
    vi.restoreAllMocks();
  });

  it("lets agent and developer paths through without Access", async () => {
    const app = buildApp();
    for (const e of [env(), env({ ACCESS_AUD: undefined, TEAM_DOMAIN: undefined })]) {
      for (const path of [
        "/mcp",
        "/oauth/token",
        "/oauth/register",
        "/.well-known/oauth-authorization-server",
        "/api/agent/pair",
        "/api/agent/v1/threads",
        "/dev/v1/messages",
        "/t/open/abc",
        "/f/file123",
      ]) {
        const get = await app.request(`${APP}${path}`, {}, e);
        expect(get.status, path).toBe(200);
        expect(await get.json()).toEqual({ reached: path });
        // Bearer-authenticated, so no Origin or CSRF header is needed for writes either.
        const post = await app.request(`${APP}${path}`, { method: "POST" }, e);
        expect(post.status, `POST ${path}`).toBe(200);
      }
    }
    // Lookalike paths are not excluded.
    for (const path of ["/oauth/authorize", "/api/agentx", "/mcpx", "/dev/v2/messages"]) {
      const res = await app.request(`${APP}${path}`, {}, env());
      expect(res.status, path).toBe(401);
    }
  });
});

describe("CSRF", () => {
  async function post(headers: Record<string, string>) {
    return buildApp().request(
      `${APP}/api/orgs/o1/send`,
      { method: "POST", headers: { "cf-access-jwt-assertion": await accessJwt(), ...headers } },
      env(),
    );
  }

  it("rejects a mutating request with a foreign Origin", async () => {
    const foreign = await post({ origin: "https://evil.example", [CSRF_HEADER]: "1" });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { code: "csrf_rejected" } });

    expect((await post({ origin: "null", [CSRF_HEADER]: "1" })).status).toBe(403);
    expect((await post({ origin: "http://mail.example.test", [CSRF_HEADER]: "1" })).status).toBe(403);
    expect((await post({ [CSRF_HEADER]: "1" })).status).toBe(403);
    expect((await post({ origin: APP })).status).toBe(403);

    const same = await post({ origin: APP, [CSRF_HEADER]: "1" });
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ sent: true });
  });
});

describe("security headers", () => {
  it("sets a strict CSP with frame-ancestors 'none'", async () => {
    const app = buildApp();
    const token = await accessJwt();
    const responses = [
      await app.request(`${APP}/`, { headers: { "cf-access-jwt-assertion": token } }, env()),
      await app.request(`${APP}/api/orgs/o1/threads`, {}, env()),
      await app.request(`${APP}/setup`, {}, env({ ACCESS_AUD: undefined })),
      await app.request(`${APP}/dev/v1/messages`, {}, env()),
    ];
    for (const res of responses) {
      const csp = res.headers.get("content-security-policy") ?? "";
      const directives = Object.fromEntries(
        csp.split(";").map((d) => {
          const [name, ...values] = d.trim().split(/\s+/);
          return [name, values.join(" ")];
        }),
      );
      expect(directives["frame-ancestors"]).toBe("'none'");
      expect(directives["default-src"]).toBe("'self'");
      expect(directives["script-src"]).toBe("'self'");
      expect(directives["object-src"]).toBe("'none'");
      expect(directives["base-uri"]).toBe("'none'");
      expect(csp).not.toContain("unsafe-eval");
      expect(directives["script-src"]).not.toContain("unsafe-inline");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    }

    const attachment = await app.request(
      `${APP}/attachment`,
      { headers: { "cf-access-jwt-assertion": token } },
      env(),
    );
    expect(attachment.headers.get("content-security-policy")).toBe("sandbox");
    expect(attachment.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("logger", () => {
  it("does not log mail data embedded in database exception messages", () => {
    const detail = "SYNTHETIC-PRIVATE-SUBJECT-AND-SNIPPET";
    const result = redact({ error: new Error(`Failed query: insert into messages ...\nparams: ${detail}`), messageId: "m-safe" });
    expect(JSON.stringify(result)).not.toContain(detail);
    expect(result).toMatchObject({ messageId: "m-safe", error: { name: "Error", message: "[database error details redacted]" } });
  });

  it("redacts public bearer URLs in request paths and error messages", () => {
    const cap = "fixturePublicShare000001";
    const paths = [`/f/${cap}/download`, `/api/link/${cap}.signature`, `/api/image-proxy/${cap}.signature`, `/t/o/${cap}`, `/t/c/${cap}`];
    for (const path of paths) {
      const output = JSON.stringify(redact({ path, error: new Error(`failed https://mail.example.test${path}`) }));
      expect(output).not.toContain(cap);
      expect(output).toContain("[redacted]");
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("logger never prints message bodies, headers or tokens", () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);

    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.c2lnbmF0dXJlLXNlY3JldA";
    const secrets = [
      "MAIL-BODY-SECRET",
      "<p>HTML-BODY-SECRET</p>",
      "SUBJECT-SECRET",
      "HEADER-VALUE-SECRET",
      "COOKIE-SECRET",
      "PLAIN-TOKEN-SECRET",
      "AUTH-HEADER-SECRET",
      "PAIRING-SECRET",
      "bxk_fakeDomainKey0001",
      jwt,
    ];

    log.info("message_received", {
      messageId: "m-123",
      body: "MAIL-BODY-SECRET",
      html: "<p>HTML-BODY-SECRET</p>",
      textBody: "MAIL-BODY-SECRET",
      subject: "SUBJECT-SECRET",
      headers: { "x-custom": "HEADER-VALUE-SECRET" },
      rawHeaders: new Headers({ cookie: "COOKIE-SECRET" }),
      nested: { parsed: { htmlBody: "<p>HTML-BODY-SECRET</p>", attachments: ["MAIL-BODY-SECRET"] } },
    });
    log.warn("agent_auth_failed", {
      token: "PLAIN-TOKEN-SECRET",
      authorization: "Bearer AUTH-HEADER-SECRET",
      accessJwt: jwt,
      apiKey: "bxk_fakeDomainKey0001",
      pairingCode: "PAIRING-SECRET",
      request: new Request("https://x.test/", { headers: { cookie: "COOKIE-SECRET" } }),
    });
    log.error("send_failed", {
      error: new Error(`upstream said Bearer AUTH-HEADER-SECRET with ${jwt} for bxk_fakeDomainKey0001`),
      reason: `retrying with Bearer AUTH-HEADER-SECRET`,
    });

    expect(lines).toHaveLength(3);
    const all = lines.join("\n");
    for (const s of secrets) expect(all).not.toContain(s);

    // Non-sensitive context survives, so the logs are still useful.
    const [info, warn, error] = lines.map((l) => JSON.parse(l));
    expect(info).toMatchObject({ level: "info", event: "message_received", messageId: "m-123" });
    expect(warn).toMatchObject({ level: "warn", event: "agent_auth_failed", token: "[redacted]" });
    expect(error).toMatchObject({
      level: "error",
      event: "send_failed",
      error: { name: "Error" },
      reason: "retrying with [redacted]",
    });
    expect(error.error.message).toContain("upstream said");
  });
});
