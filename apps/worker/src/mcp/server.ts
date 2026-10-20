import { Server, type Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { agentSendSchema } from "@boxox/shared";
import type { Db } from "../db";
import type { Env } from "../env";
import {
  AgentError,
  getThreadDetail,
  listThreadsForAddress,
  markThreadRead,
  sendAgentEmail,
  trashThread,
  type AgentGrant,
  type AgentPrincipal,
} from "../routes/agent-api";
import { AgentReadError, listAgentThreads, listAgentChanges, getAgentMessage } from "../services/agent-reads";
import { claimAgentWork, completeAgentWork, completeAgentWorkBatch, listAgentWork, renewAgentWork, retryAgentWork } from "../services/agent-work";
import { isFree } from "../services/capabilities";
import { stripQuotedText } from "./quotes";

/**
 * Mail tools for one agent principal. Only mailbox operations within the
 * agent's grants exist here: no key management, agent or client management,
 * kill switch, setup or domain tools, so an MCP token can never reach them.
 */

export interface McpContext {
  env: Env;
  db: Db;
  agent: AgentPrincipal;
  grants: AgentGrant[];
}

const SERVER_INFO = { name: "boxox", version: "2.4.0" };

const pageArgs = { cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } };
const bodyArgs = { ...pageArgs, includeBody: { type: "boolean", description: "Opt in to text bodies; at most 10 messages per page, 32K characters each." } };
const workArgs = { messageId: { type: "string" }, group: { type: "string", description: "Shared processing group; omit for a private agent queue." } };
const claimArgs = { ...workArgs, claimToken: { type: "string" } };
const threadIdArg = { threadId: { type: "string", description: "The thread id." } };

export const MCP_TOOLS: Tool[] = [
  {
    name: "list_addresses",
    description: "List the mailboxes this agent may use and its permissions on each.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_threads",
    description: "List mail threads for a granted address (mailbox), newest first.",
    inputSchema: {
      type: "object",
      properties: { addressId: { type: "string", description: "The address (mailbox) id." }, ...pageArgs },
      required: ["addressId"],
    },
  },
  {
    name: "get_thread",
    description:
      "Fetch a bounded page of message metadata. Set includeBody=true for text; use nextCursor for the next page.",
    inputSchema: { type: "object", properties: { ...threadIdArg, ...bodyArgs }, required: ["threadId"] },
  },
  {
    name: "send_email",
    description:
      "Send an email from a granted address. Reply-only ('send') unless the agent " +
      "holds 'send_new' for recipients with no prior thread.",
    inputSchema: {
      type: "object",
      properties: {
        fromAddressId: { type: "string", description: "The address (mailbox) id to send from." },
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses." },
        subject: { type: "string" },
        text: { type: "string", description: "Plain-text body." },
        threadId: { type: "string", description: "Optional thread id to reply within." },
        idempotencyKey: { type: "string", description: "Reuse this key after a timeout to prevent a duplicate email." },
        idempotencyGroup: { type: "string", description: "Share retry protection across authorized agents in this processing group and mailbox." },
      },
      required: ["fromAddressId", "to", "subject", "text"],
    },
  },
  {
    name: "mark_read",
    description: "Mark a thread as read.",
    inputSchema: { type: "object", properties: threadIdArg, required: ["threadId"] },
  },
  {
    name: "trash_thread",
    description: "Move a thread to Trash. Agents cannot permanently delete mail.",
    inputSchema: { type: "object", properties: threadIdArg, required: ["threadId"] },
  },
  { name: "list_changes", description: "Replay mailbox changes after a saved checkpoint. Persist nextCursor after processing the page, including empty pages.", inputSchema: { type: "object", properties: { addressId: { type: "string" }, ...pageArgs }, required: ["addressId"] } },
  { name: "get_message", description: "Read one message's metadata, with optional bounded text. Attachments stay separate.", inputSchema: { type: "object", properties: { messageId: { type: "string" }, includeBody: { type: "boolean" } }, required: ["messageId"] } },
  { name: "list_work", description: "List pending inbound messages for this agent or a shared processing group. Metadata only.", inputSchema: { type: "object", properties: { addressId: { type: "string" }, group: { type: "string" }, ...pageArgs }, required: ["addressId"] } },
  { name: "claim_message", description: "Claim an inbound message with an expiring lease before processing it.", inputSchema: { type: "object", properties: { ...workArgs, leaseSeconds: { type: "integer", minimum: 1, maximum: 3600 } }, required: ["messageId"] } },
  { name: "complete_message", description: "Acknowledge successful processing with your claim token. Does not mark mail read or delete it.", inputSchema: { type: "object", properties: claimArgs, required: ["messageId", "claimToken"] } },
  { name: "retry_message", description: "Release a claim for later retry after a processing failure.", inputSchema: { type: "object", properties: { ...claimArgs, delaySeconds: { type: "integer", minimum: 0, maximum: 86400 } }, required: ["messageId", "claimToken"] } },
  { name: "renew_claim", description: "Extend an active processing lease while work continues.", inputSchema: { type: "object", properties: { ...claimArgs, leaseSeconds: { type: "integer", minimum: 1, maximum: 3600 } }, required: ["messageId", "claimToken"] } },
  { name: "complete_messages", description: "Acknowledge 1–10 claims. Check each result; failures do not undo successful acknowledgments.", inputSchema: { type: "object", properties: { items: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", properties: claimArgs, required: ["messageId", "claimToken"] } } }, required: ["items"] } },
];

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const toolError = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value) throw new AgentError(400, "bad_request", `${name} is required`);
  return value;
}

const pageSchema = z.object({ cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).optional() });
const bodySchema = pageSchema.extend({ includeBody: z.boolean().optional() });
const pageOptions = (args: Record<string, unknown>) => pageSchema.parse(args);
const bodyOptions = (args: Record<string, unknown>) => bodySchema.parse(args);
const workGroup = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional();
const workPage = pageSchema.extend({ group: workGroup });
const workRef = z.object({ messageId: z.string().min(1).max(128), claimToken: z.string().min(1).max(256), group: workGroup });
const workClaim = z.object({ messageId: z.string().min(1).max(128), group: workGroup, leaseSeconds: z.number().int().min(1).max(3600).optional() });

export async function callMailboxTool(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { env, db, agent, grants } = ctx;
  switch (name) {
    case "list_addresses":
      return ok({ addresses: grants });
    case "list_threads":
      return ok(await listAgentThreads(db, agent, grants, stringArg(args, "addressId"), pageOptions(args)));
    case "get_thread": {
      const detail = await getThreadDetail(env, db, agent, grants, stringArg(args, "threadId"), bodyOptions(args));
      return ok({
        thread: detail.thread,
        nextCursor: detail.nextCursor,
        messages: detail.messages.map((m) => ({ ...m, text: m.text === null ? null : stripQuotedText(m.text) })),
      });
    }
    case "list_changes": return ok(await listAgentChanges(db, agent, grants, stringArg(args, "addressId"), pageOptions(args)));
    case "get_message": return ok(await getAgentMessage(env, db, agent, grants, stringArg(args, "messageId"), bodyOptions(args)));
    case "list_work": return ok(await listAgentWork(db, agent, grants, stringArg(args, "addressId"), workPage.parse(args)));
    case "claim_message": return ok(await claimAgentWork(db, agent, grants, workClaim.parse(args)));
    case "complete_message": return ok(await completeAgentWork(db, agent, grants, workRef.parse(args)));
    case "retry_message": return ok(await retryAgentWork(db, agent, grants, workRef.extend({ delaySeconds: z.number().int().min(0).max(86400).optional() }).parse(args)));
    case "renew_claim": return ok(await renewAgentWork(db, agent, grants, workRef.extend({ leaseSeconds: z.number().int().min(1).max(3600).optional() }).parse(args)));
    case "complete_messages": return ok(await completeAgentWorkBatch(db, agent, grants, z.object({ items: z.array(workRef).min(1).max(10) }).parse(args).items));
    case "send_email": {
      const parsed = agentSendSchema.safeParse(args);
      if (!parsed.success) {
        throw new AgentError(400, "bad_request", parsed.error.issues[0]?.message ?? "Invalid message");
      }
      const sent = await sendAgentEmail(env, db, agent.organizationId, agent.id, grants, parsed.data);
      return ok({ ok: true, ...sent });
    }
    case "mark_read":
      await markThreadRead(db, agent, grants, stringArg(args, "threadId"));
      return ok({ ok: true });
    case "trash_thread":
      await trashThread(db, agent, grants, stringArg(args, "threadId"));
      return ok({ ok: true });
    default:
      return toolError(`Unknown tool: ${name || "(none)"}`);
  }
}

export function buildMcpServer(ctx: McpContext): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: isFree(ctx.env) ? MCP_TOOLS.filter(tool => tool.name !== "send_email") : MCP_TOOLS }));
  server.setRequestHandler("tools/call", async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await callMailboxTool(ctx, request.params.name, args);
    } catch (err) {
      if (err instanceof AgentError || err instanceof AgentReadError) return toolError(err.message);
      if (err instanceof z.ZodError) return toolError(err.issues[0]?.message ?? "Invalid arguments");
      throw err;
    }
  });
  return server;
}
