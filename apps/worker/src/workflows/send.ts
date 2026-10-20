import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, SendParams } from "../env";
import { runApiSend } from "../dev/messages";
import { runSend } from "../services/outbound/run";

/**
 * Outbound delivery for a message queueOutbound already persisted: sleep until
 * `scheduledAt`, check suppression and the circuit breaker, then call the
 * send_email binding once and record the returned messageId.
 */
export class SendWorkflow extends WorkflowEntrypoint<Env, SendParams> {
  async run(event: WorkflowEvent<SendParams>, step: WorkflowStep): Promise<string> {
    if (event.payload.kind === "api") return runApiSend(this.env, event.payload, step);
    return runSend(this.env, event.payload, step);
  }
}
