import { useMe } from "@/AppShell";
import type { Capabilities } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { PageContainer, PageHeader, Panel } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Group = "localFilters" | "reputationLookups" | "ai";
type Provider = "openai" | "anthropic" | "cloudflare";

interface Processing {
  localFilters: boolean | null;
  reputationLookups: boolean | null;
  ai: boolean | null;
  provider: Provider | null;
}

interface SetupState {
  capabilities?: Capabilities;
  completed: boolean;
  tokenConfigured: boolean;
  processing: Processing;
  missingChoices: Group[];
  domains: { id: string; name: string; status: string; sendingEnabled: boolean; receivingEnabled: boolean }[];
}

interface TokenCheck {
  configured: boolean;
  valid?: boolean;
  message?: string;
  error?: { message: string };
  checks?: { name: string; needs: string; ok: boolean }[];
  sending?: { quotaPerDay: number; sentToday: number; sandbox: boolean } | null;
  advice?: string;
}

interface DnsRow {
  name: string;
  type: string;
  content: string;
  priority: number | null;
}

interface Preview {
  mx: DnsRow[];
  dmarc: DnsRow[];
  foreignSpf: DnsRow | null;
  mxWarning: string | null;
  dmarcWarning: string | null;
  needsConfirmation: boolean;
}

interface Consent {
  title: string;
  groups: { id: Group; title: string; summary: string; includes: string[] }[];
  providers: {
    id: Provider;
    company: string;
    label: string;
    dataNote: string;
    termsUrl: string;
    models: { task: string; use: string; model: string }[];
    estimatedMonthlyUsd: number;
    needsCredits: boolean;
  }[];
  estimateBasis: string;
}

class SetupError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function setupApi<T>(path: string, init?: { method: string; body?: unknown }, apiBase = "/api/setup"): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method: init?.method ?? "GET",
    headers: init ? { "content-type": "application/json", "x-boxox-csrf": "1" } : {},
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { code: string; message: string };
  };
  if (!res.ok) throw new SetupError(json.error?.message ?? `Request failed (${res.status})`, json.error?.code ?? "unknown", json);
  return json as T;
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <Panel className="mb-4">
      <div className="flex items-center gap-3 border-b border-white/4 px-5 py-4">
        <span
          className={`flex size-6 items-center justify-center rounded-full text-xs font-bold ${
            done ? "bg-ox-success text-ox-navy" : "bg-white/8 text-[#C4CAD4]"
          }`}
        >
          {done ? <Check className="size-3.5" /> : n}
        </span>
        <div className="font-heading text-[15px] font-bold">{title}</div>
      </div>
      <div className="px-5 py-4 text-[13px]">{children}</div>
    </Panel>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="my-2 flex gap-2 rounded-[10px] border border-ox/30 bg-ox/8 px-3 py-2.5 text-[12.5px] text-[#E8C9B5]">
      <AlertTriangle className="mt-px size-4 flex-none text-ox" />
      <div>{children}</div>
    </div>
  );
}

function Records({ title, rows, empty }: { title: string; rows: DnsRow[]; empty: string }) {
  return (
    <div className="mb-2">
      <div className="mb-1 text-xs font-semibold text-[#9BA1AD]">{title}</div>
      {rows.length ? (
        <ul className="space-y-0.5 font-mono text-[12px] text-[#C4CAD4]">
          {rows.map((r) => (
            <li key={`${r.type}${r.content}`}>
              {r.type} {r.name} {r.priority !== null ? `${r.priority} ` : ""}
              {r.content}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-xs text-[#7c838f]">{empty}</div>
      )}
    </div>
  );
}

function TokenStep() {
  const token = useQuery({ queryKey: ["setup", "token"], queryFn: () => setupApi<TokenCheck>("/token") });
  const t = token.data;
  return (
    <Step n={1} title="Cloudflare API token" done={!!t?.valid && !!t.checks?.every((c) => c.ok)}>
      {token.isLoading && <div className="text-[#7c838f]">Checking the token…</div>}
      {t && !t.configured && <Warning>{t.message}</Warning>}
      {t?.configured && t.valid === false && <Warning>{t.error?.message ?? "The token is not valid."}</Warning>}
      {t?.checks && (
        <ul className="mb-3 space-y-1">
          {t.checks.map((c) => (
            <li key={c.name} className="flex items-center gap-2">
              {c.ok ? <Check className="size-4 text-ox-success" /> : <X className="size-4 text-ox" />}
              {c.needs}
            </li>
          ))}
        </ul>
      )}
      {t?.sending && (
        <div className="text-[#9BA1AD]">
          Sending quota: {t.sending.quotaPerDay.toLocaleString()} a day ({t.sending.sentToday} sent today).
          {t.sending.sandbox && " New accounts start in Cloudflare's low-volume sandbox."}
        </div>
      )}
    </Step>
  );
}

export function ZoneRow({ name, onboarded, apiBase = "/api/setup", onboardPath = "/domains", onComplete }: {
  name: string;
  onboarded?: SetupState["domains"][number];
  apiBase?: string;
  onboardPath?: string;
  onComplete?: () => void;
}) {
  const qc = useQueryClient();
  const me = useMe();
  const receivingOnly = me.data?.capabilities?.sending === false;
  const [receive, setReceive] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const preview = useQuery({
    queryKey: ["domain-preview", apiBase, name],
    queryFn: () => setupApi<Preview>(`/zones/${encodeURIComponent(name)}/preview`, undefined, apiBase),
    enabled: false,
  });
  const onboard = useMutation({
    mutationFn: () =>
      setupApi<{ warnings: string[] }>(onboardPath, {
        method: "POST",
        body: { domain: name, receive: receivingOnly || receive, confirmMxReplacement: (receivingOnly || receive) && confirmed },
      }, apiBase),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["setup", "state"] });
      onComplete?.();
    },
  });
  const p = preview.data;

  return (
    <div className="border-b border-white/4 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="flex-1 font-medium">{name}</div>
        {onboarded ? (
          <Badge className="rounded-full text-[11px]">
            {onboarded.sendingEnabled ? (onboarded.receivingEnabled ? "Sending + receiving" : "Sending only") : "Receiving only"}
          </Badge>
        ) : (
          <Button variant="outline" size="sm" onClick={() => preview.refetch()} disabled={preview.isFetching}>
            {p ? "Refresh records" : "Check records"}
          </Button>
        )}
      </div>
      {preview.error && <Warning>{(preview.error as Error).message}</Warning>}
      {p && !onboarded && (
        <div className="mt-3 rounded-[10px] bg-white/2 p-3">
          <Records title="Current MX records" rows={p.mx} empty="No MX records: nothing receives mail for this domain yet." />
          <Records title="Current DMARC record" rows={p.dmarc} empty="No DMARC record." />
          {p.dmarcWarning && <Warning>{p.dmarcWarning}</Warning>}
          {receivingOnly ? <p className="mt-3 text-xs text-[#9BA1AD]">Free profile: receiving only. Outbound mail is not installed.</p> : <>
          <div className="mt-3 flex flex-col gap-2">
            <label className="flex items-center gap-2">
              <input type="radio" checked={!receive} onChange={() => { setReceive(false); setConfirmed(false); }} /> Send only (MX records stay as they are)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={receive} onChange={() => { setReceive(true); setConfirmed(false); }} /> Send and receive
            </label>
          </div>
          </>}
          {(receivingOnly || receive) && p.needsConfirmation && (
            <>
              <Warning>
                {p.mxWarning ?? `Turning on receiving changes the SPF record of ${name}.`}
                {p.foreignSpf && ` The SPF record ${p.foreignSpf.content} will also be changed to include Cloudflare.`}
              </Warning>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                I understand: all mail for {name} will move to Box Ox.
              </label>
            </>
          )}
          <Button
            className="mt-3"
            size="sm"
            disabled={onboard.isPending || ((receivingOnly || receive) && p.needsConfirmation && !confirmed)}
            onClick={() => onboard.mutate()}
          >
            {onboard.isPending ? "Setting up…" : "Set up " + name}
          </Button>
          {onboard.error && <Warning>{(onboard.error as Error).message}</Warning>}
          {onboard.data?.warnings.map((w) => <Warning key={w}>{w}</Warning>)}
        </div>
      )}
    </div>
  );
}

function DomainsStep({ state }: { state: SetupState }) {
  const zones = useQuery({
    queryKey: ["setup", "zones"],
    queryFn: () => setupApi<{ zones: { id: string; name: string }[] }>("/zones"),
    enabled: state.tokenConfigured,
  });
  return (
    <Step n={2} title="Domains" done={state.domains.length > 0}>
      <div className="mb-2 text-[#9BA1AD]">
        {state.capabilities?.sending === false ? "Choose a domain for incoming mail." : "Pick the domains Box Ox sends from, and the ones it receives for."} You see each domain's current mail records
        before anything changes.
      </div>
      {!state.tokenConfigured && <Warning>Configure the API token first.</Warning>}
      {zones.error && <Warning>{(zones.error as Error).message}</Warning>}
      {zones.data?.zones.map((z) => (
        <ZoneRow key={z.id} name={z.name} onboarded={state.domains.find((d) => d.name === z.name)} />
      ))}
    </Step>
  );
}

function Choice({ value, onChange, label }: { value: boolean | null; onChange: (v: boolean) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-[11px] bg-white/5 p-[3px]">
      {[true, false].map((v) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`rounded-lg px-4 py-[6px] text-[13px] font-semibold ${
            value === v ? "bg-white/12 text-foreground" : "text-[#9BA1AD]"
          }`}
        >
          {v ? "On" : "Off"}
        </button>
      ))}
    </div>
  );
}

function ProcessingStep({ state }: { state: SetupState }) {
  const qc = useQueryClient();
  const consent = useQuery({ queryKey: ["setup", "consent"], queryFn: () => setupApi<Consent>("/consent") });
  // Starts from what's saved, which is null (undecided) until the owner chooses.
  const [choice, setChoice] = useState<Processing>(state.capabilities?.ai === false ? { ...state.processing, ai: false, provider: null } : state.processing);
  const save = useMutation({
    mutationFn: () => setupApi("/processing", { method: "PUT", body: choice }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["setup", "state"] }),
  });
  const c = consent.data;
  const decided =
    choice.localFilters !== null && choice.reputationLookups !== null && choice.ai !== null && (!choice.ai || !!choice.provider);

  return (
    <Step n={3} title={c?.title ?? "How your mail is processed"} done={state.missingChoices.length === 0}>
      <div className="mb-3 text-[#9BA1AD]">Switch each group on or off. Nothing is on until you choose it.</div>
      {c?.groups.filter(g => g.id !== "ai" || state.capabilities?.ai !== false).map((g) => (
        <div key={g.id} className="mb-4 rounded-[10px] border border-white/7 p-4">
          <div className="mb-1 flex items-center gap-3">
            <div className="flex-1 text-[14px] font-semibold">{g.title}</div>
            <Choice label={g.title} value={choice[g.id]} onChange={(v) => setChoice({ ...choice, [g.id]: v })} />
          </div>
          <div className={g.id === "ai" ? "font-medium text-[#E8C9B5]" : "text-[#9BA1AD]"}>{g.summary}</div>
          <ul className="mt-2 list-disc pl-5 text-xs text-[#7c838f]">
            {g.includes.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
          {g.id === "ai" && choice.ai && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="text-xs font-semibold text-[#9BA1AD]">Which company reads your email</div>
              {c.providers.map((p) => (
                <label
                  key={p.id}
                  className={`block cursor-pointer rounded-[10px] border p-3 ${
                    choice.provider === p.id ? "border-ox/60 bg-ox/6" : "border-white/7"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="provider"
                      checked={choice.provider === p.id}
                      onChange={() => setChoice({ ...choice, provider: p.id })}
                    />
                    <span className="font-semibold">{p.label}</span>
                    <span className="ml-auto text-xs text-[#9BA1AD]">≈ ${p.estimatedMonthlyUsd.toFixed(2)}/month</span>
                  </div>
                  <div className="mt-1 text-xs text-[#9BA1AD]">{p.dataNote}</div>
                  <ul className="mt-1 text-xs text-[#7c838f]">
                    {p.models.map((m) => (
                      <li key={m.task}>
                        {m.use}: <span className="font-mono">{m.model}</span>
                      </li>
                    ))}
                  </ul>
                  <a className="mt-1 inline-block text-xs text-ox underline" href={p.termsUrl} target="_blank" rel="noreferrer">
                    {p.company} data and retention terms
                  </a>
                  {p.needsCredits && (
                    <div className="mt-1 text-xs text-[#7c838f]">Needs AI Gateway credits in your Cloudflare account.</div>
                  )}
                </label>
              ))}
              <div className="text-xs text-[#7c838f]">Cost estimate: {c.estimateBasis}.</div>
            </div>
          )}
        </div>
      ))}
      {state.capabilities?.ai === false && <p className="mb-3 text-xs text-[#9BA1AD]">AI is not installed in the Free profile.</p>}
      <Button size="sm" disabled={!decided || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : "Save choices"}
      </Button>
      {save.error && <Warning>{(save.error as Error).message}</Warning>}
      {save.isSuccess && <span className="ml-3 text-xs text-ox-success">Saved.</span>}
    </Step>
  );
}

function TestSendStep({ state }: { state: SetupState }) {
  const sendable = state.domains.filter((d) => d.sendingEnabled);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const send = useMutation({
    mutationFn: () => setupApi<{ messageId: string; note: string }>("/test-send", { method: "POST", body: { from, to } }),
  });
  if (state.capabilities?.sending === false) return <Step n={4} title="Test incoming mail">
    <ol className="list-decimal space-y-2 pl-5 text-[#9BA1AD]"><li>Finish setup and create a mailbox in Domains.</li><li>Send a message to it from an outside mailbox you control.</li><li>Open Inbox and confirm the message arrived.</li></ol>
  </Step>;
  return (
    <Step n={4} title="Send a test email" done={send.isSuccess}>
      {!sendable.length ? (
        <div className="text-[#7c838f]">Set up a domain for sending first.</div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs text-[#9BA1AD]">From</Label>
              <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder={`you@${sendable[0]!.name}`} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-[#9BA1AD]">To (an outside address)</Label>
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@gmail.com" />
            </div>
          </div>
          <div>
            <Button size="sm" disabled={!from || !to || send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? "Sending…" : "Send test email"}
            </Button>
          </div>
          {send.error && <Warning>{(send.error as Error).message}</Warning>}
          {send.data && (
            <div className="text-[#9BA1AD]">
              Sent as <span className="font-mono">{send.data.messageId}</span>. {send.data.note} Reply to it to check
              receiving.
            </div>
          )}
        </div>
      )}
    </Step>
  );
}

export function SetupPage() {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["setup", "state"], queryFn: () => setupApi<SetupState>("") });
  const finish = useMutation({
    mutationFn: () => setupApi<{ advice: string }>("/complete", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["setup", "state"] }),
  });
  const s = state.data;

  return (
    <PageContainer width={820}>
      <PageHeader title="Set up Box Ox" description="Connect your Cloudflare account, your domains and how your mail is processed." />
      {s?.capabilities?.edition === "free" && <Panel className="mb-4 px-5 py-4 text-[13px]">Workers Free · Inbox, search, mail-reading agents, and inbound webhooks. Outbound sending, AI, and Browser Run are not installed.</Panel>}
      {state.error && <Warning>{(state.error as Error).message}</Warning>}
      {s?.completed ? (
        <Panel className="px-5 py-4 text-[13px]">
          Setup is finished. {finish.data?.advice ?? "You can remove the Cloudflare API token now (wrangler secret delete CF_API_TOKEN); add it again to onboard more domains."}
          <div className="mt-3">
            <a className="text-ox underline" href="/">
              Go to your inbox
            </a>
          </div>
        </Panel>
      ) : (
        s && (
          <>
            <TokenStep />
            <DomainsStep state={s} />
            <ProcessingStep state={s} />
            <TestSendStep state={s} />
            <div className="flex items-center gap-3">
              <Button disabled={s.missingChoices.length > 0 || finish.isPending} onClick={() => finish.mutate()}>
                Finish setup
              </Button>
              {s.missingChoices.length > 0 && (
                <span className="text-xs text-[#7c838f]">Choose on or off for each processing group to finish.</span>
              )}
              {finish.error && <Warning>{(finish.error as Error).message}</Warning>}
            </div>
          </>
        )
      )}
    </PageContainer>
  );
}
