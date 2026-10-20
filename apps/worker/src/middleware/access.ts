import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { log } from "../log";
import type { AppContext } from "./index";

/**
 * Paths Access must not cover (docs/v2-plan.md, "Access exclusions"). They carry
 * their own credentials: OAuth/JWT for agents, API keys for /dev/v1, signed URLs
 * for tracking and downloads. /oauth/authorize is the consent page and stays behind Access.
 */
const PUBLIC_EXACT = new Set(["/mcp", "/oauth/token", "/oauth/register", "/api/agent", "/dev/v1", "/health"]);
const PUBLIC_PREFIXES = ["/mcp/", "/.well-known/", "/api/agent/", "/dev/v1/", "/t/", "/f/", "/health/"];

export function bypassesAccess(path: string): boolean {
  return PUBLIC_EXACT.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

/** Accepts "you.cloudflareaccess.com" or "https://you.cloudflareaccess.com/". */
export function teamOrigin(teamDomain: string): string {
  const withScheme = /^https?:\/\//i.test(teamDomain) ? teamDomain : `https://${teamDomain}`;
  return new URL(withScheme).origin;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function remoteKeys(issuer: string): JWTVerifyGetKey {
  let keys = remoteKeySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteKeySets.set(issuer, keys);
  }
  return keys;
}

function deny(status: 401 | 403 | 503, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Fails closed: until ACCESS_AUD and TEAM_DOMAIN are set, every request outside
 * the agent and developer paths is refused. With them set, the Access JWT must
 * verify against the team's keys, issuer and audience.
 */
export function createAccessMiddleware(opts: { keys?: (issuer: string) => JWTVerifyGetKey } = {}) {
  const keysFor = opts.keys ?? remoteKeys;
  return createMiddleware<AppContext>(async (c, next) => {
    if (bypassesAccess(c.req.path)) return next();

    const aud = c.env.ACCESS_AUD?.trim();
    const teamDomain = c.env.TEAM_DOMAIN?.trim();
    if (!aud || !teamDomain) {
      return deny(503, "access_not_configured", "Cloudflare Access is not configured");
    }

    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) return deny(401, "unauthorized", "Cloudflare Access login required");

    let issuer: string;
    try {
      issuer = teamOrigin(teamDomain);
    } catch {
      return deny(503, "access_not_configured", "TEAM_DOMAIN is not a valid hostname");
    }

    let email: string;
    let name: string;
    try {
      const { payload } = await jwtVerify(token, keysFor(issuer), { issuer, audience: aud });
      if (typeof payload.email !== "string" || !payload.email) {
        return deny(403, "forbidden", "Access identity has no email");
      }
      email = payload.email.toLowerCase();
      name = typeof payload.name === "string" ? payload.name : email;
    } catch (err) {
      log.warn("access_jwt_rejected", { path: c.req.path, reason: (err as Error).name });
      return deny(401, "unauthorized", "Cloudflare Access login required");
    }

    // Owner and grants are resolved per request by the routes that need them.
    const role = c.env.OWNER_EMAIL?.trim().toLowerCase() === email ? "owner" : "member";
    c.set("user", { id: email, email, name, role });
    await next();
  });
}

export const requireAccess = createAccessMiddleware();
