import { useMe } from "@/AppShell";
import type { ComponentProps } from "react";
import { useMutation } from "@tanstack/react-query";
import { Send as SendIcon, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { ConversationMessage } from "./api";
import { forwardedBody, replyRecipients, replySubject, type ReplyMode } from "./recipients";

const MODE_LABEL: Record<ReplyMode, string> = { reply: "Reply", reply_all: "Reply all", forward: "Forward" };
const splitEmails = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);

function AddressField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 border-b border-white/6 px-4 py-2 text-[12.5px]">
      <span className="w-6 flex-none text-[#7C838F]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-[#C9CFD8] outline-none"
      />
    </label>
  );
}

function ComposerEditor({
  orgId,
  threadId,
  subject,
  message,
  mode,
  initialText,
  fromAddressId,
  fromEmail,
  ownEmails,
  onSent,
  onClose,
}: {
  orgId: string;
  threadId: string;
  subject: string;
  message: ConversationMessage;
  mode: ReplyMode;
  initialText?: string;
  fromAddressId: string;
  fromEmail: string | null;
  ownEmails: string[];
  onSent: (to: string[]) => void;
  onClose: () => void;
}) {
  const initial = replyRecipients(message, mode, ownEmails);
  const [to, setTo] = useState(initial.to.join(", "));
  const [cc, setCc] = useState(initial.cc.join(", "));
  const [text, setText] = useState(initialText ?? (mode === "forward" ? forwardedBody(message) : ""));

  const send = useMutation({
    mutationFn: () => {
      const recipients = splitEmails(to);
      if (!recipients.length) throw new Error("Add at least one recipient");
      return api.send(orgId, {
        fromAddressId,
        to: recipients,
        cc: splitEmails(cc),
        subject: replySubject(subject, mode),
        text,
        // A forward starts its own conversation.
        threadId: mode === "forward" ? undefined : threadId,
      });
    },
    onSuccess: () => onSent(splitEmails(to)),
  });

  return (
    <div className="mt-4 overflow-hidden rounded-[14px] border border-white/11 bg-[#0c0f15]">
      <div className="flex items-center gap-2.5 border-b border-white/6 px-4 py-[11px]">
        <span className="min-w-0 truncate text-[12.5px] text-[#9BA1AD]">
          <span className="font-semibold text-foreground">{MODE_LABEL[mode]}</span>
          {fromEmail && (
            <>
              {" "}
              · from <span className="font-medium text-[#C4CAD4]">{fromEmail}</span>
            </>
          )}
        </span>
        <span className="flex-1" />
        <button
          onClick={onClose}
          title="Discard"
          className="flex size-[26px] items-center justify-center rounded-[7px] text-[#7C838F] hover:bg-white/6 hover:text-foreground"
        >
          <X className="size-3.5" strokeWidth={1.8} />
        </button>
      </div>
      <AddressField label="To" value={to} onChange={setTo} />
      {(mode !== "reply" || cc) && <AddressField label="Cc" value={cc} onChange={setCc} />}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        placeholder={mode === "forward" ? "Add a note…" : "Write your reply…"}
        className="block min-h-[130px] w-full resize-y bg-transparent px-4 py-3.5 text-sm leading-[1.7] text-[#C9CFD8] outline-none placeholder:text-[#7c838f]"
      />
      <div className="flex items-center gap-2.5 border-t border-white/6 px-4 py-[11px]">
        <span className="flex-1" />
        {send.isError && (
          <span className="text-xs text-ox-danger">
            {send.error instanceof Error ? send.error.message : "Send failed"}
          </span>
        )}
        <Button
          onClick={() => send.mutate()}
          disabled={send.isPending || !text.trim()}
          className="h-8 gap-[7px] rounded-[9px] px-[15px] font-heading text-[12.5px] font-semibold"
        >
          {send.isPending ? "Sending…" : "Send"}
          <SendIcon className="size-[13px]" strokeWidth={1.8} />
        </Button>
      </div>
    </div>
  );
}

export function Composer(props: ComponentProps<typeof ComposerEditor>) {
  const me = useMe();
  if (me.data?.capabilities?.sending === false) return null;
  return <ComposerEditor {...props} />;
}
