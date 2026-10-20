import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { PageContainer, PageHeader, Panel, PanelEmpty } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DevTabs, DomainKeyGate, HtmlPreview, devRequest, errorText, when } from "./DevShared";

const TYPES = ["string", "number", "boolean", "url"] as const;
type VarType = (typeof TYPES)[number];

interface Variable {
  name: string;
  type: VarType;
  fallback?: string | number | boolean;
  raw?: boolean;
}

interface Template {
  id: string;
  name: string;
  version: number;
  subject: string;
  html: string | null;
  text: string | null;
  variables: Variable[];
  createdBy: string;
  createdAt: string;
}

interface Rendered {
  subject: string;
  html: string | null;
  text: string | null;
}

interface Draft {
  name: string;
  subject: string;
  html: string;
  text: string;
  variables: (Omit<Variable, "fallback"> & { fallback: string })[];
}

const emptyDraft: Draft = { name: "", subject: "", html: "", text: "", variables: [] };

function toDraft(t: Template): Draft {
  return {
    name: t.name,
    subject: t.subject,
    html: t.html ?? "",
    text: t.text ?? "",
    variables: t.variables.map((v) => ({ ...v, fallback: v.fallback === undefined ? "" : String(v.fallback) })),
  };
}

function typedValue(type: VarType, value: string): string | number | boolean {
  if (type === "number") return Number(value);
  if (type === "boolean") return value === "true";
  return value;
}

function toBody(d: Draft) {
  return {
    subject: d.subject,
    html: d.html || null,
    text: d.text || null,
    variables: d.variables.map((v) => ({
      name: v.name,
      type: v.type,
      ...(v.fallback !== "" ? { fallback: typedValue(v.type, v.fallback) } : {}),
      ...(v.raw ? { raw: true } : {}),
    })),
  };
}

function VariableRows({ value, onChange }: { value: Draft["variables"]; onChange: (v: Draft["variables"]) => void }) {
  const set = (i: number, patch: Partial<Draft["variables"][number]>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="space-y-1.5">
      {value.map((v, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            value={v.name}
            onChange={(e) => set(i, { name: e.target.value })}
            placeholder="name"
            className="h-8 max-w-[160px] rounded-lg bg-white/3 font-mono text-[12px]"
          />
          <select
            value={v.type}
            onChange={(e) => set(i, { type: e.target.value as VarType })}
            className="h-8 rounded-lg border border-white/8 bg-white/3 px-2 text-[12px]"
          >
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <Input
            value={v.fallback}
            onChange={(e) => set(i, { fallback: e.target.value })}
            placeholder="fallback (blank = required)"
            className="h-8 max-w-[200px] rounded-lg bg-white/3 text-[12px]"
          />
          <label className="flex items-center gap-1.5 text-[12px] text-[#9BA1AD]">
            <input type="checkbox" checked={!!v.raw} onChange={(e) => set(i, { raw: e.target.checked })} />
            raw HTML
          </label>
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-[#7C838F] hover:text-foreground">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        onClick={() => onChange([...value, { name: "", type: "string", fallback: "" }])}
        className="h-7 gap-1 rounded-lg px-2 text-[12px] text-[#9BA1AD]"
      >
        <Plus className="size-3" /> Variable
      </Button>
    </div>
  );
}

function PreviewAndTest({ apiKey, template }: { apiKey: string; template: Template }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const variables = Object.fromEntries(
    template.variables.filter((v) => values[v.name]).map((v) => [v.name, typedValue(v.type, values[v.name]!)]),
  );
  const preview = useMutation({
    mutationFn: () =>
      devRequest<Rendered>(apiKey, `/templates/${template.name}/preview`, { body: { version: template.version, variables } }),
  });
  const testSend = useMutation({
    mutationFn: () =>
      devRequest<{ id: string }>(apiKey, "/messages", {
        body: { from, to: [to], template: { name: template.name, version: template.version }, variables, tags: { test: "template" } },
      }),
  });

  return (
    <div className="space-y-3 border-t border-white/6 p-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#767d8a]">Preview v{template.version}</div>
      {template.variables.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {template.variables.map((v) => (
            <Input
              key={v.name}
              value={values[v.name] ?? ""}
              onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
              placeholder={`${v.name}${v.fallback !== undefined ? ` (${String(v.fallback)})` : ""}`}
              className="h-8 max-w-[200px] rounded-lg bg-white/3 text-[12px]"
            />
          ))}
        </div>
      )}
      <Button type="button" variant="ghost" onClick={() => preview.mutate()} disabled={preview.isPending} className="h-8 rounded-lg text-[13px]">
        {preview.isPending ? "Rendering…" : "Render preview"}
      </Button>
      {preview.error && <p className="text-sm text-ox-danger">{errorText(preview.error, "Could not render")}</p>}
      {preview.data && (
        <div className="space-y-2">
          <div className="text-[13px] font-semibold">{preview.data.subject || "(no subject)"}</div>
          {preview.data.html && <HtmlPreview html={preview.data.html} />}
          {preview.data.text && (
            <pre className="max-h-[240px] overflow-auto rounded-lg bg-black/30 p-3 text-[12.5px] whitespace-pre-wrap text-[#C9CFD8]">
              {preview.data.text}
            </pre>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="from@yourdomain" className="h-8 max-w-[220px] rounded-lg bg-white/3 text-[12px]" />
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="to@example.com" className="h-8 max-w-[220px] rounded-lg bg-white/3 text-[12px]" />
        <Button
          type="button"
          onClick={() => testSend.mutate()}
          disabled={testSend.isPending || !from || !to}
          className="h-8 rounded-lg font-heading text-[12.5px] font-semibold"
        >
          {testSend.isPending ? "Sending…" : "Send test"}
        </Button>
        {testSend.data && <span className="text-[12px] text-[#9BA1AD]">Queued {testSend.data.id}. It needs a key with send.</span>}
      </div>
      {testSend.error && <p className="text-sm text-ox-danger">{errorText(testSend.error, "Could not send")}</p>}
    </div>
  );
}

function Editor({ apiKey, template, onSaved }: { apiKey: string; template: Template | null; onSaved: (name: string) => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(template ? toDraft(template) : emptyDraft);
  const save = useMutation({
    mutationFn: () =>
      template
        ? devRequest<Template>(apiKey, `/templates/${template.name}`, { method: "PUT", body: toBody(draft) })
        : devRequest<Template>(apiKey, "/templates", { body: { name: draft.name, ...toBody(draft) } }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["dev-templates", apiKey] });
      onSaved(t.name);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="space-y-3 p-5"
    >
      {!template && (
        <div className="space-y-[7px]">
          <Label className="text-xs font-medium text-[#9BA1AD]">Name</Label>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="welcome"
            className="h-9 max-w-[240px] rounded-[10px] bg-white/3 font-mono text-[13px]"
          />
        </div>
      )}
      <div className="space-y-[7px]">
        <Label className="text-xs font-medium text-[#9BA1AD]">Subject</Label>
        <Input
          value={draft.subject}
          onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
          placeholder="Welcome, {{name}}"
          className="h-9 rounded-[10px] bg-white/3 text-[13px]"
        />
      </div>
      <div className="space-y-[7px]">
        <Label className="text-xs font-medium text-[#9BA1AD]">HTML</Label>
        <Textarea
          value={draft.html}
          onChange={(e) => setDraft({ ...draft, html: e.target.value })}
          rows={8}
          className="rounded-[10px] bg-white/3 font-mono text-[12px]"
        />
      </div>
      <div className="space-y-[7px]">
        <Label className="text-xs font-medium text-[#9BA1AD]">Text (blank = generated from HTML at send)</Label>
        <Textarea
          value={draft.text}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          rows={4}
          className="rounded-[10px] bg-white/3 font-mono text-[12px]"
        />
      </div>
      <div className="space-y-[7px]">
        <Label className="text-xs font-medium text-[#9BA1AD]">
          Variables: <code className="font-mono">{"{{var}}"}</code> is escaped, <code className="font-mono">{"{{{var}}}"}</code> needs raw HTML
        </Label>
        <VariableRows value={draft.variables} onChange={(variables) => setDraft({ ...draft, variables })} />
      </div>
      {save.error && <p className="text-sm text-ox-danger">{errorText(save.error, "Could not save")}</p>}
      <Button
        type="submit"
        disabled={save.isPending || (!template && !draft.name)}
        className="h-9 rounded-[10px] font-heading text-[13px] font-semibold"
      >
        {save.isPending ? "Saving…" : template ? `Save as v${template.version + 1}` : "Create template"}
      </Button>
    </form>
  );
}

function TemplateDetail({ apiKey, name, onDeleted }: { apiKey: string; name: string; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [version, setVersion] = useState<number | null>(null);
  const versions = useQuery({
    queryKey: ["dev-templates", apiKey, name, "versions"],
    queryFn: () => devRequest<{ data: Template[] }>(apiKey, `/templates/${name}/versions`),
  });
  const remove = useMutation({
    mutationFn: () => devRequest(apiKey, `/templates/${name}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-templates", apiKey] });
      onDeleted();
    },
  });

  if (versions.isLoading) return <Skeleton className="m-5 h-40" />;
  if (versions.error) return <p className="p-5 text-sm text-ox-danger">{errorText(versions.error, "Could not load template")}</p>;
  const all = [...versions.data!.data].sort((a, b) => b.version - a.version);
  const latest = all[0];
  if (!latest) return null;
  const shown = all.find((t) => t.version === version) ?? latest;

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/6 px-5 py-3">
        <div className="flex-1 font-mono text-[13px] font-semibold">{name}</div>
        <select
          value={shown.version}
          onChange={(e) => setVersion(Number(e.target.value))}
          className="h-8 rounded-lg border border-white/8 bg-white/3 px-2 text-[12px]"
        >
          {all.map((t) => (
            <option key={t.version} value={t.version}>
              v{t.version} · {when(t.createdAt)}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="ghost"
          onClick={() => window.confirm(`Delete ${name} and all ${all.length} versions?`) && remove.mutate()}
          className="h-8 gap-1.5 rounded-lg text-xs text-ox-danger"
        >
          <Trash2 className="size-3.5" /> Delete
        </Button>
      </div>
      <Editor key={`${name}:${latest.version}`} apiKey={apiKey} template={latest} onSaved={() => setVersion(null)} />
      <PreviewAndTest key={`${name}:${shown.version}`} apiKey={apiKey} template={shown} />
    </Panel>
  );
}

function Templates({ apiKey }: { apiKey: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ["dev-templates", apiKey],
    queryFn: () => devRequest<{ data: Template[]; nextCursor: string | null }>(apiKey, "/templates?limit=100"),
  });

  return (
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      <div className="space-y-2">
        <Button
          type="button"
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
          className="h-9 w-full gap-1.5 rounded-[10px] font-heading text-[13px] font-semibold"
        >
          <Plus className="size-4" /> New template
        </Button>
        {list.isLoading && <Skeleton className="h-24" />}
        {list.error && <p className="text-sm text-ox-danger">{errorText(list.error, "Could not load templates")}</p>}
        {list.data?.data.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => {
              setSelected(t.name);
              setCreating(false);
            }}
            className={`block w-full rounded-[10px] border px-3 py-2 text-left ${
              selected === t.name ? "border-ox/50 bg-ox/6" : "border-white/7 hover:border-white/15"
            }`}
          >
            <div className="truncate font-mono text-[12.5px] font-semibold">{t.name}</div>
            <div className="text-[11px] text-[#7C838F]">
              v{t.version} · {t.variables.length} variable{t.variables.length === 1 ? "" : "s"}
            </div>
          </button>
        ))}
      </div>
      <div>
        {creating && (
          <Panel>
            <Editor
              apiKey={apiKey}
              template={null}
              onSaved={(name) => {
                setCreating(false);
                setSelected(name);
              }}
            />
          </Panel>
        )}
        {selected && <TemplateDetail key={selected} apiKey={apiKey} name={selected} onDeleted={() => setSelected(null)} />}
        {!creating && !selected && list.data && (
          <PanelEmpty
            title={list.data.data.length ? "Pick a template" : "No templates yet"}
            desc="Templates are versioned per domain. Send one with template + variables on /dev/v1/messages."
          />
        )}
      </div>
    </div>
  );
}

export function DevTemplatesPage() {
  return (
    <PageContainer>
      <PageHeader title="Templates" description="Versioned email templates with typed variables, previews and test sends." />
      <DevTabs />
      <DomainKeyGate need="templates">{(key) => <Templates apiKey={key} />}</DomainKeyGate>
    </PageContainer>
  );
}
