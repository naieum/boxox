import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, Bell, BellOff, Check, Tag } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { conversationApi, type Conversation } from "./api";

const ICON_BUTTON =
  "flex size-8 items-center justify-center rounded-lg text-[#9BA1AD] hover:bg-white/5 hover:text-foreground";

function at(days: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Gmail's presets: later today, tomorrow morning, this weekend, next week. */
export function snoozePresets(now = new Date()): { label: string; until: Date }[] {
  const later = new Date(now.getTime() + 3 * 3600_000);
  later.setMinutes(0, 0, 0);
  const toSaturday = (6 - now.getDay() + 7) % 7 || 7;
  const toMonday = (1 - now.getDay() + 7) % 7 || 7;
  return [
    ...(later.getDate() === now.getDate() ? [{ label: "Later today", until: later }] : []),
    { label: "Tomorrow", until: at(1, 8) },
    ...(now.getDay() !== 6 && now.getDay() !== 0 ? [{ label: "This weekend", until: at(toSaturday, 8) }] : []),
    { label: "Next week", until: at(toMonday, 8) },
  ];
}

const when = (d: Date) => d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

export function ThreadControls({
  orgId,
  conversation,
  onChanged,
  onClosed,
}: {
  orgId: string;
  conversation: Conversation;
  onChanged: () => void;
  /** The thread left the current folder. */
  onClosed: () => void;
}) {
  const qc = useQueryClient();
  const { thread } = conversation;
  const [custom, setCustom] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["thread", orgId, thread.id] });
    onChanged();
  };

  const labels = useQuery({ queryKey: ["labels", orgId], queryFn: () => conversationApi.labels(orgId), enabled: !!orgId });

  const mute = useMutation({
    mutationFn: (muted: boolean) => conversationApi.mute(orgId, thread.id, muted),
    onSuccess: (_d, muted) => {
      refresh();
      if (muted && thread.folder === "inbox") onClosed();
    },
  });
  const snooze = useMutation({
    mutationFn: (until: Date | null) => conversationApi.snooze(orgId, thread.id, until),
    onSuccess: () => {
      refresh();
      onClosed();
    },
  });
  const toggleLabel = useMutation({
    mutationFn: ({ labelId, on }: { labelId: string; on: boolean }) =>
      on ? conversationApi.addLabel(orgId, thread.id, labelId) : conversationApi.removeLabel(orgId, thread.id, labelId),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ["labels", orgId] });
    },
  });
  const createLabel = useMutation({
    mutationFn: async (name: string) => {
      const { label } = await conversationApi.createLabel(orgId, name);
      await conversationApi.addLabel(orgId, thread.id, label.id);
    },
    onSuccess: () => {
      setNewLabel("");
      refresh();
      qc.invalidateQueries({ queryKey: ["labels", orgId] });
    },
  });

  const applied = new Set(thread.labels.map((l) => l.id));
  const canSnooze = thread.folder === "inbox" || thread.folder === "archive";
  const customUntil = custom ? new Date(custom) : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button title="Labels" className={ICON_BUTTON}>
            <Tag className="size-[17px]" strokeWidth={1.6} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 rounded-xl bg-surface-4">
          <DropdownMenuLabel className="text-[11px] text-[#7C838F]">Label as</DropdownMenuLabel>
          {(labels.data?.labels ?? []).map((l) => (
            <DropdownMenuItem
              key={l.id}
              onSelect={(e) => {
                e.preventDefault();
                toggleLabel.mutate({ labelId: l.id, on: !applied.has(l.id) });
              }}
              className="gap-2 text-[12.5px]"
            >
              <span className="size-2.5 flex-none rounded-full" style={{ background: l.color ?? "#7C838F" }} />
              <span className="flex-1 truncate">{l.name}</span>
              {applied.has(l.id) && <Check className="size-3.5" strokeWidth={2} />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <form
            className="px-2 py-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (newLabel.trim()) createLabel.mutate(newLabel.trim());
            }}
          >
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="New label…"
              maxLength={60}
              className="h-7 w-full rounded-md border border-white/10 bg-white/4 px-2 text-[12px] outline-none placeholder:text-[#7c838f]"
            />
            {createLabel.isError && (
              <div className="mt-1 text-[11px] text-ox-danger">
                {createLabel.error instanceof Error ? createLabel.error.message : "Could not create label"}
              </div>
            )}
          </form>
        </DropdownMenuContent>
      </DropdownMenu>

      {canSnooze && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title={thread.snoozedUntil ? `Snoozed until ${when(new Date(thread.snoozedUntil))}` : "Snooze"}
              className={`${ICON_BUTTON} ${thread.snoozedUntil ? "text-ox" : ""}`}
            >
              <AlarmClock className="size-[17px]" strokeWidth={1.6} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 rounded-xl bg-surface-4">
            <DropdownMenuLabel className="text-[11px] text-[#7C838F]">Snooze until…</DropdownMenuLabel>
            {snoozePresets().map((p) => (
              <DropdownMenuItem key={p.label} onSelect={() => snooze.mutate(p.until)} className="text-[12.5px]">
                <span className="flex-1">{p.label}</span>
                <span className="text-[11px] text-[#7C838F]">{when(p.until)}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <input
                type="datetime-local"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                className="h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-white/4 px-1.5 text-[12px] outline-none"
              />
              <button
                type="button"
                disabled={!customUntil || customUntil.getTime() <= Date.now()}
                onClick={() => customUntil && snooze.mutate(customUntil)}
                className="h-7 rounded-md bg-white/8 px-2 text-[12px] font-semibold hover:bg-white/12 disabled:opacity-50"
              >
                Snooze
              </button>
            </div>
            {thread.snoozedUntil && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => snooze.mutate(null)} className="text-[12.5px]">
                  Unsnooze
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <button
        title={thread.muted ? "Unmute" : "Mute — later replies skip the inbox"}
        onClick={() => mute.mutate(!thread.muted)}
        className={`${ICON_BUTTON} ${thread.muted ? "text-ox" : ""}`}
      >
        {thread.muted ? <BellOff className="size-[17px]" strokeWidth={1.6} /> : <Bell className="size-[17px]" strokeWidth={1.6} />}
      </button>
    </>
  );
}
