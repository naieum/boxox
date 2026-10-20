import { useMe } from "@/AppShell";
import type { ComponentProps } from "react";
import { useState } from "react";
import { request } from "@/lib/api";

const button = "rounded-md border border-white/14 bg-white/4 px-3 py-2 text-xs font-semibold hover:bg-white/8 disabled:opacity-50";

/** Click-only helpers; suggestions stay plain text and are never sent automatically. */
function AssistActionsEditor({ orgId, threadId, canReply, onReply }: {
  orgId: string;
  threadId: string;
  canReply: boolean;
  onReply: (text: string) => void;
}) {
  const [pending, setPending] = useState<"summary" | "replies" | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [replies, setReplies] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function generate(kind: "summary" | "replies") {
    setPending(kind);
    setError(null);
    try {
      const result = await request<{ summary?: string; replies?: string[] }>(
        `/api/orgs/${encodeURIComponent(orgId)}/threads/${encodeURIComponent(threadId)}/${kind}`,
        { method: "POST" },
      );
      if (result.summary) setSummary(result.summary);
      if (result.replies) setReplies(result.replies);
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI assistance is unavailable.");
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-label="AI assistance" className="mb-5 space-y-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={!!pending} onClick={() => generate("summary")}>
          {pending === "summary" ? "Summarizing…" : "Summarize thread"}
        </button>
        <button type="button" className={button} disabled={!!pending || !canReply} onClick={() => generate("replies")}>
          {pending === "replies" ? "Finding replies…" : "Suggest replies"}
        </button>
      </div>
      {pending && <p role="status" className="text-xs text-[#9BA1AD]">Reading this thread to prepare {pending === "summary" ? "a summary" : "reply suggestions"}…</p>}
      {summary && <div className="rounded-lg border border-white/10 bg-white/4 p-3 text-sm whitespace-pre-wrap text-[#C9CFD8]"><h2 className="mb-1 font-semibold">AI summary</h2>{summary}</div>}
      {replies.length > 0 && (
        <div className="space-y-2 text-sm">
          <p className="text-xs text-[#9BA1AD]">Choose a reply to edit. Check the details before sending.</p>
          {replies.map((reply, i) => <button type="button" key={i} disabled={!canReply} onClick={() => onReply(reply)} className={`${button} block w-full text-left whitespace-pre-wrap`}>{reply}</button>)}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-ox-danger">{error}</p>}
    </section>
  );
}

export function AssistActions(props: ComponentProps<typeof AssistActionsEditor>) {
  const me = useMe();
  if (me.data?.capabilities?.ai === false) return null;
  return <AssistActionsEditor {...props} />;
}
