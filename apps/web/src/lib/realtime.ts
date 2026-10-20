import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/** What MailboxHub pushes. Ids and status only; the client refetches what it shows. */
export type RealtimeEvent =
  | { type: "message.new"; addressId: string | null; threadId: string; messageId: string; folder: string }
  | { type: "message.status"; addressId: string | null; threadId: string; messageId: string; deliveryStatus: string };

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

export function realtimeUrl(orgId: string, location: Pick<Location, "protocol" | "host"> = window.location): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/orgs/${encodeURIComponent(orgId)}/realtime`;
}

export function parseRealtimeEvent(data: unknown): RealtimeEvent | null {
  if (typeof data !== "string" || data === "pong") return null;
  try {
    const e = JSON.parse(data) as Partial<RealtimeEvent>;
    if ((e.type === "message.new" || e.type === "message.status") && typeof e.threadId === "string") {
      return e as RealtimeEvent;
    }
  } catch {
    // Not ours.
  }
  return null;
}

/**
 * Keeps one socket to the hub open, reconnecting with capped exponential
 * backoff, and pings so idle proxies don't drop it. Returns a stop function.
 */
export function connectRealtime(orgId: string, onEvent: (e: RealtimeEvent) => void, onReconnect?: () => void): () => void {
  let ws: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let stopped = false;

  const open = () => {
    ws = new WebSocket(realtimeUrl(orgId));
    ws.addEventListener("open", () => {
      // Anything pushed while we were away was missed; let the caller catch up.
      if (attempts > 0) onReconnect?.();
      attempts = 0;
      ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), PING_MS);
    });
    ws.addEventListener("message", (m) => {
      const e = parseRealtimeEvent(m.data);
      if (e) onEvent(e);
    });
    ws.addEventListener("close", () => {
      clearInterval(ping);
      if (stopped) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts++) * (0.5 + Math.random() / 2);
      retry = setTimeout(open, delay);
    });
  };
  open();

  return () => {
    stopped = true;
    clearInterval(ping);
    clearTimeout(retry);
    ws?.close(1000, "bye");
  };
}

/** Refreshes the mail queries the hub says are stale. */
export function useRealtime(orgId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!orgId) return;
    const refreshAll = () => {
      qc.invalidateQueries({ queryKey: ["threads", orgId] });
      qc.invalidateQueries({ queryKey: ["addresses", orgId] });
    };
    return connectRealtime(
      orgId,
      (e) => {
        if (e.type === "message.new") refreshAll();
        qc.invalidateQueries({ queryKey: ["thread", orgId, e.threadId] });
      },
      refreshAll,
    );
  }, [orgId, qc]);
}
