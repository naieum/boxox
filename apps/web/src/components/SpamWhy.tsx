import { useState } from "react";

/** The stored verdict JSON (messages.spam_verdict), as the worker's combiner writes it. */
export interface SpamVerdict {
  combiner?: {
    folder: "inbox" | "spam" | "quarantine";
    probability: number;
    phishing: number;
    weights: "ai" | "ai-free";
    fallback: string | null;
    hardRule: "blocked-sender" | "wrote-to-sender" | null;
    contributions: { feature: string; value: number; weight: number; contribution: number }[];
    phishingSignals: string[];
  };
  ai?: { status: string; model?: string; reason?: string | null; reasons?: string[]; category?: string };
  layer1?: { score?: number; signals?: { id: string; weight: number; detail?: string }[] };
  [key: string]: unknown;
}

const FEATURE_LABELS: Record<string, string> = {
  bias: "Starting point",
  rules: "Header and structure rules",
  links: "Linked domains on block lists",
  bayes: "Learned from your spam / not-spam choices",
  reputation: "Your history with this sender",
  knn: "Similar mail you labelled",
  ai_spam: "AI: spam score",
  ai_phishing: "AI: phishing score",
  ai_impersonation: "AI: impersonation score",
  ai_injection: "AI: instructions aimed at an AI",
};

const FALLBACKS: Record<string, string> = {
  "budget-spent": "Today's AI budget was used up, so only the non-AI checks decided.",
  "ai-off": "AI is off, so only the non-AI checks decided.",
  "address-opted-out": "AI is turned off for this address.",
  "provider-not-consented": "The AI model needs a provider you haven't allowed.",
  "no-model": "No AI model is chosen for spam checks.",
  certain: "The non-AI checks were already certain, so AI wasn't asked.",
  "hard-rule": "A fixed rule decided before any scoring.",
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

function fallbackText(fallback: string): string {
  if (fallback.startsWith("unscanned:")) return "The AI check failed and will be retried; only the non-AI checks decided for now.";
  return FALLBACKS[fallback] ?? fallback;
}

/** "Why is this in spam?": every signal and probability behind the folder decision. */
export function SpamWhy({ verdict, folder }: { verdict: SpamVerdict | null; folder: string }) {
  const [open, setOpen] = useState(false);
  const c = verdict?.combiner;
  const label = folder === "quarantine" ? "Why is this in Quarantine?" : folder === "spam" ? "Why is this in spam?" : "Spam check details";
  if (!c) {
    return folder === "spam" || folder === "quarantine" ? (
      <p className="text-xs text-[#7c838f]">This was moved here by a rule or by hand; there is no spam score for it.</p>
    ) : null;
  }
  const signals = verdict?.layer1?.signals ?? [];
  const reasons = verdict?.ai?.status === "scanned" ? (verdict.ai.reasons ?? []) : [];
  const rows = [...c.contributions].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] text-[12.5px]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full px-3 py-2 text-left font-semibold text-[#C4CAD4] hover:text-foreground">
        {label}
      </button>
      {open && (
        <div className="space-y-3 border-t border-white/10 px-3 py-3 text-[#9BA1AD]">
          <div>
            Spam {pct(c.probability)} · phishing {pct(c.phishing)} · {c.weights === "ai" ? "AI and non-AI checks" : "non-AI checks only"}
          </div>
          {c.hardRule === "blocked-sender" && <div>You blocked this sender, so their mail always goes to Spam.</div>}
          {c.hardRule === "wrote-to-sender" && <div>You have written to this sender, so their mail always goes to your inbox.</div>}
          {c.fallback && c.weights === "ai-free" && <div>{fallbackText(c.fallback)}</div>}
          {c.folder === "quarantine" && <div>Phishing signs: {c.phishingSignals.join(", ") || "AI phishing score"}.</div>}
          <table className="w-full">
            <thead>
              <tr className="text-left text-[11px] uppercase text-[#7c838f]">
                <th className="font-medium">Input</th>
                <th className="text-right font-medium">Value</th>
                <th className="text-right font-medium">Weight</th>
                <th className="text-right font-medium">Effect</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.feature}>
                  <td>{FEATURE_LABELS[r.feature] ?? r.feature}</td>
                  <td className="text-right tabular-nums">{r.value.toFixed(2)}</td>
                  <td className="text-right tabular-nums">{r.weight.toFixed(2)}</td>
                  <td className={`text-right tabular-nums ${r.contribution > 0 ? "text-[#F2B33D]" : "text-[#3DA5F4]"}`}>
                    {r.contribution > 0 ? "+" : ""}
                    {r.contribution.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {signals.length > 0 && (
            <div>
              <div className="mb-1 font-semibold text-[#C4CAD4]">Signals</div>
              <ul className="space-y-0.5">
                {signals.map((s, i) => (
                  <li key={i}>
                    {s.id} ({s.weight > 0 ? "+" : ""}
                    {s.weight}){s.detail ? ` · ${s.detail}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {reasons.length > 0 && (
            <div>
              {/* Written by the model from the mail itself; shown as plain text only. */}
              <div className="mb-1 font-semibold text-[#C4CAD4]">AI reasons</div>
              <ul className="list-disc pl-4">
                {reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
