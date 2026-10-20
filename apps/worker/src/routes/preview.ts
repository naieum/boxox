import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { messages, threads } from "@boxox/db";
import { log } from "../log";
import { requireOrgMember, type AppContext } from "../middleware";
import { accessibleAddressIds } from "../services/access";
import { detectType } from "../services/attachments";
import { proxyableUrl } from "./image-proxy";
import { escapeHtml, prepareMailHtml, verifyLinkToken } from "./link";
import { attachmentContentDisposition } from "./threads";

/**
 * Browser Run quick actions, on demand only. Nothing here runs from ingest,
 * the thread view or the link route: a preview is a POST the SPA sends when
 * the reader clicks "Preview" (so requireSameOrigin applies), and it needs
 * `confirm: true` after the reader has seen PREVIEW_WARNING. Visiting a URL is
 * not harmless: a GET can unsubscribe, sign someone in or confirm an action.
 *
 * Only links this mailbox signed (/api/link tokens) can be previewed, so the
 * route is never an open fetcher. PDF export renders the thread's sanitized
 * HTML with JavaScript off and every network request blocked, so nothing in
 * the mail can call out while it prints.
 */

export const PREVIEW_WARNING =
  "Previewing opens this link in a remote browser. Visiting a link can trigger one-click actions such as unsubscribing, confirming a request or signing in with a magic link, even if you never click anything on the page. Only preview links you would be willing to open.";

export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
export const PDF_MAX_BYTES = 20 * 1024 * 1024;
const PDF_MAX_MESSAGES = 200;
const PDF_MAX_HTML = 4 * 1024 * 1024;
const NAV_TIMEOUT_MS = 15_000;
const PREVIEW_TYPES = new Set(["image/webp", "image/png", "image/jpeg"]);

/** No subresource may leave the browser while a PDF renders; data: and about: stay usable. */
const PDF_BLOCKED_REQUESTS = ["^https?:", "^wss?:", "^ftp:", "^blob:", "^file:"];
const PDF_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

const linkPreviewSchema = z.object({ token: z.string().min(1).max(4096), confirm: z.boolean().optional() });

function accessorOf(c: { get: (k: "user" | "orgRole") => unknown }) {
  const user = c.get("user") as { id: string; email: string };
  return { userId: user.id, email: user.email, role: c.get("orgRole") as string };
}

const errorJson = (c: Context<AppContext>, status: 400 | 403 | 404 | 413 | 502 | 503, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

async function readLimited(res: Response, limit: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") ?? 0) > limit) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// A preview may load this origin only, including redirects and subresources.
// Cross-origin trackers and redirects to an internal host are never followed.
const previewRequestPattern = (url: URL) => `^${url.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`;

interface PdfMessage {
  fromEmail: string;
  fromName: string | null;
  toEmails: unknown;
  ccEmails: unknown;
  occurredAt: Date;
  html: string | null;
  text: string | null;
}

const emails = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The printable thread: escaped headers, sanitized bodies, a CSP that forbids loading anything. */
export function threadPdfHtml(subject: string, msgs: PdfMessage[], omitted = 0): string {
  const parts = msgs.map((m) => {
    const from = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
    const to = emails(m.toEmails).join(", ");
    const cc = emails(m.ccEmails).join(", ");
    const body = m.html ?? (m.text ? `<pre>${escapeHtml(m.text)}</pre>` : "<p><em>No readable body</em></p>");
    return `<section class="msg"><dl><dt>From</dt><dd>${escapeHtml(from)}</dd>${to ? `<dt>To</dt><dd>${escapeHtml(to)}</dd>` : ""}${cc ? `<dt>Cc</dt><dd>${escapeHtml(cc)}</dd>` : ""}<dt>Date</dt><dd>${escapeHtml(m.occurredAt.toUTCString())}</dd></dl><div class="body">${body}</div></section>`;
  });
  const more = omitted > 0 ? `<p class="more">${omitted} more message${omitted === 1 ? "" : "s"} not included.</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PDF_CSP}"><title>${escapeHtml(subject)}</title><style>body{font-family:system-ui,sans-serif;font-size:12px;color:#111;margin:0}h1{font-size:18px;margin:0 0 16px}.msg{border-top:1px solid #ccc;padding:12px 0;break-inside:auto}dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 8px;margin:0 0 10px;color:#444}dt{font-weight:600}dd{margin:0;word-break:break-all}pre{white-space:pre-wrap;font-family:inherit}img{max-width:100%}.more{color:#666}</style></head><body><h1>${escapeHtml(subject || "(no subject)")}</h1>${parts.join("")}${more}</body></html>`;
}

export const previewRoutes = new Hono<AppContext>()
  .use("*", async (c, next) => {
    c.header("cache-control", "no-store, private");
    await next();
  })
  .use("*", requireOrgMember)

  /**
   * POST /link { token, confirm }. Without confirm: true, nothing is visited;
   * the reply is 428 with the warning and the real destination for the
   * confirmation dialog. With it, Browser Run takes one screenshot.
   */
  .post("/link", async (c) => {
    const parsed = linkPreviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return errorJson(c, 400, "bad_request", "Expected { token, confirm }");
    const link = await verifyLinkToken(c.env, parsed.data.token);
    if (!link) return errorJson(c, 403, "forbidden", "Only links from your own mail can be previewed");
    const url = new URL(link.u);
    if (!proxyableUrl(url)) return errorJson(c, 400, "host_not_allowed", "This link's host can't be previewed");

    const destination = { url: url.href, host: url.hostname, flagged: link.w === 1 };
    if (parsed.data.confirm !== true) {
      return c.json(
        { error: { code: "confirmation_required", message: PREVIEW_WARNING }, preview: { ...destination, warning: PREVIEW_WARNING } },
        428,
      );
    }
    if (!c.env.BROWSER) return errorJson(c, 503, "browser_unavailable", "Link previews need the Browser Run binding (BROWSER)");

    let res: Response;
    try {
      // A fresh browser: no cookies, credentials or headers from the reader.
      res = await c.env.BROWSER.quickAction("screenshot", {
        url: url.href,
        viewport: { width: 1280, height: 800 },
        screenshotOptions: { type: "webp", quality: 70 },
        gotoOptions: { waitUntil: "load", timeout: NAV_TIMEOUT_MS },
        setJavaScriptEnabled: false,
        allowRequestPattern: [previewRequestPattern(url)],
        bestAttempt: true,
        cacheTTL: 0,
      });
    } catch (error) {
      log.error("link_preview_failed", { errorType: error instanceof Error ? error.name : "unknown" });
      return errorJson(c, 502, "preview_failed", "The preview could not be rendered");
    }
    if (!res.ok) {
      await res.body?.cancel();
      return errorJson(c, 502, "preview_failed", "The preview could not be rendered");
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readLimited(res, PREVIEW_MAX_BYTES);
    } catch {
      return errorJson(c, 502, "preview_failed", "The preview could not be read");
    }
    if (!bytes) return errorJson(c, 413, "too_large", "The preview is too large");
    const type = detectType(bytes);
    if (!PREVIEW_TYPES.has(type)) return errorJson(c, 502, "preview_failed", "The preview could not be rendered");

    return new Response(bytes, {
      headers: {
        "content-type": type,
        "content-length": String(bytes.byteLength),
        "content-disposition": 'inline; filename="preview"',
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  })

  // POST /threads/:threadId/pdf. The whole thread as one PDF download.
  .post("/threads/:threadId/pdf", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const threadId = c.req.param("threadId");
    const [thread] = await db
      .select()
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.organizationId, orgId)))
      .limit(1);
    if (!thread) return errorJson(c, 404, "not_found", "No such thread");
    const readable = await accessibleAddressIds(db, orgId, accessorOf(c), "read");
    if (readable !== null && (!thread.addressId || !readable.includes(thread.addressId))) {
      return errorJson(c, 403, "forbidden", "No access to this mailbox");
    }
    if (!c.env.BROWSER) return errorJson(c, 503, "browser_unavailable", "PDF export needs the Browser Run binding (BROWSER)");

    const rows = await db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(messages.occurredAt);
    const included: PdfMessage[] = [];
    let size = 0;
    for (const m of rows.slice(0, PDF_MAX_MESSAGES)) {
      let html: string | null = null;
      let text: string | null = null;
      const obj = await c.env.MAIL_STORE.get(m.r2Key);
      if (obj) {
        try {
          const raw = (await obj.json()) as { data?: { html?: string | null; text?: string | null }; html?: string | null; text?: string | null };
          html = raw.data?.html ?? raw.html ?? null;
          text = raw.data?.text ?? raw.text ?? null;
          if (html) html = await prepareMailHtml(c.env, html, { links: "disabled" });
        } catch {
          // body unreadable; the headers still print
        }
      }
      size += new TextEncoder().encode(html ?? text ?? "").byteLength;
      if (size > PDF_MAX_HTML) break;
      included.push({ ...m, html, text });
    }

    let res: Response;
    try {
      res = await c.env.BROWSER.quickAction("pdf", {
        html: threadPdfHtml(thread.subject, included, rows.length - included.length),
        setJavaScriptEnabled: false,
        rejectRequestPattern: PDF_BLOCKED_REQUESTS,
        pdfOptions: { format: "a4", printBackground: true, margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" } },
        cacheTTL: 0,
      });
    } catch (error) {
      log.error("pdf_export_failed", { errorType: error instanceof Error ? error.name : "unknown" });
      return errorJson(c, 502, "pdf_failed", "The PDF could not be rendered");
    }
    if (!res.ok) {
      await res.body?.cancel();
      return errorJson(c, 502, "pdf_failed", "The PDF could not be rendered");
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readLimited(res, PDF_MAX_BYTES);
    } catch {
      return errorJson(c, 502, "pdf_failed", "The PDF could not be read");
    }
    if (!bytes) return errorJson(c, 413, "too_large", "The PDF is too large");
    if (detectType(bytes) !== "application/pdf") return errorJson(c, 502, "pdf_failed", "The PDF could not be rendered");

    const name = `${(thread.subject || "thread").slice(0, 100)}.pdf`;
    return new Response(bytes, {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
        "content-disposition": attachmentContentDisposition(name),
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });
