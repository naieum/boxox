import { startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useMe } from "@/AppShell";
import { Panel } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "never");

function Passkeys() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ["auth", "passkeys"], queryFn: () => api.auth.passkeys() });
  const [name, setName] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: ["auth", "passkeys"] });
  const add = useMutation({
    mutationFn: async () => {
      const { options } = await api.auth.passkeyBegin();
      await api.auth.passkeyFinish(await startRegistration({ optionsJSON: options }), name);
    },
    onSuccess: () => { setName(""); void refresh(); },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.auth.removePasskey(id), onSuccess: refresh });
  const rows = list.data?.passkeys ?? [];
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold">Your passkeys</h2>
      <p className="mb-3 text-xs text-[#7c838f]">Add one on each device you use. Keep at least two so a lost device does not lock you out.</p>
      <Panel>
        {rows.map((p, i) => (
          <div key={p.id} className={`flex items-center gap-4 px-5 py-3.5 ${i < rows.length - 1 ? "border-b border-white/4" : ""}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium">{p.name}</div>
              <div className="mt-0.5 text-xs text-[#7c838f]">Added {day(p.createdAt)} · last used {day(p.lastUsedAt)}</div>
            </div>
            <Button variant="outline" size="sm" disabled={rows.length < 2 || remove.isPending} onClick={() => remove.mutate(p.id)}>Remove</Button>
          </div>
        ))}
      </Panel>
      <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
        <Input value={name} maxLength={80} placeholder="Name for this device" aria-label="Name for this device" onChange={(event) => setName(event.target.value)} />
        <Button type="submit" disabled={add.isPending}>{add.isPending ? "Waiting…" : "Add a passkey"}</Button>
      </form>
      {(add.error || remove.error) && <p role="alert" className="mt-2 text-sm text-ox-danger">{((add.error || remove.error) as Error).message}</p>}
    </section>
  );
}

function Members() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ["auth", "members"], queryFn: () => api.auth.members() });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: ["auth", "members"] });
  const invite = useMutation({ mutationFn: () => api.auth.invite(email, name), onSuccess: () => { setEmail(""); setName(""); setCopied(false); void refresh(); } });
  const remove = useMutation({ mutationFn: (member: string) => api.auth.removeMember(member), onSuccess: refresh });
  const people = [
    ...(list.data?.members ?? []).map((m) => ({ ...m, pending: false })),
    ...(list.data?.pending ?? []).map((p) => ({ email: p.email, name: p.name, role: "member", passkeys: 0, pending: true })),
  ];
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold">People</h2>
      <p className="mb-3 text-xs text-[#7c838f]">
        Someone you add can sign in. They see no mail until you grant them an address on its settings.
      </p>
      <Panel>
        {people.map((m, i) => (
          <div key={`${m.email}:${m.pending}`} className={`flex items-center gap-4 px-5 py-3.5 ${i < people.length - 1 ? "border-b border-white/4" : ""}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium">{m.name || m.email}</div>
              <div className="mt-0.5 truncate text-xs text-[#7c838f]">{m.email}</div>
            </div>
            <Badge className="rounded-full text-[11px] font-semibold capitalize">{m.pending ? "Invited" : m.role}</Badge>
            {m.role !== "owner" && <Button variant="outline" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(m.email)}>Remove</Button>}
          </div>
        ))}
      </Panel>
      <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(event) => { event.preventDefault(); invite.mutate(); }}>
        <Input type="email" required value={email} placeholder="Email address" aria-label="Email address" onChange={(event) => setEmail(event.target.value)} />
        <Input value={name} maxLength={120} placeholder="Name (optional)" aria-label="Name" onChange={(event) => setName(event.target.value)} />
        <Button type="submit" disabled={invite.isPending}>Create sign-in link</Button>
      </form>
      {invite.data && (
        <div className="mt-3 rounded-xl border border-white/10 bg-white/2 p-4 text-sm">
          <p className="mb-2 text-[#C4CAD4]">
            Send this link to {invite.data.email} yourself. It works once, until {day(invite.data.expiresAt)}. It is not shown again.
          </p>
          <div className="flex gap-2">
            <Input readOnly value={invite.data.link} aria-label="Sign-in link" onFocus={(event) => event.target.select()} />
            <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(invite.data!.link).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy"}</Button>
          </div>
        </div>
      )}
      {(invite.error || remove.error) && <p role="alert" className="mt-2 text-sm text-ox-danger">{((invite.error || remove.error) as Error).message}</p>}
    </section>
  );
}

export function SignInSettingsTab() {
  const me = useMe();
  return (
    <div className="flex flex-col gap-8">
      <Passkeys />
      {me.data?.user.role === "owner" && <Members />}
    </div>
  );
}
