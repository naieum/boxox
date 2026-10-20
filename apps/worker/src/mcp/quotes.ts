/**
 * Plain-text quote removal for agent reads: `get_thread` hands agents each
 * message's new text only, since the earlier messages are already in the thread.
 * Cuts at the first reply header ("On … wrote:", Outlook's "-----Original
 * Message-----" or "From:/Sent:" block, a forwarded-message rule) and drops
 * any remaining ">"-quoted lines.
 */
const CUT_MARKERS = [
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,
  /^Begin forwarded message:\s*$/i,
];

const ON_WROTE = /^On\b.{0,300}\bwrote:\s*$/i;

function isOutlookHeader(lines: string[], i: number): boolean {
  if (!/^From:\s/i.test(lines[i]!)) return false;
  const next = lines.slice(i + 1, i + 5);
  return next.some((l) => /^(Sent|Date):\s/i.test(l)) && next.some((l) => /^(To|Subject):\s/i.test(l));
}

export function stripQuotedText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (CUT_MARKERS.some((re) => re.test(trimmed)) || isOutlookHeader(lines, i)) break;
    if (ON_WROTE.test(trimmed)) break;
    // Gmail wraps a long attribution over two lines: "On Mon, … <" / "a@b.example> wrote:".
    if (/^On\b/i.test(trimmed) && /\bwrote:\s*$/i.test(lines[i + 1]?.trim() ?? "")) break;
    if (/^>/.test(trimmed)) continue;
    kept.push(line);
  }
  return kept.join("\n").trimEnd();
}
