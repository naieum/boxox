import { z } from "zod";
import { MCP_TOOLS, callMailboxTool } from "../mcp/server";
import { AgentReadError } from "../services/agent-reads";
import { isFree } from "../services/capabilities";
import { Hono } from "hono";
import { AgentError, attachAgent, type AgentEnv } from "./agent-api";

/**
 * Hand-rolled, stateless streamable-HTTP MCP server (design §3.4). Same bearer
 * auth and the same service functions as the REST API. Documented limit:
 * static-bearer clients only — no OAuth discovery / DCR this round.
 *
 * Protocol rules (binding):
 *   - JSON-RPC notifications (any id-less message) → HTTP 202, empty body.
 *   - GET /mcp → 405.
 *   - Reply application/json; tolerate the MCP-Protocol-Version header.
 *   - Tool failures (permission/not-found/bad-args) → result.isError content;
 *     malformed JSON-RPC / unknown method → JSON-RPC error object.
 */

const SERVER_INFO = { name: "boxox-agent-mcp", version: "1.0.0" };
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const TOOLS = MCP_TOOLS;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function toolText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export const mcpRoutes = new Hono<AgentEnv>()
  // GET /mcp is not a valid transport entrypoint for this stateless server.
  .get("/", (c) => c.json({ error: { code: "method_not_allowed", message: "Use POST" } }, 405))

  .post("/", attachAgent, async (c) => {
    const protocolVersion =
      c.req.header("MCP-Protocol-Version") ?? DEFAULT_PROTOCOL_VERSION;

    const body = (await c.req.json().catch(() => undefined)) as JsonRpcRequest | undefined;
    if (body === undefined || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 200);
    }

    // Notification (id-less message, e.g. notifications/initialized) → 202, no body.
    if (body.id === undefined || body.id === null) {
      return c.body(null, 202);
    }
    const id = body.id;
    const method = body.method ?? "";
    const params = (body.params ?? {}) as Record<string, unknown>;

    const rpcError = (code: number, message: string) =>
      c.json({ jsonrpc: "2.0", id, error: { code, message } }, 200);
    const rpcResult = (result: unknown) => c.json({ jsonrpc: "2.0", id, result }, 200);

    if (method === "initialize") {
      const requested = params.protocolVersion;
      return rpcResult({
        protocolVersion: typeof requested === "string" ? requested : protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    if (method === "tools/list") {
      return rpcResult({ tools: isFree(c.env) ? TOOLS.filter(tool => tool.name !== "send_email") : TOOLS });
    }

    if (method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const known = TOOLS.some((t) => t.name === name);
      if (!known) {
        return rpcError(-32602, `Unknown tool: ${name || "(none)"}`);
      }
      const db = c.get("db");
      const agent = c.get("agent");
      const grants = c.get("grants");
      try {
        const result = await callMailboxTool({ env: c.env, db, agent, grants }, name, args);
        return rpcResult(result);
      } catch (err) {
        if (err instanceof AgentError || err instanceof AgentReadError || err instanceof z.ZodError) {
          // Tool-level failure surfaces as isError content, not a protocol error.
          return rpcResult(toolError(err.message));
        }
        return rpcError(-32603, "Internal error");
      }
    }

    return rpcError(-32601, `Method not found: ${method}`);
  });
