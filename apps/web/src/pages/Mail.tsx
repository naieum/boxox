import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import {
  AlarmClock,
  Archive,
  Ban,
  BellOff,
  ChevronDown,
  ChevronLeft,
  RotateCcw,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useActiveOrgId } from "@/AppShell";
import { conversationApi, type ConversationRow } from "@/components/conversation/api";
import { ConversationView } from "@/components/conversation/ConversationView";
import { ThreadControls } from "@/components/conversation/ThreadControls";
import { ClassificationBadges } from "@/components/conversation/ClassificationBadges";
import { categoryLabel } from "@/components/conversation/categories";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";

const EMPTY_COPY: Record<string, [string, string]> = {
  inbox: ["All caught up", "No unread mail. The ox rests."],
  priority: ["No high-priority mail", "Messages marked high priority appear here while they are in your inbox."],
  category: ["No mail in this category", "Messages appear here after the AI classifier assigns this category."],
  starred: ["No starred messages", "Star a message and it will be waiting for you here."],
  snoozed: ["Nothing snoozed", "Snooze a conversation and it comes back to your inbox when you choose."],
  label: ["No conversations with this label", "Label a conversation from its toolbar to file it here."],
  sent: ["Nothing sent yet", "Messages you send will appear here."],
  drafts: ["No drafts", "Half-written thoughts live here. Start one with Compose."],
  scheduled: ["Nothing scheduled", "Emails queued for later will show up here."],
  archive: ["Archive is empty", "Archived mail stays searchable, out of your way."],
  spam: ["No spam", "Blocked and unverified senders end up here. Enjoy the quiet."],
  trash: ["Trash is empty", "Deleted messages are kept for 30 days, then removed."],
  address: ["No mail here yet", "Hand this address out and messages will land here."],
  unrouted: [
    "Nothing unrouted",
    "Mail sent to addresses that don't exist yet waits here for you to claim or dismiss.",
  ],
};

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (now.getTime() - d.getTime() < 6 * 24 * 3600 * 1000) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function MailEmpty({ folder }: { folder: string }) {
  const [title, desc] = EMPTY_COPY[folder] ?? EMPTY_COPY.inbox!;
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-[5px] font-heading text-[15.5px] font-bold">{title}</div>
      <div className="max-w-[250px] text-[12.5px] leading-[1.55] text-[#7C838F]">{desc}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-[26px] rounded-full border px-3 text-[11.5px] font-semibold ${
        active
          ? "border-white/18 bg-white/10 text-foreground"
          : "border-white/8 text-[#7C838F] hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function ClaimBanner({
  detail,
  onDone,
}: {
  detail: import("@/lib/api").ThreadDetail;
  onDone: () => void;
}) {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const addresses = useQuery({
    queryKey: ["addresses", orgId],
    queryFn: () => api.addresses.list(orgId),
    enabled: !!orgId,
  });
  const claim = useMutation({
    mutationFn: (body: Parameters<typeof api.threads.claim>[2]) =>
      api.threads.claim(orgId, detail.thread.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["threads", orgId] });
      qc.invalidateQueries({ queryKey: ["addresses", orgId] });
      qc.invalidateQueries({ queryKey: ["thread", orgId, detail.thread.id] });
      onDone();
    },
  });
  const rcpt = detail.thread.originalRecipient ?? "an unknown address";
  const local = rcpt.split("@")[0];
  const targets = (addresses.data?.addresses ?? []).filter((a) => a.status === "active");

  return (
    <div className="mb-6 rounded-[14px] border border-ox/25 bg-gradient-to-b from-ox/6 to-ox/1 px-[17px] py-[15px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-heading text-[12.5px] font-semibold text-ox">Unrouted mail</span>
      </div>
      <p className="mb-3 text-[13px] leading-relaxed text-[#C9CFD8]">
        This was sent to <span className="font-mono font-semibold">{rcpt}</span>, which doesn't
        exist on this domain. Claim it or dismiss it — the sender was never bounced.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => claim.mutate({ mode: "create" })}
          disabled={claim.isPending}
          className="h-[30px] rounded-lg px-[13px] font-heading text-xs font-semibold"
        >
          Create {local}@ &amp; claim
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              disabled={claim.isPending || targets.length === 0}
              className="h-[30px] rounded-lg border-white/14 bg-white/4 px-[13px] text-xs font-medium"
            >
              Deliver to… <ChevronDown className="size-3" strokeWidth={2} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="rounded-xl bg-surface-4">
            {targets.map((a) => (
              <DropdownMenuItem
                key={a.id}
                onClick={() => claim.mutate({ mode: "redirect", addressId: a.id })}
                className="text-[12.5px]"
              >
                {a.email}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {claim.isError && (
          <span className="text-xs text-ox-danger">
            {claim.error instanceof Error ? claim.error.message : "Claim failed"}
          </span>
        )}
      </div>
    </div>
  );
}

function ReadingPane({
  threadId,
  onBack,
  onChanged,
  onClosed,
}: {
  threadId: string;
  onBack: () => void;
  onChanged: () => void;
  /** Called when the thread moves out of the current folder (archive/trash/restore). */
  onClosed: () => void;
}) {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["thread", orgId, threadId],
    queryFn: () => conversationApi.get(orgId, threadId),
    enabled: !!orgId,
  });

  // The thread's own address is the reply identity; all of them are left out of reply-all.
  const addressList = useQuery({
    queryKey: ["addresses", orgId],
    queryFn: () => api.addresses.list(orgId),
    enabled: !!orgId,
  });
  const ownEmails = addressList.data?.addresses.map((a) => a.email) ?? [];
  const replyFromEmail =
    addressList.data?.addresses.find((a) => a.id === detail.data?.thread.addressId)?.email ??
    null;

  const act = useMutation({
    mutationFn: (action: Parameters<typeof api.threads.act>[2]) =>
      api.threads.act(orgId, threadId, action),
    onSuccess: (_data, action) => {
      qc.invalidateQueries({ queryKey: ["thread", orgId, threadId] });
      onChanged();
      // Actions that move the thread out of this folder — clear the reading
      // pane instead of leaving a ghost of the moved thread.
      if (
        action === "archive" ||
        action === "trash" ||
        action === "restore" ||
        action === "not_spam" ||
        action === "block_sender"
      ) {
        onClosed();
      }
    },
  });

  const removeLabel = useMutation({
    mutationFn: (labelId: string) => conversationApi.removeLabel(orgId, threadId, labelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["thread", orgId, threadId] });
      qc.invalidateQueries({ queryKey: ["labels", orgId] });
      onChanged();
    },
  });

  const t = detail.data;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-surface-1">
      <div className="flex h-12 flex-none items-center gap-0.5 border-b border-white/6 pr-3.5 pl-2.5">
        <button
          onClick={onBack}
          className="flex size-9 items-center justify-center rounded-[9px] text-foreground hover:bg-white/5 lg:hidden"
        >
          <ChevronLeft className="size-5" strokeWidth={1.8} />
        </button>
        <div className="flex-1" />
        {t?.thread.folder === "trash" || t?.thread.folder === "archive" ? (
          <button
            title="Restore to inbox"
            onClick={() => act.mutate("restore")}
            className="flex size-8 items-center justify-center rounded-lg text-[#9BA1AD] hover:bg-white/5 hover:text-foreground"
          >
            <RotateCcw className="size-[17px]" strokeWidth={1.6} />
          </button>
        ) : t?.thread.folder === "spam" ? (
          <>
            <button
              title="Not spam"
              onClick={() => act.mutate("not_spam")}
              className="flex size-8 items-center justify-center rounded-lg text-[#9BA1AD] hover:bg-white/5 hover:text-foreground"
            >
              <ShieldCheck className="size-[17px]" strokeWidth={1.6} />
            </button>
            <button
              title="Block sender"
              onClick={() => act.mutate("block_sender")}
              className="flex size-8 items-center justify-center rounded-lg text-[#9BA1AD] hover:bg-white/5 hover:text-foreground"
            >
              <Ban className="size-[17px]" strokeWidth={1.6} />
            </button>
            <button
              title="Delete"
              onClick={() => act.mutate("trash")}
              className="flex size-8 items-center justify-center rounded-lg text-[#9BA1AD] hover:bg-white/5 hover:text-foreground"
            >
              <Trash2 className="size-[17px]" strokeWidth={1.6} />
            </button>
          </>
        ) : (
          <>
            <button
              title="Archive"
              onClick={() => act.mutate("archive")}
              className="flex size-8 items-center justify-center rounded-lg text-[#9BA1AD] hover:bg-white/5 hover:text-foreground"
            >
              <Archive className="size-[17px]" strokeWidth={1.6} />
            </button>
            <button
              title="Block sender"
              onClick={() => act.mutate("block_sender")}
              className="flex size-8 items-center justify-center rounded-lg text-[#9BA1AD] hover:bg-white/5 hover:text-foreground"
            >
              <Ban className="size-[17px]" strokeWidth={1.6} />
            </button>
            <button
              title="Delete"
              onClick={() => act.mutate("trash")}
              className="flex size-8 items-center justify-center rounded-lg text-[#9BA1AD] hover:bg-white/5 hover:text-foreground"
            >
              <Trash2 className="size-[17px]" strokeWidth={1.6} />
            </button>
          </>
        )}
        {t && <ThreadControls orgId={orgId} conversation={t} onChanged={onChanged} onClosed={onClosed} />}
        <span className="mx-1.5 h-5 w-px bg-white/8" />
        <button
          title={t?.thread.starred ? "Unstar" : "Star"}
          onClick={() => act.mutate(t?.thread.starred ? "unstar" : "star")}
          className={`flex size-8 items-center justify-center rounded-lg hover:bg-white/5 ${
            t?.thread.starred ? "text-ox" : "text-[#9BA1AD] hover:text-foreground"
          }`}
        >
          <Star className="size-[17px]" strokeWidth={1.6} fill={t?.thread.starred ? "currentColor" : "none"} />
        </button>
      </div>

      {detail.isPending ? (
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-[#767d8a]">
          Loading…
        </div>
      ) : !t ? (
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-[#767d8a]">
          Could not load this thread.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
          <ConversationView
            key={t.thread.id}
            orgId={orgId}
            conversation={t}
            fromEmail={replyFromEmail}
            ownEmails={ownEmails}
            onSent={() => {
              qc.invalidateQueries({ queryKey: ["thread", orgId, threadId] });
              onChanged();
            }}
            onRemoveLabel={(labelId) => removeLabel.mutate(labelId)}
            banner={
              t.thread.folder === "unrouted" && (
                <ClaimBanner
                  detail={t}
                  onDone={() => {
                    onChanged();
                    onClosed();
                  }}
                />
              )
            }
          />
        </div>
      )}
    </section>
  );
}



function ThreadListItem({
  t,
  active,
  onSelect,
}: {
  t: ConversationRow;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`relative block w-full border-b border-white/[0.045] px-4 pt-3 pb-[13px] pl-[18px] text-left hover:bg-white/[0.028] ${
        active ? "bg-white/6" : ""
      }`}
    >
      {active && <span className="absolute top-0 bottom-0 left-0 w-[2.5px] bg-ox" />}
      <div className="mb-[3px] flex items-center gap-[9px]">
        {t.unread && <span className="size-[7px] flex-none rounded-full bg-ox" />}
        <span
          className={`flex-1 truncate text-[13.5px] ${
            t.unread ? "font-bold text-[#F2F4F8]" : "font-medium text-[#C4CAD4]"
          }`}
        >
          {t.counterpartyName ?? t.counterpartyEmail ?? "(unknown)"}
        </span>
        <span className="flex-none text-[11px] text-[#7c838f]">{timeLabel(t.lastMessageAt)}</span>
      </div>
      <div
        className={`mb-0.5 truncate text-[13px] ${
          t.unread ? "font-bold text-[#DDE1E8]" : "font-medium text-[#9BA1AD]"
        }`}
      >
        {t.subject || "(no subject)"}
      </div>
      <div className="mb-[7px] truncate text-xs text-[#7c838f]">{t.snippet}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ClassificationBadges compact priority={t.priority} category={t.category} />
        {t.starred && <Star className="size-3 text-ox" fill="currentColor" strokeWidth={0} />}
        {t.muted && <BellOff className="size-3 text-[#7c838f]" strokeWidth={1.8} />}
        {t.snoozedUntil && (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ox">
            <AlarmClock className="size-3" strokeWidth={1.8} />
            {timeLabel(t.snoozedUntil)}
          </span>
        )}
        <span className="inline-flex max-w-[180px] items-center gap-1 truncate rounded-[5px] bg-white/5 px-1.5 py-0.5 text-[10.5px] font-medium text-[#8b919c]">
          {t.address}
        </span>
        {t.messageCount > 1 && (
          <span className="text-[10.5px] text-[#767d8a]">{t.messageCount} messages</span>
        )}
        {t.labels.map((l) => (
          <span
            key={l.id}
            className="inline-flex max-w-[120px] items-center gap-1 truncate rounded-[5px] bg-white/5 px-1.5 py-0.5 text-[10.5px] font-medium text-[#C4CAD4]"
          >
            <span className="size-[6px] flex-none rounded-full" style={{ background: l.color ?? "#7C838F" }} />
            {l.name}
          </span>
        ))}
      </div>
    </button>
  );
}

export function MailPage() {
  const params = useParams({ strict: false }) as { folder?: string; addressId?: string };
  const folder = params.folder ?? "inbox";
  const searchQuery = ((useSearch({ strict: false }) as { q?: string }).q ?? "").trim();
  const searching = folder === "search";
  const addressId = params.addressId;
  // Label views live at /folder/label-<id>.
  const labelId = folder.startsWith("label-") ? folder.slice("label-".length) : undefined;
  const category = folder.startsWith("category-") ? folder.slice("category-".length) : undefined;
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileReading, setMobileReading] = useState(false);

  const folderKey = searching ? `search:${searchQuery}` : addressId ? `addr:${addressId}` : folder;
  const [lastFolderKey, setLastFolderKey] = useState(folderKey);
  if (folderKey !== lastFolderKey) {
    setLastFolderKey(folderKey);
    setSelected(null);
    setMobileReading(false);
  }

  // Infinite, not a single capped page: the list endpoint returns 100 threads
  // plus a keyset cursor, and without following that cursor everything past the
  // first 100 in a folder is simply unreachable from the UI.
  //
  // Only the first page polls. refetchInterval on an infinite query refetches
  // every loaded page on every tick, so a reader several pages deep would
  // re-fetch the whole list every 20s.
  const listQuery = useInfiniteQuery({
    queryKey: searching ? ["mail-search", orgId, searchQuery] : ["threads", orgId, folderKey, filter],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      searching
      ? conversationApi.search(orgId, searchQuery).then((r) => ({ ...r, nextCursor: null }))
      : conversationApi.list(orgId, {
        folder: addressId ? "inbox" : labelId ? "label" : category ? "category" : folder,
        category,
        labelId,
        addressId,
        unread: filter === "unread",
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!orgId && (!searching || !!searchQuery),
    refetchInterval: searching ? false : 20_000,
    refetchOnWindowFocus: !searching,
    refetchOnReconnect: !searching,
    staleTime: searching ? Infinity : 0,
    retry: searching ? false : undefined,
    refetchIntervalInBackground: false,
    maxPages: undefined,
  });

  // Title for address views comes from the addresses cache, not rows[0] —
  // an empty mailbox should still be titled with its own email.
  const addressList = useQuery({
    queryKey: ["addresses", orgId],
    queryFn: () => api.addresses.list(orgId),
    enabled: !!orgId && !!addressId,
  });

  const labelList = useQuery({
    queryKey: ["labels", orgId],
    queryFn: () => conversationApi.labels(orgId),
    enabled: !!orgId && !!labelId,
  });
  const activeLabel = labelList.data?.labels.find((l) => l.id === labelId);

  const rows = (listQuery.data?.pages.flatMap((p) => p.threads) ?? []).filter((t) => !searching || filter !== "unread" || t.unread);
  const title = searching ? `Search: ${searchQuery}` : addressId
    ? (addressList.data?.addresses.find((a) => a.id === addressId)?.email ??
      rows[0]?.address ??
      "Address")
    : category ? categoryLabel(category) : folder === "priority" ? "Priority inbox" : labelId
      ? (activeLabel?.name ?? "Label")
      : folder === "unrouted"
      ? "Unrouted"
      : folder.charAt(0).toUpperCase() + folder.slice(1);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["threads", orgId] });
    qc.invalidateQueries({ queryKey: ["addresses", orgId] });
  };

  function open(t: ConversationRow) {
    setSelected(t.id);
    setMobileReading(true);
    if (t.unread) {
      api.threads.act(orgId, t.id, "read").then(refreshAll);
    }
  }

  return (
    <div className="flex min-w-0 flex-1">
      <section
        className={`min-w-0 flex-1 flex-col bg-surface-2 lg:flex lg:w-[392px] lg:flex-none lg:border-r lg:border-white/6 ${
          mobileReading && selected ? "hidden" : "flex"
        }`}
      >
        <div className="flex h-12 flex-none items-center justify-between border-b border-white/6 px-4">
          <span className="truncate font-heading text-[15px] font-bold">{title}</span>
          <div className="flex items-center gap-1.5">
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
              All
            </FilterChip>
            <FilterChip active={filter === "unread"} onClick={() => setFilter("unread")}>
              Unread
            </FilterChip>
          </div>
        </div>
        <div className="flex flex-1 flex-col overflow-y-auto">
          {searching && !searchQuery ? <p className="p-4 text-sm text-[#9BA1AD]">Enter a search above to find mail.</p> : listQuery.isError ? (
            <p role="alert" className="p-4 text-sm text-ox-danger">{listQuery.error instanceof Error ? listQuery.error.message : "Mail could not be loaded."}</p>
          ) : listQuery.isPending ? (
            <div className="flex flex-1 items-center justify-center text-[12.5px] text-[#767d8a]">
              Loading…
            </div>
          ) : rows.length === 0 ? (
            searching ? <p className="p-4 text-sm text-[#9BA1AD]">No mail matches “{searchQuery}”.</p> : <MailEmpty folder={addressId ? "address" : labelId ? "label" : category ? "category" : folder} />
          ) : (
            <>
              {rows.map((t) => (
                <ThreadListItem
                  key={t.id}
                  t={t}
                  active={t.id === selected}
                  onSelect={() => open(t)}
                />
              ))}
              {listQuery.hasNextPage && (
                <button
                  type="button"
                  onClick={() => listQuery.fetchNextPage()}
                  disabled={listQuery.isFetchingNextPage}
                  className="flex-none border-t border-white/6 px-3.5 py-3 text-[12.5px] font-semibold text-[#9BA1AD] transition-colors hover:bg-white/4 disabled:opacity-60"
                >
                  {listQuery.isFetchingNextPage ? "Loading…" : "Load older messages"}
                </button>
              )}
            </>
          )}
        </div>
      </section>

      {selected ? (
        <div className={`min-w-0 flex-1 ${mobileReading ? "flex" : "hidden lg:flex"}`}>
          <ReadingPane
            threadId={selected}
            onBack={() => setMobileReading(false)}
            onChanged={refreshAll}
            onClosed={() => {
              setSelected(null);
              setMobileReading(false);
            }}
          />
        </div>
      ) : (
        <section className="hidden min-w-0 flex-1 flex-col bg-surface-1 lg:flex">
          <div className="flex flex-1 items-center justify-center">
            <p className="max-w-[280px] text-center text-[12.5px] leading-relaxed text-[#767d8a]">
              Select a message to read it here.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
