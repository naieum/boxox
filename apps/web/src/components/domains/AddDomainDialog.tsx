import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useActiveOrgId, useMe } from "@/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { ZoneRow } from "@/pages/Setup";

export function AddDomainDialog() {
  const orgId = useActiveOrgId();
  const me = useMe();
  const qc = useQueryClient();
  const params = useSearch({ from: "/shell/domains" });
  const navigate = useNavigate();
  const [outcome] = useState(() => params.cloudflare);
  const [open, setOpen] = useState(() => !!params.cloudflare);
  useEffect(() => {
    if (params.cloudflare) void navigate({ to: "/domains", search: {}, replace: true });
  }, [params.cloudflare, navigate]);
  const [added, setAdded] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const free = me.data?.capabilities?.sending === false;
  const zones = useQuery({ queryKey: ["domain-connection", orgId], queryFn: () => api.domains.zones(orgId), enabled: open, gcTime: 0, refetchInterval: open ? 30_000 : false });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["domain-connection", orgId] });
    qc.invalidateQueries({ queryKey: ["sending-quota", orgId] });
    qc.removeQueries({ queryKey: ["domain-preview", `/api/orgs/${encodeURIComponent(orgId)}/domains`] });
  };
  const connect = useMutation({
    // Never put the credential into mutation variables, query keys, or browser storage.
    mutationFn: () => api.domains.connect(orgId, input.current?.value.trim() ?? ""),
    onSuccess: refresh,
    onSettled: () => { if (input.current) input.current.value = ""; },
  });
  const authorize = useMutation({
    mutationFn: () => api.domains.authorize(orgId),
    onSuccess: ({ url }) => { window.location.assign(url); },
  });
  const disconnect = useMutation({ mutationFn: () => api.domains.disconnect(orgId), onSuccess: () => { connect.reset(); refresh(); } });
  const available = zones.data?.zones.filter(z => !z.onboarded && z.status === "active") ?? [];
  const configured = !!zones.data?.configured && !zones.error;

  return <Dialog.Root open={open} onOpenChange={value => { setOpen(value); if (!value) { connect.reset(); setAdded(null); } }}>
    <Dialog.Trigger asChild><Button className="flex-none gap-1.5"><Plus className="size-4" /> Add domain</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-[620px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-white/10 bg-surface-3 p-5 text-foreground shadow-2xl sm:p-7">
        <Dialog.Title className="pr-8 font-heading text-xl font-bold">Add a domain</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm text-[#9BA1AD]">Connect a domain from your Cloudflare account. Review its mail records before applying changes.</Dialog.Description>
        <Dialog.Close asChild><Button variant="ghost" size="icon" className="absolute right-3 top-3" aria-label="Close add domain"><X className="size-4" /></Button></Dialog.Close>
        {added && <p role="status" className="mt-4 text-sm text-ox-success">{added} is connected.</p>}
        {outcome === "connected" && configured && <p role="status" className="mt-4 text-sm text-ox-success">Cloudflare connected. Choose your domain below.</p>}
        {outcome === "denied" && <p role="status" className="mt-4 text-sm text-[#9BA1AD]">Connection cancelled. Your mail records were not changed.</p>}
        {outcome === "failed" && <p role="alert" className="mt-4 text-sm text-ox-danger">Cloudflare could not be connected. Try again.</p>}
        {zones.isPending && <p role="status" className="mt-5 text-sm">Checking Cloudflare access…</p>}
        {zones.error && <p role="alert" className="mt-4 text-sm text-ox-danger">{zones.error.message}</p>}
        {zones.data?.connectionError && <p role="alert" className="mt-4 text-sm text-ox-danger">{zones.data.connectionError}</p>}
        {!zones.isPending && !configured && me.data?.user.role !== "owner" && <p className="mt-5 text-sm text-[#9BA1AD]">Ask the installation owner to connect Cloudflare before adding a domain.</p>}
        {!zones.isPending && !configured && me.data?.user.role === "owner" && <div className="mt-5 space-y-4">
          {zones.data?.oauthAvailable && <div className="space-y-3"><p className="text-sm text-[#9BA1AD]">Approve access in Cloudflare. Box Ox handles the connection and keeps it up to date.</p><Button disabled={authorize.isPending} onClick={() => authorize.mutate()}>{authorize.isPending ? "Opening Cloudflare…" : "Connect with Cloudflare"}</Button><p className="text-xs text-[#9BA1AD]">You’ll review mail records before any DNS changes.</p>{authorize.error && <p role="alert" className="text-sm text-ox-danger">{authorize.error.message}</p>}</div>}
          <details open={!zones.data?.oauthAvailable}><summary className="cursor-pointer text-xs text-[#9BA1AD]">Advanced: connect with an API token</summary><form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); connect.mutate(); }}>
          <div><h3 className="text-sm font-semibold">Connect Cloudflare</h3><p className="mt-1 text-sm text-[#9BA1AD]">Use a scoped API token for this account and the domains you want to add.</p></div>
          <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="inline-block text-sm text-ox underline underline-offset-4">Create a Cloudflare token ↗</a>
          <details className="rounded-lg border border-white/10 p-3 text-xs text-[#9BA1AD]"><summary className="cursor-pointer text-[#C4CAD4]">Required token permissions</summary><ul className="mt-2 list-disc space-y-1 pl-4"><li>Zone Read and DNS Edit for the domains you choose.</li><li>Email Routing Edit for receiving mail.</li>{!free && <li>Email Sending Edit and Queues Edit for sending mail and delivery events.</li>}</ul><p className="mt-2">Restrict the token to this installation’s account and your selected zones. <a href="https://boxox.dev/docs/connect-domain/" target="_blank" rel="noreferrer" className="underline">Token setup guide ↗</a></p></details>
          <div className="space-y-2"><Label htmlFor="domain-cloudflare-token">Cloudflare API token</Label><Input ref={input} id="domain-cloudflare-token" type="password" autoComplete="off" required minLength={10} maxLength={512} disabled={connect.isPending} placeholder="Paste your scoped token" /></div>
          <p className="text-xs leading-relaxed text-[#9BA1AD]">This connection expires after 15 minutes. Box Ox keeps it in an encrypted, HttpOnly browser cookie. Connecting only checks access; it does not change DNS.</p>
          {connect.error && <p role="alert" className="text-sm text-ox-danger">{connect.error.message}</p>}
          <Button type="submit" disabled={connect.isPending}>{connect.isPending ? "Connecting…" : "Connect Cloudflare"}</Button>
          </form></details>
        </div>}
        {configured && <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/4 p-3"><div><p className="text-sm font-medium">Cloudflare connected</p><p className="mt-1 text-xs text-[#9BA1AD]">{zones.data?.connection?.oauth ? "Access renews automatically." : zones.data?.connection?.temporary ? `Expires at ${new Date(zones.data?.connection.expiresAt!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "Using the connection configured for this installation."}</p></div>{(zones.data?.connection?.temporary || zones.data?.connection?.oauth) && <Button variant="outline" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button>}</div>
          {disconnect.error && <p role="alert" className="mt-3 text-sm text-ox-danger">{disconnect.error.message}</p>}
          <h3 className="mt-5 text-sm font-semibold">Choose a domain</h3>
          {available.length === 0 && <p className="mt-2 text-sm text-[#9BA1AD]">No unconnected active domains are visible. Add your domain to Cloudflare or check this connection’s domain access.</p>}
          {available.map(zone => <ZoneRow key={zone.id} name={zone.name} apiBase={`/api/orgs/${encodeURIComponent(orgId)}/domains`} onboardPath="/onboard" onComplete={() => { setAdded(zone.name); qc.invalidateQueries({ queryKey: ["domains", orgId] }); refresh(); }} />)}
          <Dialog.Close asChild><Button variant="outline" className="mt-5">Done</Button></Dialog.Close>
        </div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
