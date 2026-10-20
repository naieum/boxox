import { BellOff, AlarmClock, ChevronsUpDown, Download, Forward, Reply, ReplyAll, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { initialsOf } from "@/components/brand";
import { SpamWhy } from "@/components/SpamWhy";
import type { Conversation, ConversationMessage, Label } from "./api";
import { Composer } from "./Composer";
import { MessageBody } from "./MessageBody";
import { PreviewActions } from "./PreviewActions";
import { AssistActions } from "./AssistActions";
import { ClassificationBadges } from "./ClassificationBadges";
import { initiallyExpanded, type ReplyMode } from "./recipients";

const AVATARS = ["#3DA5F4", "#35C07A", "#A78BFA", "#F26B2C", "#F4E9D6"];
export function avatarFor(email: string): string {
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return AVATARS[Math.abs(h) % AVATARS.length]!;
}

/** Long conversations show the first message and the last two; the middle folds into "N earlier messages". */
const FOLD_FROM = 5;

function Avatar({ email, name, size }: { email: string; name?: string | null; size: number }) {
  return (
    <div
      className="flex flex-none items-center justify-center rounded-full font-heading font-semibold text-[#0b0d12]"
      style={{ background: avatarFor(email), width: size, height: size, fontSize: size * 0.33 }}
    >
      {initialsOf(name || email)}
    </div>
  );
}

export function LabelChip({ label, onRemove }: { label: Label; onRemove?: () => void }) {
  return (
    <span className="inline-flex max-w-[160px] items-center gap-1 rounded-[5px] bg-white/6 px-1.5 py-0.5 text-[10.5px] font-medium text-[#C4CAD4]">
      <span className="size-[7px] flex-none rounded-full" style={{ background: label.color ?? "#7C838F" }} />
      <Link to="/folder/$folder" params={{ folder: `label-${label.id}` }} className="truncate hover:underline">
        {label.name}
      </Link>
      {onRemove && (
        <button title={`Remove ${label.name}`} onClick={onRemove} className="text-[#7C838F] hover:text-foreground">
          <X className="size-2.5" strokeWidth={2} />
        </button>
      )}
    </span>
  );
}

function ParticipantsBar({ conversation, own }: { conversation: Conversation; own: Set<string> }) {
  const names = new Map<string, string>();
  const joined = new Set<string>();
  for (const m of conversation.messages) {
    if (m.fromName) names.set(m.fromEmail.toLowerCase(), m.fromName);
    if (m.newParticipant) joined.add(m.fromEmail.toLowerCase());
  }
  const people = [
    ...new Set(
      [...conversation.thread.participants, ...conversation.messages.flatMap((m) => [m.fromEmail, ...m.toEmails, ...m.ccEmails])].map((e) =>
        e.toLowerCase(),
      ),
    ),
  ].filter((e) => e && !own.has(e));
  if (!people.length) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] font-semibold tracking-[0.04em] text-[#767d8a] uppercase">
        {people.length} {people.length === 1 ? "participant" : "participants"}
      </span>
      {people.map((email) => (
        <span
          key={email}
          title={joined.has(email) ? `${email} joined partway through` : email}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/8 bg-white/3 py-0.5 pr-2.5 pl-0.5 text-[11.5px] text-[#C4CAD4]"
        >
          <Avatar email={email} name={names.get(email)} size={18} />
          <span className="max-w-[180px] truncate">{names.get(email) ?? email}</span>
          {joined.has(email) && <span className="text-[10px] font-semibold text-[#F2B33D]">new</span>}
        </span>
      ))}
    </div>
  );
}

function MessageActions({
  messageId,
  onAction,
  canReply,
}: {
  messageId: string;
  onAction: (mode: ReplyMode) => void;
  canReply: boolean;
}) {
  if (!canReply) return null;
  const btn = "flex size-7 items-center justify-center rounded-md text-[#9BA1AD] hover:bg-white/6 hover:text-foreground";
  return (
    <div className="flex flex-none items-center" onClick={(e) => e.stopPropagation()}>
      <button title="Reply" onClick={() => onAction("reply")} className={btn}>
        <Reply className="size-[15px]" strokeWidth={1.7} />
      </button>
      <button title="Reply all" onClick={() => onAction("reply_all")} className={btn}>
        <ReplyAll className="size-[15px]" strokeWidth={1.7} />
      </button>
      <button title="Forward" onClick={() => onAction("forward")} className={btn}>
        <Forward className="size-[15px]" strokeWidth={1.7} />
      </button>
      <Link
        to="/compose"
        search={{ reply: messageId, mode: "forward_eml" }}
        title="Forward as .eml attachment"
        className="rounded-md px-1.5 text-[10.5px] font-semibold text-[#9BA1AD] hover:bg-white/6 hover:text-foreground"
      >
        .eml
      </Link>
    </div>
  );
}

function MessageCard({
  m,
  orgId,
  threadId,
  folder,
  expanded,
  onToggle,
  actions,
}: {
  m: ConversationMessage;
  orgId: string;
  threadId: string;
  folder: string;
  expanded: boolean;
  onToggle: () => void;
  actions: ReactNode;
}) {
  const time = new Date(m.occurredAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (!expanded) {
    return (
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-[11px] py-2.5 text-left hover:bg-white/[0.02]"
      >
        <Avatar email={m.fromEmail} name={m.fromName} size={30} />
        <span className="w-[140px] flex-none truncate text-[13px] font-semibold text-[#C4CAD4]">
          {m.direction === "outbound" ? "Sent · " + (m.fromName ?? m.fromEmail) : (m.fromName ?? m.fromEmail)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#7c838f]">{m.snippet}</span>
        <span className="flex-none text-[11.5px] text-[#7c838f]">{time}</span>
      </button>
    );
  }
  return (
    <div className="py-1">
      <div className="mb-4 flex cursor-pointer items-center gap-[13px]" onClick={onToggle}>
        <Avatar email={m.fromEmail} name={m.fromName} size={42} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[14.5px] font-semibold">{m.fromName ?? m.fromEmail}</span>
            <span className="text-[12.5px] text-[#7C838F]">{m.fromEmail}</span>
            {m.direction === "outbound" && (
              <span className="rounded bg-white/6 px-1.5 text-[10.5px] font-semibold text-[#9BA1AD]">sent by Box Ox</span>
            )}
            {/* Every unauthenticated inbound message carries its own warning. */}
            {m.direction === "inbound" && !m.authenticated && (
              <span
                title="This sender's domain did not pass DMARC / SPF+DKIM checks."
                className="rounded bg-[rgba(242,179,61,0.1)] px-1.5 text-[10.5px] font-semibold text-[#F2B33D]"
              >
                unverified sender
              </span>
            )}
            {m.newParticipant && (
              <span
                title="This sender was not in the conversation before. Reply headers can be forged; check who they are before trusting the message."
                className="rounded bg-[rgba(61,165,244,0.12)] px-1.5 text-[10.5px] font-semibold text-[#3DA5F4]"
              >
                new participant
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-[#7c838f]">
            to {m.toEmails.join(", ")}
            {m.ccEmails.length > 0 && <> · cc {m.ccEmails.join(", ")}</>}
          </div>
        </div>
        <span className="flex-none text-xs text-[#7c838f]">{time}</span>
        {actions}
      </div>
      {m.direction === "inbound" && (folder === "spam" || folder === "quarantine") && (
        <div className="mb-3">
          <SpamWhy verdict={m.spamVerdict} folder={folder} />
        </div>
      )}
      <MessageBody message={m} />
      {m.attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {m.attachments.map((a, j) =>
            a.truncated ? (
              <span key={j} className="rounded-lg border border-white/10 bg-white/4 px-2.5 py-1 text-xs text-[#C4CAD4]">
                {a.filename} · {(a.size / 1024).toFixed(0)}kb
                <span className="text-[#767d8a]"> · not stored — too large</span>
              </span>
            ) : (
              <a
                key={j}
                href={`/api/orgs/${orgId}/threads/${threadId}/attachments/${a.messageId}/${a.index}`}
                download
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/4 px-2.5 py-1 text-xs text-[#C4CAD4] hover:border-white/20 hover:text-foreground"
              >
                <Download className="size-3.5" strokeWidth={1.6} />
                {a.filename} · {(a.size / 1024).toFixed(0)}kb
              </a>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function ConversationView({
  orgId,
  conversation,
  fromEmail,
  ownEmails,
  banner,
  onSent,
  onRemoveLabel,
}: {
  orgId: string;
  conversation: Conversation;
  /** The address this thread lives on, shown as the reply identity. */
  fromEmail: string | null;
  /** Every address the user owns; reply-all leaves them out. */
  ownEmails: string[];
  banner?: ReactNode;
  onSent: () => void;
  onRemoveLabel: (labelId: string) => void;
}) {
  const { thread, messages } = conversation;
  const [expanded, setExpanded] = useState(() => initiallyExpanded(messages, thread.unread));
  const [showAll, setShowAll] = useState(messages.length < FOLD_FROM);
  const [composing, setComposing] = useState<{ mode: ReplyMode; message: ConversationMessage; initialText?: string } | null>(null);
  const [sentTo, setSentTo] = useState<string[] | null>(null);
  const [seen, setSeen] = useState(messages.length);
  if (messages.length !== seen) {
    // Messages that arrive while the conversation is open (a reply just sent, new mail) open expanded.
    const arrived = messages.slice(seen).map((m) => m.id);
    setSeen(messages.length);
    setExpanded((prev) => new Set([...prev, ...arrived]));
  }

  const own = new Set([...ownEmails, ...(fromEmail ? [fromEmail] : [])].map((e) => e.toLowerCase()));
  const canReply = !!thread.addressId && thread.folder !== "unrouted";
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const startReply = (mode: ReplyMode, message: ConversationMessage) => {
    setSentTo(null);
    setComposing({ mode, message });
  };

  // Folded: the first message, the last two, and anything the reader opened.
  const hidden = showAll ? [] : messages.slice(1, -2).filter((m) => !expanded.has(m.id));
  const hiddenIds = new Set(hidden.map((m) => m.id));
  const latest = messages.at(-1);

  return (
    <div className="mx-auto max-w-[720px]">
      {banner}
      <h1 className="mb-2.5 font-heading text-[23px] leading-[1.25] font-bold tracking-[-0.02em]">
        {thread.subject || "(no subject)"}
      </h1>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <ClassificationBadges priority={thread.priority} category={thread.category} />
        {thread.labels.map((l) => (
          <LabelChip key={l.id} label={l} onRemove={() => onRemoveLabel(l.id)} />
        ))}
        {thread.muted && (
          <span className="inline-flex items-center gap-1 rounded-[5px] bg-white/6 px-1.5 py-0.5 text-[10.5px] font-medium text-[#9BA1AD]">
            <BellOff className="size-2.5" strokeWidth={2} /> Muted
          </span>
        )}
        {thread.snoozedUntil && (
          <span className="inline-flex items-center gap-1 rounded-[5px] bg-ox/10 px-1.5 py-0.5 text-[10.5px] font-medium text-ox">
            <AlarmClock className="size-2.5" strokeWidth={2} /> Snoozed until{" "}
            {new Date(thread.snoozedUntil).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>
      <ParticipantsBar conversation={conversation} own={own} />
      <PreviewActions key={`${orgId}-${thread.id}`} orgId={orgId} conversation={conversation} />
      <AssistActions
        key={`${thread.id}-${messages.length}`}
        orgId={orgId}
        threadId={thread.id}
        canReply={canReply && !!latest && !composing}
        onReply={(initialText) => {
          if (latest && !composing) {
            setSentTo(null);
            setExpanded((prev) => new Set([...prev, latest.id]));
            setComposing({ mode: "reply", message: latest, initialText });
          }
        }}
      />

      <div className="flex flex-col divide-y divide-white/7 border-y border-white/7">
        {messages.map((m, i) => {
          if (hiddenIds.has(m.id)) {
            if (i !== 1) return null;
            return (
              <button
                key="earlier"
                onClick={() => setShowAll(true)}
                className="flex items-center gap-2 py-2.5 text-[12.5px] font-semibold text-[#9BA1AD] hover:text-foreground"
              >
                <ChevronsUpDown className="size-3.5" strokeWidth={1.8} />
                {hidden.length} earlier {hidden.length === 1 ? "message" : "messages"}
              </button>
            );
          }
          return (
            <div key={m.id}>
              <MessageCard
                m={m}
                orgId={orgId}
                threadId={thread.id}
                folder={thread.folder}
                expanded={expanded.has(m.id)}
                onToggle={() => toggle(m.id)}
                actions={<MessageActions messageId={m.id} canReply={canReply} onAction={(mode) => startReply(mode, m)} />}
              />
              {composing?.message.id === m.id && thread.addressId && (
                <div className="pb-4">
                  <Composer
                    key={`${m.id}-${composing.mode}`}
                    orgId={orgId}
                    threadId={thread.id}
                    subject={thread.subject}
                    message={m}
                    mode={composing.mode}
                    initialText={composing.initialText}
                    fromAddressId={thread.addressId}
                    fromEmail={fromEmail}
                    ownEmails={[...own]}
                    onSent={(to) => {
                      setComposing(null);
                      setSentTo(to);
                      onSent();
                    }}
                    onClose={() => setComposing(null)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {sentTo && (
        <div className="mt-6 flex items-center gap-[9px] rounded-xl border border-[rgba(53,192,122,0.3)] bg-[rgba(53,192,122,0.07)] px-4 py-3">
          <span className="text-[13px] font-medium text-ox-success">Sent to {sentTo.join(", ")}</span>
        </div>
      )}

      {canReply && latest && !composing && (
        <div className="mt-6 flex flex-wrap gap-2.5">
          {(["reply", "reply_all", "forward"] as const).map((mode) => {
            const Icon = mode === "reply" ? Reply : mode === "reply_all" ? ReplyAll : Forward;
            return (
              <button
                key={mode}
                onClick={() => startReply(mode, latest)}
                className="flex h-[38px] items-center gap-2 rounded-[10px] border border-white/14 bg-white/4 px-[18px] font-heading text-[13px] font-semibold hover:bg-white/8"
              >
                <Icon className="size-4" strokeWidth={1.7} />
                {mode === "reply" ? "Reply" : mode === "reply_all" ? "Reply all" : "Forward"}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
