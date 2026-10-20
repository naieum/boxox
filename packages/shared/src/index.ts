import { z } from "zod";

// ---------- Mailboxes ----------

export const MAILBOX_TYPES = ["human", "agent", "shared"] as const;
export type MailboxType = (typeof MAILBOX_TYPES)[number];

export const AGENT_PERMISSIONS = ["read", "webhook", "classify", "send"] as const;
export type AgentPermission = (typeof AGENT_PERMISSIONS)[number];

/** Per spec: agents default to read + webhook; classify per mailbox policy; send off. */
export const DEFAULT_AGENT_PERMISSIONS: AgentPermission[] = ["read", "webhook"];

export const STARTER_LOCAL_PARTS = [
  "hello",
  "support",
  "billing",
  "alerts",
  "security",
  "login-agent",
  "qa-agent",
] as const;

// ---------- Keys ----------

/** Derive the display hint for a secret. Only the last 6 chars are retained. */
export function keyHint(secret: string): string {
  return `...${secret.slice(-6)}`;
}

// ---------- Audit ----------

export const AUDIT_ACTIONS = [
  "domain.reconfigured",
  "domain.activated",
  "domain.deactivated",
  "address.created",
  "address.reconfigured",
  "grant.added",
  "grant.removed",
  "message.sent",
  "thread.claimed",
  "sender.blocked",
  "sender.unblocked",
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "agent.paired",
  "agent.disabled",
  "agent.enabled",
  "agent.secret_rotated",
  "agent.pairing_code_rotated",
  "agent.message_sent",
  /** Refused agent actions: over a send cap, missing send_new, or a hard delete. */
  "agent.send_refused",
  "agent.delete_refused",
  "agent.threads_listed",
  "agent.thread_read",
  "agent.thread_marked_read",
  "agent.thread_trashed",
  "agent.work_claimed",
  "agent.work_completed",
  "agent.work_retried",
  "agent.work_renewed",
  "agent.work_listed",
  "agent.caps_updated",
  /** MCP clients registered through OAuth: the owner approves, denies or revokes each one. */
  "mcp_client.approved",
  "mcp_client.denied",
  "mcp_client.revoked",
  /** The install-wide kill switch for every agent. */
  "agents.disabled",
  "agents.enabled",
  /** A user took a copy of their mail out of the product. */
  "mail.exported",
  /** An outbound send failed at the provider; the message is saved and retryable. */
  "message.send_failed",
  "api_key.created",
  "api_key.rotated",
  "api_key.revoked",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const ACTOR_TYPES = ["user", "agent", "api_key", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// ---------- API envelopes ----------

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export * from "./mail";
export * from "./agents";
