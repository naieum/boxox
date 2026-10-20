import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, stamp, ts } from "./columns";

/**
 * Agents are machine principals, never people. clientId is assigned at
 * creation and stable for life; the secret exists only as a SHA-256 hash and
 * is (re)set at pairing time — re-pairing rotates the secret in place, which is
 * the documented lost-secret recovery path.
 */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Disabled agents have zero effective grants and cannot mint tokens. */
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    clientId: text("client_id").notNull().unique(),
    /** SHA-256 of the client secret; null until first pairing completes. */
    clientSecretHash: text("client_secret_hash"),
    /** Per-agent send caps; null means the install default. */
    sendHourlyCap: integer("send_hourly_cap"),
    sendDailyCap: integer("send_daily_cap"),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
    lastSeenAt: ts("last_seen_at"),
  },
  (t) => [index("agents_org_idx").on(t.organizationId)],
);

/**
 * One-time pairing codes: >=128-bit random, stored hashed, 15-minute TTL,
 * single-use enforced by a guarded UPDATE ... WHERE used_at IS NULL.
 */
export const agentPairingCodes = sqliteTable(
  "agent_pairing_codes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdBy: text("created_by").notNull(),
    createdAt: stamp("created_at"),
  },
  (t) => [index("agent_pairing_codes_agent_idx").on(t.agentId)],
);

/**
 * MCP clients registered through the Workers OAuth Provider (whose own state is
 * in KV). The owner approves each one on the Access-protected consent page,
 * which binds it to an agent principal; its grants are that agent's grants.
 */
export const mcpClients = sqliteTable(
  "mcp_clients",
  {
    clientId: text("client_id").primaryKey(),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    redirectUris: json<string[]>("redirect_uris").notNull().default([]),
    approvedAt: ts("approved_at"),
    approvedBy: text("approved_by"),
    revokedAt: ts("revoked_at"),
    lastSeenAt: ts("last_seen_at"),
    createdAt: stamp("created_at"),
  },
  (t) => [index("mcp_clients_agent_idx").on(t.agentId)],
);

/**
 * Fixed-window rate limiting for the public agent endpoints (/pair, /token).
 * key example: "pair:ip:1.2.3.4" or "token:client:boxox_agt_x".
 */
export const agentRateHits = sqliteTable("agent_rate_hits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: integer("window_start").notNull(),
});
