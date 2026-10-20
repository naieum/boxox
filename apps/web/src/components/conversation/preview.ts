export interface PreviewLink {
  token: string;
  url: string;
}

/** Read signed link destinations without mounting mail in a document or visiting it. */
export function previewLinks(bodies: (string | null)[]): PreviewLink[] {
  const links = new Map<string, PreviewLink>();
  for (const html of bodies) {
    for (const match of (html ?? "").matchAll(/\bhref=["']\/api\/link\/([\w.-]+)["']/g)) {
      const token = match[1]!;
      try {
        const body = token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/");
        const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))) as { u?: unknown };
        if (typeof payload.u !== "string") continue;
        const url = new URL(payload.u);
        if (url.protocol !== "https:" && url.protocol !== "http:") continue;
        // Display only. The Worker verifies the signature before confirming or visiting.
        if (!links.has(url.href)) links.set(url.href, { token, url: url.href });
      } catch {
        // Invalid tokens never become preview controls.
      }
    }
  }
  return [...links.values()];
}

export interface PreviewConfirmation extends PreviewLink {
  warning: string;
  flagged: boolean;
}
