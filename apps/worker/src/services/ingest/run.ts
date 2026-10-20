import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { makeSnippet } from "@boxox/shared";
import { createDb } from "../../db";
import type { Env, IngestParams } from "../../env";
import { freeRuntime, isFree } from "../capabilities";
import { log } from "../../log";
import { storeAttachment } from "../attachments";
import { buildSearchText, searchTextLimit } from "../ingest";
import { parseMessage } from "./parse";
import { routeInbound, type InboundRoute } from "./route";
import { storeInbound, type InboundAttachment, type InboundSummary, type StoreResult } from "./store";
import type { ThreadResolver } from "./thread";

/**
 * IngestWorkflow's steps. The raw message is already in R2 under the
 * instance id, so every step reads from there, writes to deterministic keys,
 * and can run again without a second copy of anything.
 */

export type IngestStep = Pick<WorkflowStep, "do">;
export type IngestEnv = Pick<Env, "DB" | "MAIL_STORE" | "BOXOX_EDITION" | "FREE_RUNTIME" | "SEARCH_BODY_CHAR_LIMIT">;

/** Transient R2/D1 errors retry; a message that won't parse never throws, so it never loops. */
const STEP_RETRIES: WorkflowStepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" };

export const bodyKeyFor = (rawKey: string) => `body/${rawKey}.json`;

async function putJson(env: IngestEnv, key: string, value: unknown) {
  await env.MAIL_STORE.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

/** Parse the raw message, write the body JSON and attachments to R2, return the summary. */
export async function parseStep(env: IngestEnv, rawKey: string): Promise<InboundSummary & { recipient: string; envelopeFrom: string }> {
  const obj = await env.MAIL_STORE.get(rawKey);
  if (!obj) throw new Error("raw message missing from R2");
  const raw = new Uint8Array(await obj.arrayBuffer());
  const recipient = obj.customMetadata?.to ?? "";
  const envelopeFrom = (obj.customMetadata?.from ?? "").toLowerCase();
  const bodyKey = bodyKeyFor(rawKey);
  const outcome = await parseMessage(raw);

  if (!outcome.ok) {
    log.warn("inbound_quarantined", { rawKey, reason: outcome.reason });
    await putJson(env, bodyKey, { text: null, html: null, quarantine: { reason: outcome.reason } });
    return {
      rawKey,
      rawSize: raw.byteLength,
      bodyKey,
      recipient,
      envelopeFrom,
      quarantineReason: outcome.reason,
      fromEmail: envelopeFrom,
      fromName: null,
      toEmails: [],
      ccEmails: [],
      subject: "",
      rfcMessageId: null,
      inReplyTo: null,
      references: null,
      authenticated: false,
      snippet: "",
      searchText: null,
      hasText: false,
      hasHtml: false,
      attachments: [],
      attachmentBytes: 0,
    };
  }

  const mail = outcome.mail;
  const attachments: InboundAttachment[] = [];
  let attachmentBytes = 0;
  for (const att of mail.attachments) {
    const { created, ...facts } = await storeAttachment(env.MAIL_STORE, att);
    if (created) attachmentBytes += facts.size;
    attachments.push({ ...facts, contentType: att.contentType, truncated: false });
  }
  await putJson(env, bodyKey, { text: mail.text, html: mail.html });

  const text = mail.text ?? mail.html?.replace(/<[^>]+>/g, " ") ?? null;
  return {
    rawKey,
    rawSize: raw.byteLength,
    bodyKey,
    recipient,
    envelopeFrom,
    quarantineReason: null,
    fromEmail: mail.fromEmail || envelopeFrom,
    fromName: mail.fromName,
    toEmails: mail.toEmails,
    ccEmails: mail.ccEmails,
    subject: mail.subject,
    rfcMessageId: mail.rfcMessageId,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    authenticated: mail.authenticated,
    snippet: makeSnippet(text),
    searchText: buildSearchText({
      subject: mail.subject,
      fromEmail: mail.fromEmail,
      fromName: mail.fromName,
      toEmails: mail.toEmails,
      ccEmails: mail.ccEmails,
      text: mail.text,
      html: mail.html,
    }, searchTextLimit(env.SEARCH_BODY_CHAR_LIMIT)),
    hasText: !!mail.text,
    hasHtml: !!mail.html,
    attachments,
    attachmentBytes,
  };
}

export async function runIngest(
  env: IngestEnv,
  params: IngestParams,
  step: IngestStep,
  resolveThread?: ThreadResolver,
): Promise<StoreResult> {
  const db = createDb(env);
  const receivedAt = new Date(params.receivedAt);
  const runtime = isFree(env) ? freeRuntime(env) : null;

  const mail = await step.do("parse message", STEP_RETRIES, () => runtime ? runtime.parse(params.rawKey) : parseStep(env, params.rawKey));

  const route = await step.do("route recipient", STEP_RETRIES, async (): Promise<InboundRoute> => {
    if (runtime) return runtime.route(mail, params.receivedAt);
    const senders = [...new Set([mail.fromEmail, mail.envelopeFrom].filter((s) => s.includes("@")))];
    return routeInbound(db, mail.recipient, senders, receivedAt);
  });

  const stored = await step.do("store message", STEP_RETRIES, () => runtime ? runtime.store(route, mail, params.receivedAt) : storeInbound(db, route, mail, receivedAt, resolveThread));
  if (stored.status === "dropped" || stored.status === "unknown_domain") {
    log.info("inbound_not_stored", { rawKey: params.rawKey, status: stored.status });
  }
  return stored;
}
