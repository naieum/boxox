import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, stamp } from "./columns";

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    actorType: text("actor_type", {
      enum: ["user", "agent", "api_key", "system"],
    }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** Structured details. MUST never contain plaintext keys or email bodies. */
    metadata: json<Record<string, unknown>>("metadata"),
    ipAddress: text("ip_address"),
    createdAt: stamp("created_at"),
  },
  (t) => [
    index("audit_events_org_created_idx").on(t.organizationId, t.createdAt),
    index("audit_events_action_idx").on(t.action),
    index("audit_events_actor_action_created_idx").on(t.actorType, t.actorId, t.action, t.createdAt),
  ],
);
