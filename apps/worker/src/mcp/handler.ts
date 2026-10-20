import { createMcpHandler } from "agents/mcp";
import { createDb } from "../db";
import type { Env } from "../env";
import { log } from "../log";
import { readMcpProps, resolveMcpPrincipal } from "./auth";
import { buildMcpServer } from "./server";

/**
 * The OAuth provider's API handler for /mcp. By the time a request lands here
 * the provider has verified the bearer token and put the grant's props on
 * ctx.props; this resolves them to a live agent principal and serves one
 * stateless MCP exchange for it.
 */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = readMcpProps((ctx as ExecutionContext & { props?: unknown }).props);
    if (!props) return Response.json({ error: { code: "unauthorized", message: "Invalid token" } }, { status: 401 });

    const db = createDb(env);
    const auth = await resolveMcpPrincipal(db, props);
    if (!auth.ok) {
      return Response.json({ error: { code: auth.code, message: auth.message } }, { status: auth.status });
    }
    const handler = createMcpHandler(() => buildMcpServer({ env, db, agent: auth.agent, grants: auth.grants }), {
      route: "/mcp",
      onerror: (error) => log.error("mcp_error", { error }),
    });
    return handler(request, env, ctx);
  },
};
