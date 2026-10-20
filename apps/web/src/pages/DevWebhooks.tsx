import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Plus, RotateCw, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { PageContainer, PageHeader, Panel, PanelEmpty } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DevTabs, DomainKeyGate, StatusPill, devRequest, errorText, when } from "./DevShared";

const EVENTS = [
  "message.sent",
  "message.delivered",
  "message.deferred",
  "message.bounced",
  "message.complained",
  "message.failed",
  "message.opened",
  "message.clicked",
  "message.received",
] as const;
type EventType = (typeof EVENTS)[number];

interface Webhook {
  id: string;
  url: string;
  events: EventType[];
  status: string;
  consecutiveFailures: number;
  disabledAt: string | null;
  previousSecretExpiresAt: string | null;
  createdAt: string;
}

interface Delivery {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  deliveredAt: string | null;
  createdAt: string;
}

interface DeliveryFull extends Delivery {
  attemptLog: { at: string; status: number | null; error?: string; durationMs: number; replay?: boolean }[];
  payload: unknown;
}

function SecretOnce({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 border-b border-white/6 bg-white/2 p-5">
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-lg bg-black/30 px-3 py-2 font-mono text-[13px]">{secret}</code>
        <Button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(secret);
            setCopied(true);
          }}
          className="h-9 gap-1.5 rounded-lg px-3 text-xs font-semibold"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-[11.5px] font-medium" style={{ color: "#F2B33D" }}>
        Signing secret, shown once. Verify the webhook-signature header with it.
      </p>
      <Button type="button" variant="ghost" onClick={onDone} className="h-8 rounded-lg text-[13px] text-[#9BA1AD]">
        Done
      </Button>
    </div>
  );
}

function EventPicker({ value, onChange }: { value: EventType[]; onChange: (v: EventType[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {EVENTS.map((e) => {
        const on = value.includes(e);
        return (
          <button
            key={e}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== e) : [...value, e])}
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[11.5px] ${
              on ? "border-ox/50 bg-ox/6 text-foreground" : "border-white/8 text-[#9BA1AD] hover:border-white/18"
            }`}
          >
            {e}
          </button>
        );
      })}
    </div>
  );
}

function DeliveryLine({ apiKey, hookId, d }: { apiKey: string; hookId: string; d: Delivery }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const full = useQuery({
    queryKey: ["dev-delivery", apiKey, d.id],
    queryFn: () => devRequest<DeliveryFull>(apiKey, `/webhooks/${hookId}/deliveries/${d.id}`),
    enabled: open,
  });
  const replay = useMutation({
    mutationFn: () => devRequest(apiKey, `/webhooks/${hookId}/deliveries/${d.id}/replay`, { body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-deliveries", apiKey, hookId] });
      qc.invalidateQueries({ queryKey: ["dev-delivery", apiKey, d.id] });
    },
  });

  return (
    <div className="border-t border-white/6">
      <div className="flex flex-wrap items-center gap-3 px-5 py-2 pl-10 text-[12px]">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <StatusPill status={d.status} />
          <span className="font-mono">{d.eventType}</span>
          <span className="text-[#7C838F]">
            {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
            {d.lastStatusCode != null && ` · HTTP ${d.lastStatusCode}`}
            {d.nextAttemptAt && d.status === "pending" && ` · next ${when(d.nextAttemptAt)}`}
          </span>
        </button>
        <span className="text-[#7C838F]">{when(d.createdAt)}</span>
        {d.status !== "pending" && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => replay.mutate()}
            disabled={replay.isPending}
            className="h-7 rounded-lg px-2 text-[11.5px] text-[#9BA1AD]"
          >
            Replay
          </Button>
        )}
      </div>
      {replay.error && <p className="px-10 pb-2 text-sm text-ox-danger">{errorText(replay.error, "Could not replay")}</p>}
      {open && full.data && (
        <div className="space-y-2 bg-white/2 px-10 py-3">
          <ol className="space-y-0.5 text-[11.5px] text-[#9BA1AD]">
            {full.data.attemptLog.map((a, i) => (
              <li key={i}>
                {when(a.at)} · {a.status != null ? `HTTP ${a.status}` : (a.error ?? "no response")} · {a.durationMs} ms
                {a.replay && " · replay"}
              </li>
            ))}
          </ol>
          <pre className="max-h-[240px] overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11.5px] text-[#C9CFD8]">
            {JSON.stringify(full.data.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function Deliveries({ apiKey, hookId }: { apiKey: string; hookId: string }) {
  const list = useQuery({
    queryKey: ["dev-deliveries", apiKey, hookId],
    queryFn: () => devRequest<{ data: Delivery[]; nextCursor: string | null }>(apiKey, `/webhooks/${hookId}/deliveries?limit=50`),
  });
  if (list.isLoading) return <Skeleton className="mx-5 my-3 h-10" />;
  if (list.error) return <p className="px-10 py-3 text-sm text-ox-danger">{errorText(list.error, "Could not load deliveries")}</p>;
  if (!list.data!.data.length) return <p className="border-t border-white/6 px-10 py-3 text-[12px] text-[#7C838F]">No deliveries yet.</p>;
  return (
    <>
      {list.data!.data.map((d) => (
        <DeliveryLine key={d.id} apiKey={apiKey} hookId={hookId} d={d} />
      ))}
    </>
  );
}

function WebhookRow({ apiKey, hook, onSecret }: { apiKey: string; hook: Webhook; onSecret: (s: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [events, setEvents] = useState<EventType[]>(hook.events);
  const refresh = () => qc.invalidateQueries({ queryKey: ["dev-webhooks", apiKey] });
  const patch = useMutation({
    mutationFn: (body: { events?: EventType[]; enabled?: boolean }) =>
      devRequest(apiKey, `/webhooks/${hook.id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: () => devRequest<{ secret: string }>(apiKey, `/webhooks/${hook.id}/rotate`, { body: {} }),
    onSuccess: (r) => {
      onSecret(r.secret);
      refresh();
    },
  });
  const test = useMutation({
    mutationFn: () => devRequest(apiKey, `/webhooks/${hook.id}/test`, { body: {} }),
    onSuccess: () => {
      setOpen(true);
      qc.invalidateQueries({ queryKey: ["dev-deliveries", apiKey, hook.id] });
    },
  });
  const remove = useMutation({
    mutationFn: () => devRequest(apiKey, `/webhooks/${hook.id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const disabled = hook.status !== "active";
  const failure = patch.error ?? rotate.error ?? test.error ?? remove.error;

  return (
    <div className="border-t border-white/6 first:border-t-0">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <StatusPill status={hook.status} />
            <span className="truncate font-mono text-[13px] font-semibold">{hook.url}</span>
          </div>
          <div className="mt-0.5 text-[11.5px] text-[#7C838F]">
            {hook.events.length ? hook.events.join(" · ") : "all events"}
            {hook.consecutiveFailures > 0 && ` · ${hook.consecutiveFailures} failures in a row`}
            {hook.disabledAt && ` · disabled ${when(hook.disabledAt)}`}
            {hook.previousSecretExpiresAt && ` · old secret valid until ${when(hook.previousSecretExpiresAt)}`}
          </div>
        </button>
        <div className="flex flex-wrap gap-1">
          <Button type="button" variant="ghost" onClick={() => test.mutate()} disabled={test.isPending || disabled} className="h-8 gap-1.5 rounded-lg text-xs text-[#9BA1AD]">
            <Send className="size-3.5" /> Test
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(!editing)} className="h-8 rounded-lg text-xs text-[#9BA1AD]">
            Events
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              window.confirm("Rotate the signing secret? The old one keeps working for 24 hours.") && rotate.mutate()
            }
            disabled={rotate.isPending}
            className="h-8 gap-1.5 rounded-lg text-xs text-[#9BA1AD]"
          >
            <RotateCw className="size-3.5" /> Rotate
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => patch.mutate({ enabled: disabled })}
            disabled={patch.isPending}
            className="h-8 rounded-lg text-xs text-[#9BA1AD]"
          >
            {disabled ? "Enable" : "Disable"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => window.confirm(`Delete the webhook for ${hook.url}?`) && remove.mutate()}
            className="h-8 gap-1.5 rounded-lg text-xs text-ox-danger"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      {editing && (
        <div className="space-y-2 px-5 pb-3">
          <EventPicker value={events} onChange={setEvents} />
          <Button type="button" onClick={() => patch.mutate({ events })} disabled={patch.isPending} className="h-8 rounded-lg text-[12.5px] font-semibold">
            Save events
          </Button>
        </div>
      )}
      {failure && <p className="px-5 pb-3 text-sm text-ox-danger">{errorText(failure, "Request failed")}</p>}
      {open && <Deliveries apiKey={apiKey} hookId={hook.id} />}
    </div>
  );
}

function Webhooks({ apiKey }: { apiKey: string }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<EventType[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["dev-webhooks", apiKey],
    queryFn: () => devRequest<{ data: Webhook[] }>(apiKey, "/webhooks"),
  });
  const create = useMutation({
    mutationFn: () => devRequest<Webhook & { secret: string }>(apiKey, "/webhooks", { body: { url, events } }),
    onSuccess: (r) => {
      setSecret(r.secret);
      setAdding(false);
      setUrl("");
      setEvents([]);
      qc.invalidateQueries({ queryKey: ["dev-webhooks", apiKey] });
    },
  });

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button type="button" onClick={() => setAdding(!adding)} className="h-9 gap-1.5 rounded-[10px] font-heading text-[13px] font-semibold">
          <Plus className="size-4" /> Endpoint
        </Button>
      </div>
      {(secret || adding) && (
        <Panel className="mb-4">
          {secret && <SecretOnce secret={secret} onDone={() => setSecret(null)} />}
          {adding && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
              className="space-y-3 p-5"
            >
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://app.example.com/webhooks/boxox"
                className="h-10 max-w-[480px] rounded-[10px] bg-white/3 font-mono text-[13px]"
              />
              <p className="text-[11.5px] text-[#7C838F]">HTTPS only. Pick events, or none for all of them.</p>
              <EventPicker value={events} onChange={setEvents} />
              {create.error && <p className="text-sm text-ox-danger">{errorText(create.error, "Could not add endpoint")}</p>}
              <Button type="submit" disabled={create.isPending || !url.startsWith("https://")} className="h-9 rounded-[10px] font-heading text-[13px] font-semibold">
                {create.isPending ? "Adding…" : "Add endpoint"}
              </Button>
            </form>
          )}
        </Panel>
      )}
      {list.isLoading && <Skeleton className="h-16" />}
      {list.error && <p className="text-sm text-ox-danger">{errorText(list.error, "Could not load webhooks")}</p>}
      {list.data && !list.data.data.length && (
        <PanelEmpty title="No endpoints" desc="Events are signed in the Standard Webhooks format and retried with backoff for about a day." />
      )}
      {list.data && list.data.data.length > 0 && (
        <Panel>
          {list.data.data.map((h) => (
            <WebhookRow key={h.id} apiKey={apiKey} hook={h} onSecret={setSecret} />
          ))}
        </Panel>
      )}
    </>
  );
}

export function DevWebhooksPage() {
  return (
    <PageContainer>
      <PageHeader title="Webhooks" description="Signed event delivery to your apps, with an attempt log and replay." />
      <DevTabs />
      <DomainKeyGate need="webhooks">{(key) => <Webhooks apiKey={key} />}</DomainKeyGate>
    </PageContainer>
  );
}
