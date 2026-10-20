import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Plus, RotateCw, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useActiveOrgId } from "@/AppShell";
import { PageContainer, PageHeader, Panel, PanelEmpty } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiRequestError } from "@/lib/api";
import { DevTabs } from "./DevShared";

const PERMISSIONS = ["send", "read_log", "read_received", "templates", "webhooks"] as const;
type Permission = (typeof PERMISSIONS)[number];

interface KeyRow {
  id: string;
  kind: "management" | "domain";
  name: string;
  domainId: string | null;
  display: string;
  permissions: Permission[];
  dailySendCap: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
  rotationEndsAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
}

interface ManagementRow extends KeyRow {
  domains: { domainId: string; grantablePermissions: Permission[]; dailySendBudget: number | null }[];
  children: KeyRow[];
}

interface KeyTree {
  domains: { id: string; name: string }[];
  management: ManagementRow[];
  unparented: KeyRow[];
}

async function keysRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "x-boxox-csrf": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) {
    throw new ApiRequestError(res.status, json.error?.code ?? "unknown", json.error?.message ?? `Request failed (${res.status})`);
  }
  return json as T;
}

const base = (orgId: string) => `/api/orgs/${orgId}/dev/keys`;

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : "never";
}

function SecretReveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2.5 border-b border-white/6 bg-white/2 p-5">
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-lg bg-black/30 px-3 py-2 font-mono text-[13px]">{secret}</code>
        <Button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(secret);
            setCopied(true);
          }}
          className="h-9 flex-none gap-1.5 rounded-lg px-3 text-xs font-semibold"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-[11.5px] font-medium" style={{ color: "#F2B33D" }}>
        Shown once. Only the prefix and last four characters are kept in view after this.
      </p>
      <Button type="button" variant="ghost" onClick={onDone} className="h-8 rounded-lg text-[13px] text-[#9BA1AD]">
        Done
      </Button>
    </div>
  );
}

function PermissionPicker({
  value,
  onChange,
  allowed = PERMISSIONS,
}: {
  value: Permission[];
  onChange: (v: Permission[]) => void;
  allowed?: readonly Permission[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {allowed.map((p) => {
        const on = value.includes(p);
        return (
          <button
            key={p}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== p) : [...value, p])}
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[11.5px] ${
              on ? "border-ox/50 bg-ox/6 text-foreground" : "border-white/8 text-[#9BA1AD] hover:border-white/18"
            }`}
          >
            {p}
          </button>
        );
      })}
    </div>
  );
}

function NewManagementKey({ tree, onCreated }: { tree: KeyTree; onCreated: (secret: string) => void }) {
  const orgId = useActiveOrgId();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Record<string, { perms: Permission[]; budget: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      keysRequest<{ secret: string }>(`${base(orgId)}/management`, {
        name,
        domains: Object.entries(picked).map(([domainId, g]) => ({
          domainId,
          grantablePermissions: g.perms,
          dailySendBudget: g.budget ? Number(g.budget) : null,
        })),
      }),
    onSuccess: (r) => onCreated(r.secret),
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : "Could not create key"),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    create.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 border-b border-white/6 bg-white/2 p-5">
      <div className="space-y-[7px]">
        <Label className="text-xs font-medium text-[#9BA1AD]">Name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="deploy-ci"
          className="h-10 max-w-[320px] rounded-[10px] bg-white/3 text-[13px]"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs font-medium text-[#9BA1AD]">Domains it may mint keys for</Label>
        {tree.domains.map((d) => {
          const g = picked[d.id];
          return (
            <div key={d.id} className="space-y-2 rounded-[10px] border border-white/8 p-3">
              <label className="flex items-center gap-2 text-[13px] font-semibold">
                <input
                  type="checkbox"
                  checked={!!g}
                  onChange={(e) => {
                    const next = { ...picked };
                    if (e.target.checked) next[d.id] = { perms: ["send"], budget: "" };
                    else delete next[d.id];
                    setPicked(next);
                  }}
                />
                {d.name}
              </label>
              {g && (
                <div className="flex flex-wrap items-center gap-3 pl-6">
                  <PermissionPicker value={g.perms} onChange={(perms) => setPicked({ ...picked, [d.id]: { ...g, perms } })} />
                  <Input
                    value={g.budget}
                    onChange={(e) => setPicked({ ...picked, [d.id]: { ...g, budget: e.target.value.replace(/\D/g, "") } })}
                    placeholder="daily send budget (blank = none)"
                    className="h-8 max-w-[240px] rounded-lg bg-white/3 text-[12px]"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="text-sm text-ox-danger">{error}</p>}
      <Button
        type="submit"
        disabled={create.isPending || !name || !Object.keys(picked).length}
        className="h-9 rounded-[10px] font-heading text-[13px] font-semibold"
      >
        {create.isPending ? "Creating…" : "Create management key"}
      </Button>
    </form>
  );
}

function NewDomainKey({ tree, onCreated }: { tree: KeyTree; onCreated: (secret: string) => void }) {
  const orgId = useActiveOrgId();
  const [name, setName] = useState("");
  const [domainId, setDomainId] = useState(tree.domains[0]?.id ?? "");
  const [perms, setPerms] = useState<Permission[]>(["send"]);
  const [cap, setCap] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      keysRequest<{ secret: string }>(`${base(orgId)}/domain`, {
        name,
        domainId,
        permissions: perms,
        dailySendCap: cap ? Number(cap) : null,
      }),
    onSuccess: (r) => onCreated(r.secret),
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : "Could not create key"),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        create.mutate();
      }}
      className="space-y-4 border-b border-white/6 bg-white/2 p-5"
    >
      <div className="flex flex-wrap gap-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="app1-send"
          className="h-10 max-w-[240px] rounded-[10px] bg-white/3 text-[13px]"
        />
        <select
          value={domainId}
          onChange={(e) => setDomainId(e.target.value)}
          className="h-10 rounded-[10px] border border-white/8 bg-white/3 px-3 text-[13px]"
        >
          {tree.domains.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <Input
          value={cap}
          onChange={(e) => setCap(e.target.value.replace(/\D/g, ""))}
          placeholder="daily send cap"
          className="h-10 max-w-[160px] rounded-[10px] bg-white/3 text-[13px]"
        />
      </div>
      <PermissionPicker value={perms} onChange={setPerms} />
      {error && <p className="text-sm text-ox-danger">{error}</p>}
      <Button
        type="submit"
        disabled={create.isPending || !name || !domainId || !perms.length}
        className="h-9 rounded-[10px] font-heading text-[13px] font-semibold"
      >
        {create.isPending ? "Creating…" : "Create domain key"}
      </Button>
    </form>
  );
}

function KeyLine({
  k,
  domainName,
  indent,
  onSecret,
}: {
  k: KeyRow;
  domainName?: string;
  indent?: boolean;
  onSecret: (secret: string) => void;
}) {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["dev-keys", orgId] });
  const rotate = useMutation({
    mutationFn: () => keysRequest<{ secret: string }>(`${base(orgId)}/${k.id}/rotate`, {}),
    onSuccess: (r) => {
      onSecret(r.secret);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (cascade: boolean) => keysRequest(`${base(orgId)}/${k.id}/revoke`, { cascade }),
    onSuccess: refresh,
  });
  const revoked = !!k.revokedAt;

  return (
    <div className={`flex flex-wrap items-center gap-3 border-t border-white/6 px-5 py-3 ${indent ? "pl-12" : ""} ${revoked ? "opacity-50" : ""}`}>
      <KeyRound className="size-4 flex-none text-[#7C838F]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          {k.name}
          <code className="font-mono text-[11.5px] font-normal text-[#9BA1AD]">{k.display}</code>
          {domainName && <span className="text-[11.5px] font-normal text-[#7C838F]">{domainName}</span>}
        </div>
        <div className="text-[11.5px] text-[#7C838F]">
          {k.kind === "domain" && <span className="font-mono">{k.permissions.join(" · ")} </span>}
          {k.dailySendCap != null && <span>· {k.dailySendCap}/day </span>}
          · last used {when(k.lastUsedAt)}
          {k.lastUsedIp && ` from ${k.lastUsedIp}`}
          {k.rotationEndsAt && ` · old secret valid until ${when(k.rotationEndsAt)}`}
          {revoked && ` · revoked ${when(k.revokedAt)}`}
        </div>
      </div>
      {!revoked && (
        <div className="flex gap-1.5">
          <Button
            type="button"
            variant="ghost"
            onClick={() => rotate.mutate()}
            disabled={rotate.isPending}
            className="h-8 gap-1.5 rounded-lg text-xs text-[#9BA1AD]"
          >
            <RotateCw className="size-3.5" /> Rotate
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => window.confirm(`Revoke ${k.name}? It stops working immediately.`) && revoke.mutate(false)}
            className="h-8 gap-1.5 rounded-lg text-xs text-ox-danger"
          >
            <X className="size-3.5" /> Revoke
          </Button>
          {k.kind === "management" && (
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                window.confirm(`Revoke ${k.name} and every key it created?`) && revoke.mutate(true)
              }
              className="h-8 rounded-lg text-xs text-ox-danger"
            >
              Revoke children too
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function DevKeysPage() {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const tree = useQuery({
    queryKey: ["dev-keys", orgId],
    queryFn: () => keysRequest<KeyTree>(base(orgId)),
    enabled: !!orgId,
  });
  const [form, setForm] = useState<"management" | "domain" | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const data = tree.data;
  const domainName = (id: string | null) => data?.domains.find((d) => d.id === id)?.name;
  const onCreated = (s: string) => {
    setSecret(s);
    setForm(null);
    qc.invalidateQueries({ queryKey: ["dev-keys", orgId] });
  };

  return (
    <PageContainer>
      <PageHeader
        title="Developer keys"
        description="Management keys mint one-domain keys for your apps. No key can act on every domain."
        action={
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setForm(form === "domain" ? null : "domain")}
              className="h-9 gap-1.5 rounded-[10px] text-[13px]"
            >
              <Plus className="size-4" /> Domain key
            </Button>
            <Button
              type="button"
              onClick={() => setForm(form === "management" ? null : "management")}
              className="h-9 gap-1.5 rounded-[10px] font-heading text-[13px] font-semibold"
            >
              <Plus className="size-4" /> Management key
            </Button>
          </div>
        }
      />
      <DevTabs />
      <Panel>
        {secret && <SecretReveal secret={secret} onDone={() => setSecret(null)} />}
        {data && form === "management" && <NewManagementKey tree={data} onCreated={onCreated} />}
        {data && form === "domain" && <NewDomainKey tree={data} onCreated={onCreated} />}
        {tree.isLoading && (
          <div className="space-y-2 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {tree.error && (
          <p className="p-5 text-sm text-ox-danger">
            {tree.error instanceof ApiRequestError ? tree.error.message : "Could not load keys"}
          </p>
        )}
        {data?.management.map((m) => (
          <div key={m.id}>
            <KeyLine k={m} onSecret={setSecret} />
            <div className="px-5 pb-2 pl-12 text-[11.5px] text-[#7C838F]">
              {m.domains
                .map(
                  (g) =>
                    `${domainName(g.domainId) ?? g.domainId}: ${g.grantablePermissions.join(", ")}${
                      g.dailySendBudget != null ? ` (${g.dailySendBudget}/day)` : ""
                    }`,
                )
                .join(" — ")}
            </div>
            {m.children.map((c) => (
              <KeyLine key={c.id} k={c} domainName={domainName(c.domainId)} indent onSecret={setSecret} />
            ))}
          </div>
        ))}
        {data?.unparented.map((k) => (
          <KeyLine key={k.id} k={k} domainName={domainName(k.domainId)} onSecret={setSecret} />
        ))}
      </Panel>
      {data && !data.management.length && !data.unparented.length && (
        <div className="mt-4">
          <PanelEmpty title="No keys yet" desc="Create a management key for your CI, then let each project mint its own key." />
        </div>
      )}
    </PageContainer>
  );
}
