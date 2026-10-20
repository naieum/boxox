import OAuthProvider, {
  getOAuthApi,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { createDb } from "../db";
import type { Env } from "../env";
import { mcpApiHandler } from "../mcp/handler";
import type { McpProps } from "../mcp/auth";
import { agentAuthConfigured, verifyAgentToken } from "../services/agent-auth";
import { rateLimitHit } from "../services/agent-rate-limit";

/**
 * Workers OAuth Provider v1 in front of the whole Worker: it serves
 * /oauth/token, /oauth/register and the /.well-known metadata itself, verifies
 * bearer tokens on /mcp, and hands everything else (including the
 * Access-protected /oauth/authorize consent page) to the Hono app. Its state
 * lives in the KV binding.
 */

export const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register",
} as const;

/** Access tokens are short-lived; clients refresh, and a revoke stops refreshes. */
export const ACCESS_TOKEN_TTL = 60 * 60;
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;
/** Client registrations per IP per 15 minutes. */
export const REGISTRATIONS_PER_IP = 10;

const API_KEY_PREFIXES = ["bxm_", "bxk_"];

export type OAuthEnv = Env & { OAUTH_KV: KVNamespace; OAUTH_PROVIDER?: OAuthHelpers };

type FetchHandler = { fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> };

/** PUBLIC_URL when set; otherwise the request's own origin. */
export function publicOrigin(env: Env, request: Request): string {
  return new URL(env.PUBLIC_URL?.trim() || request.url).origin;
}

export function oauthEnv(env: Env): OAuthEnv {
  return { ...env, OAUTH_KV: env.KV };
}

function providerOptions(origin: string, defaultHandler: FetchHandler): OAuthProviderOptions<OAuthEnv> {
  const resource = `${origin}/mcp`;
  return {
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler,
    authorizeEndpoint: OAUTH_PATHS.authorize,
    tokenEndpoint: OAUTH_PATHS.token,
    clientRegistrationEndpoint: OAUTH_PATHS.register,
    accessTokenTTL: ACCESS_TOKEN_TTL,
    refreshTokenTTL: REFRESH_TOKEN_TTL,
    resourceMetadata: { resource, authorization_servers: [origin], resource_name: "Box Ox mail" },
    // Paired script agents keep using their agent JWT. API keys (management or
    // domain) are never accepted here: they fall through to 401.
    resolveExternalToken: async ({ token, env }) => {
      if (API_KEY_PREFIXES.some((p) => token.startsWith(p)) || !agentAuthConfigured(env)) return null;
      const claims = await verifyAgentToken(env, token);
      if (!claims) return null;
      const props: McpProps = { agentId: claims.agentId, organizationId: claims.organizationId };
      return { props, audience: resource };
    },
  };
}

const unusedDefault: FetchHandler = { fetch: () => new Response(null, { status: 404 }) };

/** The provider's helpers (lookupClient, completeAuthorization, revokeGrant, …) for this install. */
export function oauthApi(env: Env, origin: string): OAuthHelpers {
  return getOAuthApi(providerOptions(origin, unusedDefault), oauthEnv(env));
}

/** Wraps the app's fetch with the provider; one provider per public origin. */
export function withOAuth(app: FetchHandler) {
  const providers = new Map<string, OAuthProvider<OAuthEnv>>();
  return async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const origin = publicOrigin(env, request);
    let provider = providers.get(origin);
    if (!provider) {
      provider = new OAuthProvider(providerOptions(origin, app));
      providers.set(origin, provider);
    }
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === OAUTH_PATHS.register) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const hit = await rateLimitHit(createDb(env), `oauth-register:ip:${ip}`, REGISTRATIONS_PER_IP);
      if (!hit.allowed) {
        return Response.json(
          { error: "too_many_requests", error_description: "Too many client registrations; try again later" },
          { status: 429 },
        );
      }
    }
    return provider.fetch(request, oauthEnv(env), ctx);
  };
}
