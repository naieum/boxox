/**
 * The message frame's rules, kept free of DOM and React so the Worker's tests
 * can check them (apps/worker/test/safe-render.test.ts).
 *
 * The frame is sandboxed without allow-scripts or allow-same-origin, so mail
 * gets an opaque origin and no script at all; popups may open (and escape the
 * sandbox) so signed links work in a new tab. Its own CSP allows no script,
 * no forms, and images only from inline data, our attachment route and, once
 * the reader allows them, the image proxy. Remote images are never loaded
 * directly, so a missed tracking pixel still can't reach its sender.
 */
export const FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

export const IMAGE_PROXY_PATH = "/api/image-proxy/";
export const LINK_PATH = "/api/link/";

export function frameCsp(origin: string, showRemote: boolean): string {
  const images = ["data:", `${origin}/api/orgs/`, ...(showRemote ? [`${origin}${IMAGE_PROXY_PATH}`] : [])];
  return [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "style-src 'unsafe-inline'",
    "font-src data:",
    `img-src ${images.join(" ")}`,
  ].join("; ");
}

/** The signed proxy path the server put in data-boxox-src; anything else is ignored. */
export function proxiedImageSrc(value: string | null): string | null {
  return value && value.startsWith(IMAGE_PROXY_PATH) && /^[\w./-]+$/.test(value) ? value : null;
}

/** True when the server held back remote images for this HTML. */
export function hasBlockedImages(html: string): boolean {
  return html.includes(`data-boxox-src="${IMAGE_PROXY_PATH}`);
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** srcdoc for already-sanitized HTML. The CSP meta comes first, before anything mail could add. */
export function frameDocument(safeHtml: string, opts: { origin: string; showRemote: boolean }): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${attr(frameCsp(opts.origin, opts.showRemote))}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${safeHtml}</body></html>`;
}
