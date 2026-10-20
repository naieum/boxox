import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronLeft, Clock, Paperclip, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useActiveOrgId, useMe } from "@/AppShell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, type ComposeMode, type DraftFields, type DraftRow } from "@/lib/api";

const LAST_FROM_KEY = "boxox:last-from-address";
const AUTOSAVE_MS = 1200;
/** Must match the worker: 5 MiB per message including base64, and 50 recipients across To, Cc and Bcc. */
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 50;
const encodedSize = (bytes: number) => Math.ceil(bytes / 57) * 78;

const TITLES: Record<ComposeMode, string> = {
  new: "New message",
  reply: "Reply",
  reply_all: "Reply all",
  forward: "Forward",
  forward_eml: "Forward as attachment",
};

const splitRecipients = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);

/** An ISO instant as a datetime-local value in the browser's zone. */
const toLocalInput = (iso: string) =>
  new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface ComposeSearch {
  from?: string;
  draft?: string;
  reply?: string;
  mode?: ComposeMode;
}

export function ComposePage() {
  const me = useMe();
  if (me.data?.capabilities?.sending === false) return <div className="p-6"><h1 className="text-lg font-semibold">Receiving only</h1><p className="mt-2 text-sm text-[#9BA1AD]">Outbound sending is not installed. Upgrade your Cloudflare Workers plan, then rerun the Box Ox installer.</p></div>;
  return <ComposeEditor />;
}

function ComposeEditor() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const orgId = useActiveOrgId();
  const search = useSearch({ strict: false }) as ComposeSearch;
  const mode: ComposeMode = search.mode ?? "new";

  const [fromId, setFromId] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendAt, setSendAt] = useState("");
  const [linkDays, setLinkDays] = useState(7);
  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!search.draft && !search.reply);
  const touched = useRef(false);
  const draftId = useRef<string | null>(search.draft ?? null);
  const threadId = useRef<string | null>(null);
  const saving = useRef<Promise<DraftRow | null> | null>(null);

  const addresses = useQuery({
    queryKey: ["addresses", orgId],
    queryFn: () => api.addresses.list(orgId),
    enabled: !!orgId,
  });
  const context = useQuery({
    queryKey: ["reply-context", orgId, search.reply, mode],
    queryFn: () => api.replyContext(orgId, search.reply!, mode),
    enabled: !!orgId && !!search.reply && !search.draft,
  });
  const existing = useQuery({
    queryKey: ["draft", orgId, search.draft],
    queryFn: () => api.drafts.get(orgId, search.draft!),
    enabled: !!orgId && !!search.draft,
  });

  const sendable = (addresses.data?.addresses ?? []).filter(
    (a) => a.canSend && a.status === "active",
  );
  // From priority: explicit pick > reply context / draft > address view (?from=) > last used > first.
  const pick = (id: string | null | undefined) =>
    id ? (sendable.find((a) => a.id === id) ?? null) : null;
  const from =
    pick(fromId) ??
    pick(search.from) ??
    pick(localStorage.getItem(LAST_FROM_KEY)) ??
    sendable[0] ??
    null;

  useEffect(() => {
    const d = existing.data?.draft;
    if (!d || loaded) return;
    setDraft(d);
    setFromId(d.fromAddressId);
    setTo(d.to.join(", "));
    setCc(d.cc.join(", "));
    setBcc(d.bcc.join(", "));
    setShowCcBcc(d.cc.length + d.bcc.length > 0);
    setSubject(d.subject);
    setBody(d.text);
    setSendAt(d.sendAt ? toLocalInput(d.sendAt) : "");
    threadId.current = d.threadId;
    setLoaded(true);
  }, [existing.data, loaded]);

  useEffect(() => {
    const ctx = context.data;
    if (!ctx || loaded) return;
    if (ctx.fromAddressId) setFromId(ctx.fromAddressId);
    setTo(ctx.to.join(", "));
    setCc(ctx.cc.join(", "));
    setShowCcBcc(ctx.cc.length > 0);
    setSubject(ctx.subject);
    setBody(ctx.quote);
    threadId.current = ctx.threadId;
    setLoaded(true);
  }, [context.data, loaded]);

  const fields = (): DraftFields & { fromAddressId: string } => ({
    fromAddressId: from!.id,
    threadId: threadId.current,
    replyToMessageId: search.reply ?? draft?.replyToMessageId ?? null,
    mode: draft?.mode ?? mode,
    to: splitRecipients(to),
    cc: splitRecipients(cc),
    bcc: splitRecipients(bcc),
    subject,
    text: body,
    sendAt: sendAt ? new Date(sendAt).toISOString() : null,
  });

  /** Create the draft on first save, then autosave into it. Saves never overlap. */
  const save = async (): Promise<DraftRow | null> => {
    if (!from) return null;
    await saving.current;
    const run = (async () => {
      setSaveState("saving");
      try {
        const { draft: saved } = draftId.current
          ? await api.drafts.update(orgId, draftId.current, fields())
          : await api.drafts.create(orgId, fields());
        draftId.current = saved.id;
        setDraft(saved);
        setSaveState("saved");
        return saved;
      } catch (err) {
        setSaveState("error");
        throw err;
      }
    })();
    saving.current = run.catch(() => null);
    return run;
  };

  useEffect(() => {
    if (!loaded || !touched.current || !from) return;
    const timer = setTimeout(() => void save().catch(() => {}), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [to, cc, bcc, subject, body, sendAt, from?.id, loaded]);

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      touched.current = true;
      set(v);
    };

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const d = draftId.current ? draft : await save();
      if (!d) throw new Error("Pick a From address first");
      let latest = d;
      for (const file of files) latest = (await api.drafts.upload(orgId, d.id, file)).draft;
      setDraft(latest);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Upload failed"),
  });

  const removeAttachment = useMutation({
    mutationFn: async (index: number) => {
      if (!draftId.current) return;
      setDraft((await api.drafts.removeAttachment(orgId, draftId.current, index)).draft);
    },
  });

  const send = useMutation({
    mutationFn: async () => {
      if (!from) throw new Error("Pick a From address");
      const d = await save();
      if (!d) throw new Error("Could not save the draft");
      return api.drafts.send(orgId, d.id, {
        sendAt: sendAt ? new Date(sendAt).toISOString() : null,
        linkExpiresInDays: linkDays,
      });
    },
    onSuccess: () => {
      if (from) localStorage.setItem(LAST_FROM_KEY, from.id);
      qc.invalidateQueries({ queryKey: ["threads"] });
      navigate({ to: "/folder/$folder", params: { folder: "sent" } });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Send failed"),
  });

  const discard = async () => {
    const dirty = Boolean(to.trim() || subject.trim() || body.trim() || draft?.attachments.length);
    if (dirty && !window.confirm("Discard this draft?")) return;
    await saving.current;
    if (draftId.current) await api.drafts.remove(orgId, draftId.current).catch(() => {});
    navigate({ to: "/" });
  };
  // Leaving keeps the draft: it's already autosaved.
  const leave = async () => {
    if (touched.current) await save().catch(() => {});
    navigate({ to: "/" });
  };

  const recipientCount = splitRecipients(to).length + splitRecipients(cc).length + splitRecipients(bcc).length;
  const forwarded = mode === "forward" || mode === "forward_eml" ? (context.data?.attachments ?? []) : [];
  const fileSizes = [...(draft?.attachments ?? []), ...forwarded].map((a) => a.size);
  const enc = new TextEncoder();
  const totalBytes =
    enc.encode(subject).length +
    enc.encode(body).length +
    fileSizes.reduce((n, s) => n + encodedSize(s), 0);
  const overSize = totalBytes > MAX_MESSAGE_BYTES;
  const tooMany = recipientCount > MAX_RECIPIENTS;

  const missing = !from
    ? "Pick a From address to send"
    : !to.trim()
      ? "Add a recipient to send"
      : tooMany
        ? `At most ${MAX_RECIPIENTS} recipients across To, Cc and Bcc`
        : !subject.trim()
          ? "Add a subject to send"
          : !body.trim()
            ? "Write a message to send"
            : null;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-surface-1">
      <div className="flex h-12 flex-none items-center justify-between border-b border-white/6 px-4">
        <div className="flex items-center gap-2.5">
          <button
            onClick={leave}
            title="Back to inbox (the draft is kept)"
            className="flex size-[34px] items-center justify-center rounded-[9px] text-[#9BA1AD] hover:bg-white/5 hover:text-foreground"
          >
            <ChevronLeft className="size-[19px]" strokeWidth={1.8} />
          </button>
          <span className="font-heading text-[15px] font-bold">{TITLES[draft?.mode ?? mode]}</span>
          <span className="text-xs text-[#7c838f]">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "Draft saved"
                : saveState === "error"
                  ? "Couldn't save the draft"
                  : ""}
          </span>
        </div>
        <Button
          variant="outline"
          onClick={discard}
          className="h-8 rounded-[9px] border-white/12 bg-transparent px-[13px] text-[12.5px] font-medium text-[#C4CAD4]"
        >
          Discard
        </Button>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-[920px] flex-1 flex-col px-2">
        <div className="flex items-center gap-2.5 border-b border-white/5 px-5 py-[13px]">
          <span className="w-[52px] text-[12.5px] text-[#7C838F]">From</span>
          {sendable.length === 0 ? (
            <span className="text-[13px] text-[#9BA1AD]">
              No sendable addresses —{" "}
              <Link to="/domains" className="font-medium text-ox-info hover:text-[#6cbcff]">
                create one under Domains
              </Link>{" "}
              first.
            </span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-white/4">
                <span className="flex size-5 items-center justify-center rounded-[5px] bg-ox-navy font-heading text-[9px] font-bold text-ox-cream">
                  @
                </span>
                <span className="text-[13px] font-medium">{from?.email}</span>
                <ChevronDown className="size-[13px] text-[#7C838F]" strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="rounded-xl bg-surface-4">
                {sendable.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    onClick={() => edit(setFromId)(a.id)}
                    className="gap-2"
                  >
                    <span className="flex-1 text-[13px]">{a.email}</span>
                    {a.id === from?.id && <Check className="size-4 text-ox" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <RecipientRow label="To" value={to} onChange={edit(setTo)}>
          {!showCcBcc && (
            <button
              onClick={() => setShowCcBcc(true)}
              className="text-[12px] text-[#7C838F] hover:text-foreground"
            >
              Cc Bcc
            </button>
          )}
          <span className={`text-[11.5px] ${tooMany ? "text-ox-danger" : "text-[#7c838f]"}`}>
            {recipientCount}/{MAX_RECIPIENTS}
          </span>
        </RecipientRow>
        {showCcBcc && (
          <>
            <RecipientRow label="Cc" value={cc} onChange={edit(setCc)} />
            <RecipientRow label="Bcc" value={bcc} onChange={edit(setBcc)} />
          </>
        )}
        <div className="flex items-center gap-2.5 border-b border-white/5 px-5 py-[13px]">
          <span className="w-[52px] text-[12.5px] text-[#7C838F]">Subject</span>
          <input
            value={subject}
            onChange={(e) => edit(setSubject)(e.target.value)}
            placeholder="Subject"
            className="flex-1 bg-transparent text-[13.5px] font-medium outline-none placeholder:text-[#7c838f]"
          />
        </div>
        <textarea
          value={body}
          onChange={(e) => edit(setBody)(e.target.value)}
          placeholder="Write your message…"
          className="min-h-[160px] w-full flex-1 resize-none bg-transparent px-5 py-[18px] text-[14.5px] leading-[1.7] text-[#C9CFD8] outline-none placeholder:text-[#7c838f]"
        />

        {(draft?.attachments.length || forwarded.length) ? (
          <div className="flex flex-wrap gap-2 border-t border-white/5 px-5 py-3">
            {draft?.attachments.map((a) => (
              <span
                key={`d${a.index}`}
                className="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1 text-[12px]"
              >
                {a.filename} <span className="text-[#7c838f]">{formatSize(a.size)}</span>
                <button
                  onClick={() => removeAttachment.mutate(a.index)}
                  title="Remove"
                  className="text-[#7c838f] hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {forwarded.map((a, i) => (
              <span
                key={`f${i}`}
                className="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1 text-[12px] text-[#9BA1AD]"
              >
                {a.filename} <span className="text-[#7c838f]">{formatSize(a.size)} · forwarded</span>
              </span>
            ))}
          </div>
        ) : null}

        <SizeMeter bytes={totalBytes} />
        {overSize && (
          <div className="flex items-center gap-2 px-5 pb-2 text-[12px] text-[#C4CAD4]">
            Over {MAX_MESSAGE_BYTES / 1024 / 1024} MB: the largest files go out as download links that
            expire after
            <select
              value={linkDays}
              onChange={(e) => setLinkDays(Number(e.target.value))}
              className="rounded-md bg-white/5 px-1.5 py-0.5"
            >
              {[1, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d} {d === 1 ? "day" : "days"}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-white/6 px-5 py-[13px]">
          <div className="flex items-center gap-3">
            <label
              title="Attach files"
              className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-[#9BA1AD] hover:text-foreground"
            >
              <Paperclip className="size-[14px]" strokeWidth={1.8} />
              {upload.isPending ? "Uploading…" : "Attach"}
              <input
                type="file"
                multiple
                className="hidden"
                disabled={!from || upload.isPending}
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (files.length) {
                    touched.current = true;
                    upload.mutate(files);
                  }
                }}
              />
            </label>
            <label className="flex items-center gap-1.5 text-[12.5px] text-[#9BA1AD]" title="Schedule send">
              <Clock className="size-[14px]" strokeWidth={1.8} />
              <input
                type="datetime-local"
                value={sendAt}
                min={toLocalInput(new Date().toISOString())}
                onChange={(e) => edit(setSendAt)(e.target.value)}
                className="bg-transparent text-[12.5px] outline-none"
              />
            </label>
          </div>
          <div className="flex items-center gap-2.5">
            {error ? (
              <span className="text-xs text-ox-danger">{error}</span>
            ) : (
              missing && <span className="text-xs text-[#7c838f]">{missing}</span>
            )}
            <Button
              onClick={() => {
                setError(null);
                send.mutate();
              }}
              disabled={send.isPending || upload.isPending || !!missing}
              className="h-[34px] gap-2 rounded-[9px] px-[17px] font-heading text-[13px] font-semibold"
            >
              {send.isPending ? "Sending…" : sendAt ? "Schedule" : "Send"}
              <Send className="size-[14px]" strokeWidth={1.8} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecipientRow({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-white/5 px-5 py-[13px]">
      <span className="w-[52px] text-[12.5px] text-[#7C838F]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Recipients (comma separated)"
        className="flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-[#7c838f]"
      />
      {children}
    </div>
  );
}

/** Running total against the 5 MiB limit, counting base64 overhead as the worker does. */
function SizeMeter({ bytes }: { bytes: number }) {
  const ratio = Math.min(bytes / MAX_MESSAGE_BYTES, 1);
  const over = bytes > MAX_MESSAGE_BYTES;
  return (
    <div className="flex items-center gap-2.5 px-5 py-2" title="Message size including encoding">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/6">
        <div
          className={`h-full ${over ? "bg-ox-danger" : ratio > 0.8 ? "bg-amber-400" : "bg-ox"}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <span className={`text-[11.5px] tabular-nums ${over ? "text-ox-danger" : "text-[#7c838f]"}`}>
        {formatSize(bytes)} of {MAX_MESSAGE_BYTES / 1024 / 1024} MB
      </span>
    </div>
  );
}
