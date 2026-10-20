import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Copy, Globe, Plus, RefreshCw, UserPlus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useActiveOrgId, useMe } from "@/AppShell";
import { AddDomainDialog } from "@/components/domains/AddDomainDialog";
import { PageContainer, PageHeader, Panel, PanelEmpty } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { AddressKind, GrantPermission } from "@boxox/shared";
import {
  api,
  ApiRequestError,
  type AddressRow,
  type AgentRow,
  type DomainHealth,
  type DomainHealthCheck,
  type DomainRow,
} from "@/lib/api";

import { ZoneRow } from "./Setup";

const KIND_META: Record<AddressKind, { label: string; dot: string; desc: string }> = {
  personal: { label: "Personal", dot: "#35C07A", desc: "One person's mailbox — owner@, mike@" },
  role: { label: "Role", dot: "#3DA5F4", desc: "Shared purpose — hello@, support@" },
  agent: { label: "Agent", dot: "#F26B2C", desc: "An AI agent sends and receives here" },
  disposable: { label: "Disposable", dot: "#A78BFA", desc: "One-and-done, generated local part" },
};

const STARTERS = ["hello", "support", "billing", "alerts", "security"] as const;

function StatusPill({ status }: { status: string }) {
  const verified = ["verified", "ready", "sending-only"].includes(status);
  const color = verified ? "#35C07A" : "#F2B33D";
  return (
    <span
      className="inline-flex flex-none items-center gap-1.5 rounded-full px-[11px] py-1 text-[11.5px] font-semibold"
      style={{ color, background: verified ? "rgba(53,192,122,0.12)" : "rgba(242,179,61,0.12)" }}
    >
      <span className="size-[7px] rounded-full" style={{ background: color }} />
      {status}
    </span>
  );
}

function AddAddressForm({
  domain,
  onDone,
}: {
  domain: DomainRow;
  onDone: () => void;
}) {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const [kind, setKind] = useState<AddressKind>("role");
  const [localPart, setLocalPart] = useState("");
  const [grantEmail, setGrantEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.domains.createAddress(orgId, domain.id, {
        kind,
        localPart: kind === "disposable" || !localPart ? undefined : localPart,
        generate: kind === "disposable" || !localPart,
        grantEmail: grantEmail || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domain-addresses", orgId, domain.id] });
      qc.invalidateQueries({ queryKey: ["addresses", orgId] });
      qc.invalidateQueries({ queryKey: ["domains", orgId] });
      onDone();
    },
    onError: (err) =>
      setError(err instanceof ApiRequestError ? err.message : "Could not create address"),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 border-t border-white/6 bg-white/2 p-5">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(KIND_META) as AddressKind[]).map((k) => (
          <button
            type="button"
            key={k}
            onClick={() => setKind(k)}
            className={`rounded-[10px] border p-3 text-left ${
              kind === k ? "border-ox/50 bg-ox/6" : "border-white/8 hover:border-white/16"
            }`}
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="size-[7px] rounded-full" style={{ background: KIND_META[k].dot }} />
              <span className="text-[13px] font-semibold">{KIND_META[k].label}</span>
            </div>
            <div className="text-[11.5px] leading-snug text-[#7C838F]">{KIND_META[k].desc}</div>
          </button>
        ))}
      </div>

      {kind !== "disposable" && (
        <div className="space-y-[7px]">
          <Label className="text-xs font-medium text-[#9BA1AD]">Address</Label>
          <div className="flex items-center gap-2">
            <Input
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value.toLowerCase())}
              placeholder={kind === "agent" ? "qa-agent" : "hello"}
              className="h-10 max-w-[220px] rounded-[10px] bg-white/3 font-mono text-[13px]"
            />
            <span className="text-[13px] text-[#7C838F]">@{domain.name}</span>
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setLocalPart(s)}
                className="rounded-full border border-white/8 px-2.5 py-0.5 text-[11.5px] text-[#9BA1AD] hover:border-white/18 hover:text-foreground"
              >
                {s}@
              </button>
            ))}
          </div>
        </div>
      )}
      {kind === "disposable" && (
        <p className="text-[12.5px] text-[#7C838F]">
          A random local part like <span className="font-mono">x7k2q9@{domain.name}</span> is
          generated for you.
        </p>
      )}

      {(kind === "personal" || kind === "role") && (
        <div className="space-y-[7px]">
          <Label className="text-xs font-medium text-[#9BA1AD]">
            Attach a person by email (optional)
          </Label>
          <Input
            type="email"
            value={grantEmail}
            onChange={(e) => setGrantEmail(e.target.value)}
            placeholder="user@example.com"
            className="h-10 max-w-[320px] rounded-[10px] bg-white/3 text-[13px]"
          />
        </div>
      )}

      {error && <p className="text-sm text-ox-danger">{error}</p>}
      <div className="flex gap-2.5">
        <Button
          type="submit"
          disabled={create.isPending}
          className="h-9 rounded-[10px] font-heading text-[13px] font-semibold"
        >
          {create.isPending ? "Creating…" : "Create address"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onDone}
          className="h-9 rounded-[10px] text-[13px] text-[#9BA1AD]"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AgentPanel({ address }: { address: AddressRow }) {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const agentsQ = useQuery({
    queryKey: ["agents", orgId],
    queryFn: () => api.agents.list(orgId),
    enabled: !!orgId,
  });
  const onThisAddress = (agentsQ.data?.agents ?? []).filter((a) =>
    a.grants.some((g) => g.addressId === address.id),
  );

  const [name, setName] = useState(address.localPart);
  const [allowSend, setAllowSend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ agentName: string; code: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["agents", orgId] });

  const create = useMutation({
    mutationFn: async () => {
      const permissions: GrantPermission[] = allowSend ? ["read", "send"] : ["read"];
      const res = await api.agents.create(orgId, { name, addressId: address.id, permissions });
      const code = await api.agents.pairingCode(orgId, res.agent.id);
      return { agentName: res.agent.name, code: code.code };
    },
    onSuccess: (r) => {
      setReveal(r);
      refresh();
    },
    onError: (err) =>
      setError(err instanceof ApiRequestError ? err.message : "Could not create agent"),
  });
  const newCode = useMutation({
    mutationFn: async (agent: AgentRow) => {
      const code = await api.agents.pairingCode(orgId, agent.id);
      return { agentName: agent.name, code: code.code };
    },
    onSuccess: (r) => setReveal(r),
  });
  const toggleStatus = useMutation({
    mutationFn: (agent: AgentRow) =>
      api.agents.patch(orgId, agent.id, {
        status: agent.status === "active" ? "disabled" : "active",
      }),
    onSuccess: refresh,
  });

  function copy(code: string) {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="mt-2.5 space-y-4 rounded-[10px] border border-white/8 bg-white/[0.02] p-4">
      {reveal ? (
        <div className="space-y-2.5">
          <div className="text-[13px] font-semibold">Pairing code for {reveal.agentName}</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg bg-black/30 px-3 py-2 font-mono text-[13px]">
              {reveal.code}
            </code>
            <Button
              type="button"
              onClick={() => copy(reveal.code)}
              className="h-9 flex-none gap-1.5 rounded-lg px-3 text-xs font-semibold"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-[11.5px] font-medium" style={{ color: "#F2B33D" }}>
            Shown once — it expires in 15 minutes.
          </p>
          <div className="space-y-1 rounded-lg bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-[#9BA1AD]">
            <div>1. POST /api/agent/pair {"{ code }"} → clientId + clientSecret</div>
            <div>2. POST /api/agent/token {"{ client_id, client_secret }"} → bearer token</div>
            <div>3. Call /api/agent/v1/* or /mcp with Authorization: Bearer …</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setReveal(null)}
            className="h-8 rounded-lg text-[13px] text-[#9BA1AD]"
          >
            Done
          </Button>
        </div>
      ) : (
        <>
          {onThisAddress.length > 0 && (
            <div className="space-y-2">
              {onThisAddress.map((a) => {
                const grant = a.grants.find((g) => g.addressId === address.id);
                const canSend = grant?.permissions.includes("send") || grant?.permissions.includes("send_new");
                return (
                  <div key={a.id} className="flex flex-wrap items-center gap-2.5 text-[12.5px]">
                    <span
                      className="size-[7px] flex-none rounded-full"
                      style={{ background: a.status === "active" ? "#35C07A" : "#7C838F" }}
                    />
                    <span className={`font-medium ${a.status === "active" ? "" : "opacity-60"}`}>
                      {a.name}
                    </span>
                    <Badge className="rounded-md bg-white/5 text-[10px] font-medium text-[#9BA1AD]">
                      {canSend ? "read + send" : "read-only"}
                    </Badge>
                    {!a.paired && <span className="text-[10.5px] text-[#7c838f]">not paired</span>}
                    <span className="flex-1" />
                    <button
                      type="button"
                      onClick={() => newCode.mutate(a)}
                      className="text-[#9BA1AD] hover:text-foreground"
                    >
                      New code
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleStatus.mutate(a)}
                      className="text-[#9BA1AD] hover:text-foreground"
                    >
                      {a.status === "active" ? "Disable" : "Enable"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              create.mutate();
            }}
            className={`space-y-3 ${onThisAddress.length > 0 ? "border-t border-white/6 pt-3" : ""}`}
          >
            <div className="text-[12px] font-semibold text-[#9BA1AD]">Pair a new agent</div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="qa-agent"
              className="h-9 max-w-[240px] rounded-lg bg-white/3 text-[13px]"
            />
            <label className="flex items-start gap-2.5 text-[12px] leading-snug">
              <input
                type="checkbox"
                checked={allowSend}
                onChange={(e) => setAllowSend(e.target.checked)}
                className="mt-0.5 flex-none"
              />
              <span>
                Allow sending
                <span className="text-[#7C838F]">
                  {" "}
                  — reply-only: the agent may reply to people who have already written to this
                  address, not cold-email new recipients.
                </span>
              </span>
            </label>
            {error && <p className="text-xs text-ox-danger">{error}</p>}
            <Button
              type="submit"
              disabled={create.isPending || !name}
              className="h-9 rounded-lg text-[13px] font-semibold"
            >
              {create.isPending ? "Creating…" : "Create & show code"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

function AddressLine({
  a,
  domain,
  isCatchAll,
}: {
  a: AddressRow;
  domain: DomainRow;
  isCatchAll: boolean;
}) {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const [grantOpen, setGrantOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [grantEmail, setGrantEmail] = useState("");
  const meta = KIND_META[a.kind];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["domain-addresses", orgId, domain.id] });
    qc.invalidateQueries({ queryKey: ["addresses", orgId] });
    qc.invalidateQueries({ queryKey: ["domains", orgId] });
  };

  const patch = useMutation({
    mutationFn: (body: Parameters<typeof api.addresses.patch>[2]) =>
      api.addresses.patch(orgId, a.id, body),
    onSuccess: refresh,
  });
  const setCatchAll = useMutation({
    mutationFn: (on: boolean) =>
      api.domains.patch(orgId, domain.id, {
        unknownMailPolicy: on ? "catch_all" : "hold",
        catchAllAddressId: on ? a.id : null,
      }),
    onSuccess: refresh,
  });
  const addGrant = useMutation({
    mutationFn: () =>
      api.addresses.addGrant(orgId, a.id, { email: grantEmail, permissions: ["read", "send"] }),
    onSuccess: () => {
      setGrantEmail("");
      setGrantOpen(false);
      refresh();
    },
  });
  const removeGrant = useMutation({
    mutationFn: (grantId: string) => api.addresses.removeGrant(orgId, a.id, grantId),
    onSuccess: refresh,
  });

  return (
    <div className="border-t border-white/[0.045] px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="size-[7px] flex-none rounded-full" style={{ background: meta.dot }} />
        <span className={`font-mono text-[13px] ${a.status === "active" ? "" : "line-through opacity-50"}`}>
          {a.localPart}@{domain.name}
        </span>
        <Badge className="rounded-md bg-white/5 text-[10.5px] font-medium text-[#9BA1AD]">
          {meta.label}
        </Badge>
        {isCatchAll && (
          <Badge className="rounded-md text-[10.5px] font-semibold" style={{ color: "#F26B2C", background: "rgba(242,107,44,0.12)" }}>
            catch-all
          </Badge>
        )}
        {a.status !== "active" && (
          <Badge className="rounded-md bg-white/5 text-[10.5px] text-[#9BA1AD]">{a.status}</Badge>
        )}
        {a.unread > 0 && <span className="text-[11.5px] text-[#7C838F]">{a.unread} unread</span>}
        <span className="flex-1" />
        {a.kind === "agent" && (
          <button
            title="Pair agent"
            onClick={() => setPairOpen((v) => !v)}
            className={`flex size-[30px] items-center justify-center rounded-lg hover:bg-white/5 ${
              pairOpen ? "text-ox" : "text-[#7c838f] hover:text-[#9BA1AD]"
            }`}
          >
            <Bot className="size-4" strokeWidth={1.7} />
          </button>
        )}
        <button
          title="Attach person"
          onClick={() => setGrantOpen((v) => !v)}
          className="flex size-[30px] items-center justify-center rounded-lg text-[#7c838f] hover:bg-white/5 hover:text-[#9BA1AD]"
        >
          <UserPlus className="size-4" strokeWidth={1.7} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Actions for ${a.localPart}@${domain.name}`}
            className="flex size-[30px] items-center justify-center rounded-lg text-[#7c838f] hover:bg-white/5 hover:text-[#9BA1AD]"
          >
            ⋯
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 rounded-xl bg-surface-4">
            <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-[#7c838f]">
              Change kind
            </DropdownMenuLabel>
            {(Object.keys(KIND_META) as AddressKind[])
              .filter((k) => k !== a.kind)
              .map((k) => (
                <DropdownMenuItem key={k} onClick={() => patch.mutate({ kind: k })}>
                  <span className="size-[7px] rounded-full" style={{ background: KIND_META[k].dot }} />
                  Make {KIND_META[k].label.toLowerCase()}
                </DropdownMenuItem>
              ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setCatchAll.mutate(!isCatchAll)}>
              {isCatchAll ? "Stop catching all" : "Make catch-all for domain"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {a.status === "active" ? (
              <DropdownMenuItem onClick={() => patch.mutate({ status: "paused" })}>
                Pause receiving
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => patch.mutate({ status: "active" })}>
                Resume receiving
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              onClick={() => patch.mutate({ status: "archived" })}
            >
              Archive address
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {a.grants.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-[19px]">
          {a.grants.map((g) => (
            <span
              key={g.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/8 px-2.5 py-0.5 text-[11.5px] text-[#9BA1AD]"
            >
              {g.principalType === "agent" ? "🤖" : ""}
              {g.inviteEmail ?? g.principalId}
              {!g.principalId && g.principalType === "user" && (
                <span className="text-[10px] text-[#7c838f]">(invited)</span>
              )}
              <button
                onClick={() => removeGrant.mutate(g.id)}
                className="text-[#7c838f] hover:text-ox-danger"
              >
                <X className="size-3" strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}

      {grantOpen && (
        <form
          className="mt-2.5 flex items-center gap-2 pl-[19px]"
          onSubmit={(e) => {
            e.preventDefault();
            addGrant.mutate();
          }}
        >
          <Input
            type="email"
            required
            value={grantEmail}
            onChange={(e) => setGrantEmail(e.target.value)}
            placeholder="person@email.com"
            className="h-8 max-w-[260px] rounded-lg bg-white/3 text-xs"
          />
          <Button type="submit" disabled={addGrant.isPending} className="h-8 rounded-lg px-3 text-xs font-semibold">
            Attach
          </Button>
          {addGrant.isError && (
            <span className="text-xs text-ox-danger">
              {addGrant.error instanceof ApiRequestError ? addGrant.error.message : "Failed"}
            </span>
          )}
        </form>
      )}

      {pairOpen && a.kind === "agent" && (
        <div className="pl-[19px]">
          <AgentPanel address={a} />
        </div>
      )}
    </div>
  );
}

const POLICY_LABEL: Record<string, string> = {
  hold: "Hold unknown mail",
  catch_all: "Catch-all",
  drop: "Drop unknown mail",
};

function PolicyMenu({ domain }: { domain: DomainRow }) {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const patch = useMutation({
    mutationFn: (policy: "hold" | "drop") =>
      api.domains.patch(orgId, domain.id, {
        unknownMailPolicy: policy,
        catchAllAddressId: null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains", orgId] }),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="What happens to mail for addresses that don't exist"
        className="flex-none rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium text-[#9BA1AD] hover:border-white/20 hover:text-foreground"
      >
        {POLICY_LABEL[domain.unknownMailPolicy]}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 rounded-xl bg-surface-4">
        <DropdownMenuItem onClick={() => patch.mutate("hold")}>
          <div>
            <div className="text-[12.5px] font-medium">Hold unknown mail</div>
            <div className="text-[11px] text-[#7c838f]">Waits in Unrouted; claim or dismiss.</div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem disabled className="opacity-70">
          <div>
            <div className="text-[12.5px] font-medium">Catch-all</div>
            <div className="text-[11px] text-[#7c838f]">
              Use ⋯ on an address → "Make catch-all".
            </div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => patch.mutate("drop")}>
          <div>
            <div className="text-[12.5px] font-medium">Drop unknown mail</div>
            <div className="text-[11px] text-[#7c838f]">
              Discard silently (kept in raw storage + event log).
            </div>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActiveToggle({ domain }: { domain: DomainRow }) {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => api.domains.setActive(orgId, domain.id, !domain.active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains", orgId] }),
  });

  return (
    <button
      type="button"
      onClick={() => toggle.mutate()}
      disabled={toggle.isPending}
      title={
        domain.active
          ? "Deactivate — holds incoming mail for this domain"
          : "Activate — delivers incoming mail for this domain"
      }
      className={`flex-none rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        domain.active
          ? "border-white/10 text-[#9BA1AD] hover:border-white/20 hover:text-foreground"
          : "border-ox/40 bg-ox/8 text-ox hover:border-ox/60"
      }`}
    >
      {domain.active ? "Active" : "Inactive"}
    </button>
  );
}

const CHECK_LABEL: Record<DomainHealthCheck["name"], string> = {
  dkim: "DKIM",
  spf: "SPF",
  dmarc: "DMARC",
  mx: "MX",
  bimi: "BIMI",
};

function checkColor(c: DomainHealthCheck) {
  if (c.status === "ok") return "#35C07A";
  return c.required ? "#F26B5B" : "#7C838F";
}

function HealthRow({ domain }: { domain: DomainRow }) {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: () => api.domains.checkHealth(orgId, domain.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains", orgId] }),
  });
  const health: DomainHealth | null = check.data ?? domain.health;
  const problems = health?.checks.filter((c) => c.status !== "ok" && c.required) ?? [];

  return (
    <div className="border-t border-white/[0.045] px-4 py-3 md:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-[#9BA1AD]">DNS health</span>
        {health ? (
          <>
            <span
              className="text-[12px] font-semibold"
              style={{ color: health.healthy ? "#35C07A" : "#F26B5B" }}
            >
              {health.healthy ? "Healthy" : "Unhealthy"}
            </span>
            {health.checks.map((c) => (
              <span
                key={c.name}
                title={c.detail ?? `${c.type} ${c.host}`}
                className="inline-flex items-center gap-1 rounded-full border border-white/8 px-2 py-0.5 text-[11px]"
                style={{ color: checkColor(c) }}
              >
                {c.status === "ok" ? <Check className="size-3" strokeWidth={2.4} /> : <X className="size-3" strokeWidth={2.4} />}
                {CHECK_LABEL[c.name]}
              </span>
            ))}
            <span className="text-[11px] text-[#767d8a]">
              checked {new Date(health.checkedAt).toLocaleString()}
            </span>
          </>
        ) : (
          <span className="text-[12px] text-[#7c838f]">Not checked yet</span>
        )}
        <Button
          variant="ghost"
          onClick={() => check.mutate()}
          disabled={check.isPending}
          className="ml-auto h-7 gap-1.5 rounded-[8px] px-2.5 text-[11.5px] font-medium text-[#9BA1AD]"
        >
          <RefreshCw className={`size-3.5 ${check.isPending ? "animate-spin" : ""}`} strokeWidth={2} />
          Check now
        </Button>
      </div>
      {health?.alerts?.[0] && (
        <p className="mt-2 text-[11.5px] text-[#9BA1AD]" role="status">
          {health.alerts[0].kind === "problem" ? "Domain alert" : "Recovered"}: {health.alerts[0].checks.join(", ")} · {new Date(health.alerts[0].at).toLocaleString()}
        </p>
      )}
      {health?.reputation && <p className="mt-2 text-[11.5px] text-[#9BA1AD]">Reputation: {health.reputation.status}. {health.reputation.lastKnown === "listed" && health.reputation.status !== "listed" ? "Last confirmed result was listed. " : ""}{health.reputation.detail}</p>}
      {health?.checks.find(c => c.name === "bimi") && <details className="mt-2 text-[11.5px] text-[#9BA1AD]"><summary className="cursor-pointer">BIMI guidance</summary><p className="mt-1">{health.checks.find(c => c.name === "bimi")?.detail} <a className="underline" href="https://boxox.dev/docs/deliverability/" target="_blank" rel="noreferrer">Setup guide</a></p></details>}
      {problems.length > 0 && (
        <ul className="mt-2 space-y-1">
          {problems.map((c) => (
            <li key={c.name} className="text-[11.5px] text-[#9BA1AD]">
              <span className="font-mono text-[#7c838f]">
                {c.type} {c.host}
              </span>{" "}
              — {c.detail ?? c.status}
            </li>
          ))}
        </ul>
      )}
      {check.error && (
        <p className="mt-2 text-[11.5px] text-ox-danger">
          {check.error instanceof ApiRequestError ? check.error.message : "Health check failed"}
        </p>
      )}
    </div>
  );
}

function QuotaPanel() {
  const orgId = useActiveOrgId();
  const me = useMe();
  const quota = useQuery({
    queryKey: ["sending-quota", orgId],
    queryFn: () => api.domains.quota(orgId),
    enabled: !!orgId,
  });
  if (quota.isPending || quota.error || me.data?.capabilities?.sending === false) return null;
  const q = quota.data;
  if (!q.configured) {
    return (
      <p className="mb-3.5 text-xs text-[#767d8a]">
        Connect Cloudflare from Add domain to view your sending allowance.
      </p>
    );
  }
  const used = q.limit ? Math.min(1, q.sent / q.limit) : 1;
  return (
    <Panel className="mb-3.5">
      <div className="px-4 py-4 md:px-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-semibold">Sending quota</span>
          <span className="text-[12px] text-[#9BA1AD]">
            {q.sent.toLocaleString()} of {q.limit.toLocaleString()} per {q.unit} ·{" "}
            {q.remaining.toLocaleString()} left
          </span>
        </div>
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/6">
          <div
            className="h-full rounded-full"
            style={{ width: `${used * 100}%`, background: q.overQuota ? "#F26B5B" : "#35C07A" }}
          />
        </div>
        {q.overQuota && (
          <p className="mt-2 text-[11.5px] text-ox-danger">
            Over quota: sends are refused until it resets
            {q.resetsAt ? ` (${new Date(q.resetsAt).toLocaleString()})` : ""}.
          </p>
        )}
      </div>
    </Panel>
  );
}

function DomainCard({ domain }: { domain: DomainRow }) {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const addrs = useQuery({
    queryKey: ["domain-addresses", orgId, domain.id],
    queryFn: () => api.domains.addresses(orgId, domain.id),
    enabled: !!orgId,
  });
  const rows = addrs.data?.addresses ?? [];

  return (
    <Panel>
      <div className="flex items-center gap-3.5 px-4 py-[18px] md:px-5">
        <span className="flex size-[38px] flex-none items-center justify-center rounded-[10px] bg-white/5">
          <Globe className="size-[19px] text-[#9BA1AD]" strokeWidth={1.6} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-heading text-[15px] font-semibold">{domain.name}</div>
          <div className="mt-0.5 text-xs text-[#7c838f]">
            {rows.length || domain.addressCount} address{(rows.length || domain.addressCount) === 1 ? "" : "es"}
            {domain.region && ` · ${domain.region}`}
          </div>
        </div>
        <PolicyMenu domain={domain} />
        <ActiveToggle domain={domain} />
        <StatusPill status={domain.status} />
        <Button
          variant="outline"
          onClick={() => setAdding((v) => !v)}
          className="h-8 flex-none gap-1.5 rounded-[9px] border-white/14 bg-white/4 px-3 text-xs font-medium"
        >
          <Plus className="size-3.5" strokeWidth={2} /> Address
        </Button>
      </div>
      <HealthRow domain={domain} />
      {!domain.receivingEnabled && <details className="border-t border-white/6 px-5 py-3 text-sm">
        <summary className="cursor-pointer text-[#C4CAD4]">Connect receiving</summary>
        <p className="mt-2 text-xs text-[#9BA1AD]">This domain currently sends only. Review its records before moving incoming mail to Box Ox.</p>
        <ZoneRow name={domain.name} apiBase={`/api/orgs/${encodeURIComponent(orgId)}/domains`} onboardPath="/onboard" onComplete={() => {
          qc.invalidateQueries({ queryKey: ["domains", orgId] });
        }} />
      </details>}

      {rows.map((a) => (
        <AddressLine key={a.id} a={a} domain={domain} isCatchAll={domain.catchAllAddressId === a.id} />
      ))}
      {rows.length === 0 && !adding && (
        <div className="border-t border-white/[0.045] px-5 py-3.5 text-[12.5px] text-[#7c838f]">
          No addresses yet. Mint one to start receiving on this domain.
        </div>
      )}
      {adding && <AddAddressForm domain={domain} onDone={() => setAdding(false)} />}
    </Panel>
  );
}

export function DomainsPage() {
  const orgId = useActiveOrgId();
  const domains = useQuery({
    queryKey: ["domains", orgId],
    queryFn: () => api.domains.list(orgId),
    enabled: !!orgId,
  });

  return (
    <PageContainer>
      <PageHeader
        title="Domains"
        description="Your onboarded domains, their DNS health and the addresses minted on them."
        action={<AddDomainDialog />}
      />
      <QuotaPanel />
      {domains.isPending ? (
        <div className="space-y-3.5">
          <Skeleton className="h-[108px] rounded-[14px]" />
          <Skeleton className="h-[108px] rounded-[14px]" />
        </div>
      ) : domains.error ? (
        <Panel>
          <p className="p-6 text-sm text-ox-danger">
            {domains.error instanceof ApiRequestError
              ? domains.error.message
              : "Failed to load domains"}
          </p>
        </Panel>
      ) : domains.data.domains.length === 0 ? (
        <PanelEmpty
          title="No domains yet"
          desc="Choose Add domain to connect your first mail domain."
        />
      ) : (
        <div className="flex flex-col gap-3.5">
          {domains.data.domains.map((d) => (
            <DomainCard key={d.id} domain={d} />
          ))}
          <p className="text-xs text-[#767d8a]">
            Kind, catch-all, people and status are all reconfigurable here any time.
          </p>
        </div>
      )}
    </PageContainer>
  );
}
