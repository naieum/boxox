import { sql } from "drizzle-orm";
import type { Db } from "../db";

export class AgentIdempotencyError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Pending requests never auto-expire: an ambiguous send must not become a second send. */
export async function idempotentAgentSend<T>(
  db: Db,
  scope: { organizationId: string; agentId: string; key: string; input: unknown },
  send: () => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(scope.key)) {
    throw new AgentIdempotencyError(400, "bad_request", "idempotencyKey must be 1–128 letters, numbers, dots, underscores, colons or hyphens");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(scope.input)));
  const fingerprint = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  const inserted = await db.get<{ request_key: string }>(sql`
    INSERT OR IGNORE INTO agent_send_requests(organization_id,agent_id,request_key,fingerprint,state,created_at)
    VALUES(${scope.organizationId},${scope.agentId},${scope.key},${fingerprint},'pending',${Date.now()})
    RETURNING request_key`);
  if (!inserted) {
    const row = await db.get<{ fingerprint: string; state: string; result: string | null }>(sql`
      SELECT fingerprint,state,result FROM agent_send_requests WHERE organization_id=${scope.organizationId}
      AND agent_id=${scope.agentId} AND request_key=${scope.key}`);
    if (!row || row.fingerprint !== fingerprint) throw new AgentIdempotencyError(409, "idempotency_conflict", "This idempotency key was already used with different message content");
    if (row.state === "succeeded" && row.result) return JSON.parse(row.result) as T;
    if (row.state === "failed" && row.result) {
      const failure = JSON.parse(row.result) as { status: number; code: string; message: string };
      throw new AgentIdempotencyError(failure.status, failure.code, failure.message);
    }
    throw new AgentIdempotencyError(409, "send_state_unknown", "This send is in progress or its outcome needs review. Retry with the same key; do not send with a new key.");
  }
  try {
    const result = await send();
    await db.run(sql`UPDATE agent_send_requests SET state='succeeded',result=${JSON.stringify(result)}
      WHERE organization_id=${scope.organizationId} AND agent_id=${scope.agentId} AND request_key=${scope.key}`);
    return result;
  } catch (error) {
    // Unknown infrastructure failures remain pending, including a failed success write.
    // A recognizable policy/provider error is replayed without re-entering delivery.
    if (error instanceof Error && "status" in error && "code" in error) {
      const known = error as Error & { status: number; code: string };
      if (known.name === "AgentError" && [400, 403, 404, 409, 429].includes(known.status)) {
        // These policy checks finish before queuing mail or invoking transport.
        // A temporary quota or changed grant must not poison a task's retry key.
        await db.run(sql`DELETE FROM agent_send_requests WHERE organization_id=${scope.organizationId}
          AND agent_id=${scope.agentId} AND request_key=${scope.key} AND state='pending'`);
        throw error;
      }
      await db.run(sql`UPDATE agent_send_requests SET state='failed',result=${JSON.stringify({ status: known.status, code: known.code, message: known.message })}
        WHERE organization_id=${scope.organizationId} AND agent_id=${scope.agentId} AND request_key=${scope.key}`);
    }
    throw error;
  }
}
