import { Link, useRouterState } from "@tanstack/react-router";
import DOMPurify from "dompurify";
import { KeyRound, LogOut } from "lucide-react";
import { useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { frameDocument } from "@/components/MessageFrame.policy";
import { Panel } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiRequestError } from "@/lib/api";

// The message log, templates and webhooks live on /dev/v1 and act on exactly
// one domain, so these pages borrow a domain key for the tab's lifetime.
const STORAGE_KEY = "boxox.devDomainKey";
const listeners = new Set<() => void>();

function readKey(): string | null {
  return sessionStorage.getItem(STORAGE_KEY);
}

export function setDomainKey(value: string | null) {
  if (value) sessionStorage.setItem(STORAGE_KEY, value);
  else sessionStorage.removeItem(STORAGE_KEY);
  listeners.forEach((l) => l());
}

export function useDomainKey(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readKey,
  );
}

export async function devRequest<T>(
  key: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/dev/v1${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) {
    if (res.status === 401) setDomainKey(null);
    throw new ApiRequestError(res.status, json.error?.code ?? "unknown", json.error?.message ?? `Request failed (${res.status})`);
  }
  return json as T;
}

export function errorText(err: unknown, fallback: string) {
  return err instanceof ApiRequestError ? err.message : fallback;
}

export function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

const TABS = [
  { to: "/developer/keys", label: "Keys" },
  { to: "/developer/messages", label: "Messages" },
  { to: "/developer/templates", label: "Templates" },
  { to: "/developer/webhooks", label: "Webhooks" },
] as const;

export function DevTabs() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="mb-5 flex gap-1 border-b border-white/7">
      {TABS.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold ${
            path === t.to ? "border-ox text-foreground" : "border-transparent text-[#7C838F] hover:text-foreground"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

/** Asks for a bxk_ key when none is held, else renders the page with it. */
export function DomainKeyGate({ need, children }: { need: string; children: (key: string) => ReactNode }) {
  const key = useDomainKey();
  const [draft, setDraft] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setDomainKey(draft.trim());
    setDraft("");
  }

  if (!key) {
    return (
      <Panel>
        <form onSubmit={onSubmit} className="space-y-3 p-5">
          <div className="flex items-center gap-2 font-heading text-[14px] font-bold">
            <KeyRound className="size-4 text-[#7C838F]" /> Use a domain key
          </div>
          <p className="max-w-[520px] text-[12.5px] leading-[1.55] text-[#7C838F]">
            This page reads one domain at a time through the developer API. Paste a <code className="font-mono">bxk_</code>{" "}
            key with the <code className="font-mono">{need}</code> permission. It is kept in this tab only and forgotten when the
            tab closes.
          </p>
          <div className="flex gap-2">
            <Input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="bxk_…"
              autoComplete="off"
              className="h-10 max-w-[420px] rounded-[10px] bg-white/3 font-mono text-[13px]"
            />
            <Button type="submit" disabled={!draft.trim().startsWith("bxk_")} className="h-10 rounded-[10px] font-heading text-[13px] font-semibold">
              Use key
            </Button>
          </div>
        </form>
      </Panel>
    );
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-end gap-2 text-[11.5px] text-[#7C838F]">
        Using <code className="font-mono">{key.slice(0, 8)}…{key.slice(-4)}</code>
        <Button type="button" variant="ghost" onClick={() => setDomainKey(null)} className="h-7 gap-1 rounded-lg px-2 text-[11.5px] text-[#9BA1AD]">
          <LogOut className="size-3" /> Forget
        </Button>
      </div>
      {children(key)}
    </>
  );
}

/**
 * Rendered mail HTML, sanitized and inside a script-less sandbox. The frame
 * carries the same CSP the inbox message frame uses (MessageFrame.policy.ts),
 * so remote images never load here even when a template variable smuggles
 * one in; the attribute stripping below is only a second layer.
 */
export function HtmlPreview({ html, minHeight = 260 }: { html: string; minHeight?: number }) {
  const doc = useMemo(() => {
    const safe = DOMPurify.sanitize(html, {
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "meta", "base", "link", "svg", "math"],
      FORBID_ATTR: ["srcset", "srcdoc", "action", "formaction", "background", "ping"],
    }).replace(/\s(src|href)="(?:https?:)?\/\/[^"]*"/gi, (_m, attr: string) => (attr.toLowerCase() === "src" ? ' src="" data-blocked-remote="true"' : ""));
    return frameDocument(safe, { origin: window.location.origin, showRemote: false });
  }, [html]);
  return <iframe sandbox="" title="preview" referrerPolicy="no-referrer" className="w-full rounded-lg bg-white" style={{ minHeight }} srcDoc={doc} />;
}

export function StatusPill({ status }: { status: string }) {
  const tone: Record<string, string> = {
    sent: "#4FC08D",
    delivered: "#4FC08D",
    succeeded: "#4FC08D",
    active: "#4FC08D",
    queued: "#9BA1AD",
    pending: "#9BA1AD",
    scheduled: "#6EA8FE",
    deferred: "#F2B33D",
    canceled: "#7C838F",
    disabled: "#7C838F",
  };
  const color = tone[status] ?? "#F06A6A";
  return (
    <span className="rounded-full border px-2 py-px font-mono text-[11px]" style={{ color, borderColor: `${color}55` }}>
      {status}
    </span>
  );
}
