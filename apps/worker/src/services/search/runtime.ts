import type { Env } from "../../env";
import { log } from "../../log";
import { mailAiDeps } from "../ai/runtime";
import { indexMessage } from "./indexer";

/** Workflow adapter: rerunnable indexing using the owner's current persisted choices. */
export async function indexStoredMessage(env: Env, messageId: string) {
  try {
    return await indexMessage({ ...await mailAiDeps(env), indexAttachmentText: env.INDEX_ATTACHMENT_TEXT !== "off" }, messageId);
  } catch (error) {
    // Search failure must not prevent delivery or the inbox notification.
    log.warn("search_index_unavailable", { errorType: error instanceof Error ? error.name : "unknown" });
    return { error: "indexing-unavailable" as const, vectors: { ok: false as const, reason: "error" as const } };
  }
}
