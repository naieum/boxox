import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type ProcessingChoices, type ProcessingProvider, type ProcessingSettings } from "@/lib/api";

const QUERY = ["settings", "processing"];
const selectClass = "mt-2 w-full rounded-lg border border-white/15 bg-[#141820] px-3 py-2 text-sm";

function ProcessingEditor({ data }: { data: ProcessingSettings }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<ProcessingProvider | "">(data.processing.provider ?? "");
  const [budget, setBudget] = useState(String(data.processing.dailyBudgetMicros / 1_000_000));
  const [rules, setRules] = useState(data.processing.ownerRules.join("\n"));
  const [uncertain, setUncertain] = useState(data.processing.onlyWhenUncertain);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  const update = useMutation({
    mutationFn: (patch: Partial<ProcessingChoices>) => api.updateProcessing(patch),
    onSuccess: (result) => {
      qc.setQueryData(QUERY, result);
      setNotice(result.warnings?.length ? `Saved. ${result.warnings.join(" ")}` : "Saved.");
    },
  });
  const addressUpdate = useMutation({
    mutationFn: ({ id, aiDisabled }: { id: string; aiDisabled: boolean }) => api.setAddressAiDisabled(id, aiDisabled),
    onSuccess: (result) => {
      qc.setQueryData<ProcessingSettings>(QUERY, (old) => old ? { ...old, addresses: old.addresses.map((a) => a.id === result.id ? { ...a, aiDisabled: result.aiDisabled } : a) } : old);
      setNotice("Address choice saved.");
    },
  });
  const selected = data.providers.find((p) => p.id === provider);
  const pending = update.isPending;
  const save = (event: FormEvent) => {
    event.preventDefault();
    const ownerRules = rules.split("\n").map((r) => r.trim()).filter(Boolean);
    const dailyBudgetMicros = Math.round(Number(budget) * 1_000_000);
    if (!Number.isFinite(dailyBudgetMicros) || dailyBudgetMicros < 0 || dailyBudgetMicros > 1_000_000_000 || ownerRules.length > 20 || ownerRules.some((r) => r.length > 500)) {
      setFormError("Use a daily budget from $0 to $1,000 and up to 20 rules of 500 characters each.");
      return;
    }
    setFormError("");
    setNotice("");
    update.mutate({ ownerRules, dailyBudgetMicros, onlyWhenUncertain: uncertain });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Mail processing</h2>
        <p className="mt-1 text-sm text-[#9BA1AD]">Switches save immediately. Turning AI off stops new AI requests; requests already running may finish.</p>
      </div>
      {data.capabilities?.ai === false && <p className="text-sm text-[#9BA1AD]">AI is not installed in the Free inbox profile. Local filters and reputation controls remain available.</p>}
      {data.groups.filter(group => group.id !== "ai" || data.capabilities?.ai !== false).map((group) => (
        <section key={group.id} className="rounded-xl border border-white/10 p-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={`processing-${group.id}`} className="text-sm font-semibold">{group.title}</Label>
            <Switch id={`processing-${group.id}`} checked={data.processing[group.id] === true}
              disabled={pending || (group.id === "ai" && !data.processing.ai && !provider)}
              onCheckedChange={(on) => { setNotice(""); update.mutate({ [group.id]: on, ...(group.id === "ai" && on ? { provider: provider || null } : {}) }); }} />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[#9BA1AD]">{group.summary}</p>
          {group.id === "reputationLookups" && <p className="mt-2 text-xs text-[#9BA1AD]">Reputation lookups run when local filters are on.</p>}
          {group.id === "ai" && (
            <div className="mt-4">
              <p className="mb-3 text-xs text-[#C4CAD4]">{data.processing.ai ? `AI is on with ${data.providers.find((p) => p.id === data.processing.provider)?.label ?? "your selected provider"}.` : "AI is off."}</p>
              <Label htmlFor="processing-provider">AI provider</Label>
              <select id="processing-provider" className={selectClass} value={provider} disabled={pending} onChange={(e) => setProvider(e.target.value as ProcessingProvider | "")}>
                <option value="">Choose a provider</option>
                {data.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              {selected && <div className="mt-3 space-y-2 text-xs leading-relaxed text-[#C4CAD4]">
                <p>{selected.dataNote}</p>
                <a className="underline" href={selected.termsUrl} target="_blank" rel="noreferrer">Provider terms</a>
                <ul className="space-y-1">{selected.models.map((m, i) => <li key={i}>{m.use}: <span className="font-mono">{m.model}</span></li>)}</ul>
                {selected.needsCredits && <p>Calls use your Cloudflare AI Gateway credits.</p>}
              </div>}
              {!provider && <p className="mt-2 text-xs text-[#9BA1AD]">Choose a provider before turning AI on.</p>}
              {data.processing.ai && provider && provider !== data.processing.provider && <Button className="mt-3" disabled={pending} onClick={() => update.mutate({ provider })}>Use this provider</Button>}
              {!data.tokenConfigured && <p className="mt-3 text-xs text-[#9BA1AD]">Turning AI off and editing rules or the app budget work without the setup token. To turn AI on or change providers, restore the Cloudflare setup token so Box Ox can check credits and gateway privacy.</p>}
            </div>
          )}
        </section>
      ))}
      {data.capabilities?.ai !== false && <form onSubmit={save} className="space-y-4 rounded-xl border border-white/10 p-4">
        <h3 className="font-semibold">AI rules and spending</h3>
        <div>
          <Label htmlFor="processing-budget">Daily AI budget (USD)</Label>
          <Input id="processing-budget" className="mt-2" type="number" min="0" max="1000" step="0.01" required value={budget} onChange={(e) => setBudget(e.target.value)} />
          <p className="mt-2 text-xs text-[#9BA1AD]">$0 stops new AI calls. The app checks this budget before each call; concurrent calls can pass the check together. Without the setup token, the gateway keeps its previous backstop limit.</p>
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="processing-uncertain">Classify with AI only when other checks are uncertain</Label>
          <Switch id="processing-uncertain" checked={uncertain} onCheckedChange={setUncertain} />
        </div>
        <div>
          <Label htmlFor="processing-rules">Your spam rules</Label>
          <textarea id="processing-rules" className={`${selectClass} min-h-28`} rows={4} value={rules} onChange={(e) => setRules(e.target.value)} aria-describedby="processing-rules-help" placeholder="Crypto pitches are spam" />
          <p id="processing-rules-help" className="mt-2 text-xs text-[#9BA1AD]">One rule per line. Up to 20 rules, 500 characters each. Rules apply when the AI classifier runs.</p>
        </div>
        {formError && <p role="alert" className="text-sm text-red-300">{formError}</p>}
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save rules and budget"}</Button>
      </form>}
      <section className="space-y-3 rounded-xl border border-white/10 p-4">
        <h3 className="font-semibold">Address exceptions</h3>
        <p className="text-xs text-[#9BA1AD]">Disable AI for individual addresses. Local filters still follow your choices above.</p>
        {!data.addresses.length && <p className="text-sm text-[#9BA1AD]">No addresses yet.</p>}
        {data.addresses.map((address) => <div key={address.id} className="flex items-center justify-between gap-4 py-2">
          <Label htmlFor={`ai-disabled-${address.id}`} className="min-w-0 break-all">Disable AI for {address.email}</Label>
          <Switch id={`ai-disabled-${address.id}`} checked={address.aiDisabled} disabled={addressUpdate.isPending} onCheckedChange={(aiDisabled) => addressUpdate.mutate({ id: address.id, aiDisabled })} />
        </div>)}
      </section>
      {(update.error || addressUpdate.error) && <p role="alert" className="text-sm text-red-300">{(update.error ?? addressUpdate.error)?.message}</p>}
      {notice && <p role="status" className="text-sm text-[#C4CAD4]">{notice}</p>}
    </div>
  );
}

export function ProcessingSettingsTab() {
  const query = useQuery({ queryKey: QUERY, queryFn: api.processingSettings });
  if (query.isPending) return <p role="status">Loading processing settings…</p>;
  if (query.isError) return <div><p role="alert">{query.error.message}</p><Button className="mt-3" onClick={() => query.refetch()}>Try again</Button></div>;
  return <ProcessingEditor data={query.data} />;
}
