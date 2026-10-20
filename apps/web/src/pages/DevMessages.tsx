import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageContainer, PageHeader, Panel, PanelEmpty } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DevTabs, DomainKeyGate, HtmlPreview, StatusPill, devRequest, errorText, when } from "./DevShared";

const STATUSES = ["queued", "scheduled", "sent", "delivered", "deferred", "bounced", "complained", "failed", "canceled"] as const;

interface MessageSummary {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  subject: string;
  tags: Record<string, string>;
  status: string;
  scheduledAt: string | null;
  sentMessageId: string | null;
  error: string | null;
  createdAt: string;
}

interface MessageFull extends MessageSummary {
  timeline: { type: string; recipient: string | null; at: string; detail: unknown }[];
  body: {
    text: string | null;
    html: string | null;
    headers: Record<string, string> | null;
    attachments: { filename: string; contentType: string; contentId: string | null; size: number }[];
  } | null;
}

function MessageDetail({ apiKey, id }: { apiKey: string; id: string }) {
  const qc = useQueryClient();
  const [view, setView] = useState<"html" | "text">("html");
  const msg = useQuery({
    queryKey: ["dev-message", apiKey, id],
    queryFn: () => devRequest<MessageFull>(apiKey, `/messages/${id}`),
  });
  const cancel = useMutation({
    mutationFn: () => devRequest(apiKey, `/messages/${id}/cancel`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dev-message", apiKey] }),
  });

  if (msg.isLoading) return <Skeleton className="m-5 h-40" />;
  if (msg.error) return <p className="p-5 text-sm text-ox-danger">{errorText(msg.error, "Could not load message")}</p>;
  const m = msg.data!;
  const html = m.body?.html ?? null;
  const showHtml = view === "html" && html;

  return (
    <div className="space-y-4 border-t border-white/6 bg-white/2 p-5">
      <div className="grid gap-x-6 gap-y-1 text-[12px] text-[#9BA1AD] sm:grid-cols-2">
        <div>From <span className="text-foreground">{m.from}</span></div>
        <div>To <span className="text-foreground">{[...m.to, ...m.cc, ...m.bcc].join(", ")}</span></div>
        {m.replyTo && <div>Reply-To <span className="text-foreground">{m.replyTo}</span></div>}
        {m.scheduledAt && <div>Scheduled for <span className="text-foreground">{when(m.scheduledAt)}</span></div>}
        {Object.keys(m.tags).length > 0 && (
          <div className="font-mono">{Object.entries(m.tags).map(([k, v]) => `${k}:${v}`).join(" ")}</div>
        )}
        <div className="font-mono text-[11px]">{m.id}</div>
      </div>
      {m.error && <p className="text-[12.5px] text-ox-danger">{m.error}</p>}

      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#767d8a]">Timeline</div>
        <ol className="space-y-1 border-l border-white/10 pl-3">
          {m.timeline.map((t, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 text-[12px]">
              <StatusPill status={t.type} />
              {t.recipient && <span className="text-[#9BA1AD]">{t.recipient}</span>}
              <span className="text-[#7C838F]">{when(t.at)}</span>
            </li>
          ))}
        </ol>
      </div>

      {m.body ? (
        <div>
          <div className="mb-2 flex gap-1">
            {(["html", "text"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded-md px-2.5 py-0.5 text-[12px] font-semibold ${view === v ? "bg-white/10 text-foreground" : "text-[#7C838F]"}`}
              >
                {v.toUpperCase()}
              </button>
            ))}
          </div>
          {showHtml ? (
            <HtmlPreview html={html} />
          ) : (
            <pre className="max-h-[360px] overflow-auto rounded-lg bg-black/30 p-3 text-[12.5px] whitespace-pre-wrap text-[#C9CFD8]">
              {m.body.text ?? "(no text part)"}
            </pre>
          )}
          {m.body.attachments.length > 0 && (
            <div className="mt-2 text-[12px] text-[#9BA1AD]">
              {m.body.attachments.map((a) => `${a.filename} (${Math.ceil(a.size / 1024)} KB)`).join(" · ")}
            </div>
          )}
        </div>
      ) : (
        <p className="text-[12.5px] text-[#7C838F]">The rendered body is no longer stored.</p>
      )}

      {m.status === "scheduled" && (
        <Button
          type="button"
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => window.confirm("Cancel this scheduled message?") && cancel.mutate()}
          className="h-8 rounded-lg text-xs text-ox-danger"
        >
          Cancel send
        </Button>
      )}
      {cancel.error && <p className="text-sm text-ox-danger">{errorText(cancel.error, "Could not cancel")}</p>}
    </div>
  );
}

function MessageLog({ apiKey }: { apiKey: string }) {
  const [status, setStatus] = useState("");
  const [recipient, setRecipient] = useState("");
  const [tag, setTag] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const filters = { status, recipient: recipient.trim(), tag: tag.trim() };

  const log = useInfiniteQuery({
    queryKey: ["dev-messages", apiKey, filters],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams();
      if (filters.status) q.set("status", filters.status);
      if (filters.recipient) q.set("recipient", filters.recipient);
      if (filters.tag) q.set("tag", filters.tag);
      if (pageParam) q.set("cursor", pageParam);
      return devRequest<{ data: MessageSummary[]; nextCursor: string | null }>(apiKey, `/messages?${q}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-[10px] border border-white/8 bg-white/3 px-3 text-[13px]"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <Input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="recipient@example.com"
          className="h-9 max-w-[240px] rounded-[10px] bg-white/3 text-[13px]"
        />
        <Input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="tag or tag:value"
          className="h-9 max-w-[180px] rounded-[10px] bg-white/3 text-[13px]"
        />
      </div>
      {log.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}
      {log.error && <p className="text-sm text-ox-danger">{errorText(log.error, "Could not load messages")}</p>}
      {log.data && !rows.length && (
        <PanelEmpty title="No messages" desc="Messages sent through /dev/v1/messages with this key's domain show up here." />
      )}
      {rows.length > 0 && (
        <Panel>
          {rows.map((m, i) => (
            <div key={m.id} className={i ? "border-t border-white/6" : ""}>
              <button
                type="button"
                onClick={() => setOpen(open === m.id ? null : m.id)}
                className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-white/2"
              >
                <StatusPill status={m.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold">{m.subject || "(no subject)"}</div>
                  <div className="truncate text-[11.5px] text-[#7C838F]">
                    {m.from} → {m.to.join(", ")}
                  </div>
                </div>
                <div className="flex-none text-[11.5px] text-[#7C838F]">{when(m.createdAt)}</div>
              </button>
              {open === m.id && <MessageDetail apiKey={apiKey} id={m.id} />}
            </div>
          ))}
        </Panel>
      )}
      {log.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button
            type="button"
            variant="ghost"
            disabled={log.isFetchingNextPage}
            onClick={() => log.fetchNextPage()}
            className="h-8 rounded-lg text-[13px] text-[#9BA1AD]"
          >
            {log.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </>
  );
}

export function DevMessagesPage() {
  return (
    <PageContainer>
      <PageHeader title="Messages" description="Everything your apps sent through the developer API, with status timelines and previews." />
      <DevTabs />
      <DomainKeyGate need="read_log">{(key) => <MessageLog apiKey={key} />}</DomainKeyGate>
    </PageContainer>
  );
}
