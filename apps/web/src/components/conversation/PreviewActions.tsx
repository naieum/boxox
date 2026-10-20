import { useMe } from "@/AppShell";
import type { ComponentProps } from "react";
import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import type { Conversation } from "./api";
import { previewLinks, type PreviewConfirmation } from "./preview";

const button = "rounded-md border border-white/14 bg-white/4 px-3 py-2 text-xs font-semibold hover:bg-white/8 disabled:opacity-50";
const headers = { "Content-Type": "application/json", "x-boxox-csrf": "1" };

async function responseError(res: Response): Promise<Error> {
  const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
  return new Error(body?.error?.message ?? `Request failed (${res.status})`);
}

/** Requests happen in click handlers only; opening a conversation never starts Browser Run. */
function PreviewActionsEditor({ orgId, conversation }: { orgId: string; conversation: Conversation }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<PreviewConfirmation | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const links = useMemo(
    () => previewLinks(conversation.messages.flatMap((m) => [m.html, m.quotedHtml])),
    [conversation.messages],
  );
  useEffect(() => () => { if (screenshot) URL.revokeObjectURL(screenshot); }, [screenshot]);
  const base = `/api/orgs/${encodeURIComponent(orgId)}/preview`;

  async function ask(token: string) {
    setPending(true);
    setError(null);
    setScreenshot(null);
    setConfirmation(null);
    try {
      const res = await fetch(`${base}/link`, { method: "POST", headers, body: JSON.stringify({ token }) });
      if (res.status !== 428) throw await responseError(res);
      const body = await res.json() as { preview: Omit<PreviewConfirmation, "token"> };
      setConfirmation({ ...body.preview, token });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The preview could not be prepared.");
    } finally {
      setPending(false);
    }
  }

  async function visit() {
    if (!confirmation || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`${base}/link`, {
        method: "POST", headers, body: JSON.stringify({ token: confirmation.token, confirm: true }),
      });
      if (!res.ok) throw await responseError(res);
      setScreenshot(URL.createObjectURL(await res.blob()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The preview could not be rendered.");
    } finally {
      setPending(false);
    }
  }

  async function exportPdf() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`${base}/threads/${encodeURIComponent(conversation.thread.id)}/pdf`, { method: "POST", headers });
      if (!res.ok) throw await responseError(res);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(conversation.thread.subject || "conversation").replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 100)}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The PDF could not be exported.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <button type="button" className={`${button} inline-flex items-center gap-1.5`} disabled={pending} onClick={exportPdf}>
          <Download className="size-3.5" aria-hidden="true" /> Export PDF
        </button>
        {links.length > 0 && (
          <details className="min-w-0 max-w-full text-xs">
            <summary className={`${button} cursor-pointer`}>Preview a link ({links.length})</summary>
            <ul className="mt-2 max-h-60 space-y-2 overflow-auto rounded-lg border border-white/10 p-3">
              {links.map((link) => (
                <li key={link.token}>
                  <button type="button" disabled={pending} onClick={() => ask(link.token)} className="break-all text-left text-[#9DCFFF] underline hover:text-foreground disabled:opacity-50">
                    {link.url}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {confirmation && (
        <section aria-label="Link preview" className="space-y-3 rounded-lg border border-white/14 bg-white/4 p-4 text-[13px]">
          <h2 className="font-semibold">{screenshot ? "Link preview" : "Visit this link to create a preview?"}</h2>
          <p className="break-all">{confirmation.url}</p>
          {confirmation.flagged && <p className="text-[#F2B33D]">This link is from a message flagged as suspicious.</p>}
          <p className="text-[#C9CFD8]">{confirmation.warning}</p>
          {screenshot && <img src={screenshot} alt={`Screenshot of ${confirmation.url}`} className="max-h-[600px] max-w-full rounded bg-white object-contain" />}
          <div className="flex flex-wrap gap-2">
            {!screenshot && <button type="button" className={button} disabled={pending} onClick={visit}>Visit and preview</button>}
            <button type="button" className={button} disabled={pending} onClick={() => { setConfirmation(null); setScreenshot(null); setError(null); }}>
              {screenshot ? "Close preview" : "Cancel"}
            </button>
          </div>
        </section>
      )}
      {pending && <p role="status" className="text-xs text-[#9BA1AD]">Preparing…</p>}
      {error && <p role="alert" className="text-xs text-ox-danger">{error}</p>}
    </div>
  );
}

export function PreviewActions(props: ComponentProps<typeof PreviewActionsEditor>) {
  const me = useMe();
  if (me.data?.capabilities?.browser === false) return null;
  return <PreviewActionsEditor {...props} />;
}
