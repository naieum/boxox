import { z } from "zod";

// ---------- Agent API shapes ----------

export const agentCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /** Optional address to grant on creation. */
  addressId: z.string().optional(),
  /** Permissions for that grant; send_new is intentionally NOT defaultable. */
  permissions: z
    .array(z.enum(["read", "send", "send_new", "webhook", "classify"]))
    .min(1)
    .default(["read"]),
});

export const agentPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

export const agentPairSchema = z.object({
  code: z.string().min(16).max(256),
});

export const agentTokenSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  grant_type: z.literal("client_credentials").optional(),
});

export const agentSendSchema = z.object({
  fromAddressId: z.string(),
  to: z.array(z.string().email()).min(1).max(10),
  subject: z.string().min(1).max(500),
  text: z.string().max(500_000),
  threadId: z.string().optional(),
  /** Reuse after network errors; a different message requires a different key. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  idempotencyGroup: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional(),
});
