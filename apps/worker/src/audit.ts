import { auditEvents } from "@boxox/db";
import type { ActorType, AuditAction } from "@boxox/shared";
import type { Db } from "./db";

export interface AuditInput {
  organizationId: string;
  actorType: ActorType;
  actorId?: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  /** MUST never contain plaintext keys or email bodies. */
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: input.metadata,
    ipAddress: input.ipAddress,
  });
}
