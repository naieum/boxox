import { request, type MessageDetail, type ThreadDetail, type ThreadRow } from "@/lib/api";
import type { SpamVerdict } from "@/components/SpamWhy";

export interface Label {
  id: string;
  name: string;
  color: string | null;
}

export type ConversationMessage = MessageDetail & {
  /** Sender was not in the conversation before this message; References can be forged. */
  newParticipant: boolean;
  /** Quoted history or signature folded out of html/text, shown behind "…". */
  quotedHtml: string | null;
  quotedText: string | null;
  /** Inbound only: the stored spam verdict, for the "why" panel. */
  spamVerdict: SpamVerdict | null;
};

export interface Conversation {
  thread: ThreadDetail["thread"] & {
    participants: string[];
    muted: boolean;
    snoozedUntil: string | null;
    labels: Label[];
  };
  messages: ConversationMessage[];
}

export type ConversationRow = ThreadRow & { muted: boolean; snoozedUntil: string | null; labels: Label[] };

export const conversationApi = {
  search: (orgId: string, query: string) =>
    request<{ threads: ConversationRow[]; mode: "keyword" | "hybrid" }>(`/api/orgs/${orgId}/threads/search?q=${encodeURIComponent(query)}`),
  /** Thread list; folder "label" needs labelId. */
  list: (orgId: string, params: { folder: string; category?: string; labelId?: string; addressId?: string; unread?: boolean; cursor?: string }) => {
    const q = new URLSearchParams({ folder: params.folder });
    if (params.labelId) q.set("labelId", params.labelId);
    if (params.category) q.set("category", params.category);
    if (params.addressId) q.set("addressId", params.addressId);
    if (params.unread) q.set("unread", "true");
    if (params.cursor) q.set("cursor", params.cursor);
    return request<{ threads: ConversationRow[]; nextCursor: string | null }>(`/api/orgs/${orgId}/threads?${q}`);
  },
  get: (orgId: string, threadId: string) => request<Conversation>(`/api/orgs/${orgId}/threads/${threadId}`),
  mute: (orgId: string, threadId: string, muted: boolean) =>
    request<{ ok: true; muted: boolean }>(`/api/orgs/${orgId}/threads/${threadId}/mute`, {
      method: "POST",
      body: JSON.stringify({ muted }),
    }),
  snooze: (orgId: string, threadId: string, until: Date | null) =>
    request<{ ok: true; snoozedUntil: string | null }>(`/api/orgs/${orgId}/threads/${threadId}/snooze`, {
      method: "POST",
      body: JSON.stringify({ until: until?.toISOString() ?? null }),
    }),
  addLabel: (orgId: string, threadId: string, labelId: string) =>
    request<{ ok: true }>(`/api/orgs/${orgId}/threads/${threadId}/labels/${labelId}`, { method: "PUT" }),
  removeLabel: (orgId: string, threadId: string, labelId: string) =>
    request<{ ok: true }>(`/api/orgs/${orgId}/threads/${threadId}/labels/${labelId}`, { method: "DELETE" }),
  labels: (orgId: string) => request<{ labels: (Label & { threadCount: number })[] }>(`/api/orgs/${orgId}/labels`),
  createLabel: (orgId: string, name: string, color?: string) =>
    request<{ label: Label }>(`/api/orgs/${orgId}/labels`, {
      method: "POST",
      body: JSON.stringify({ name, color: color ?? null }),
    }),
};
