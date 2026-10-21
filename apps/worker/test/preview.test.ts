import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { messages } from "@boxox/db";
import { createDb } from "../src/db";
import { CSRF_HEADER, requireSameOrigin, type AppContext, type SessionUser } from "../src/middleware";
import { linkRoutes, signLinkToken, urlSigningKey } from "../src/routes/link";
import { PREVIEW_MAX_BYTES, PDF_MAX_BYTES, PREVIEW_WARNING, previewRoutes, threadPdfHtml } from "../src/routes/preview";
import { threadRoutes } from "../src/routes/threads";
import { previewLinks } from "../../web/src/components/conversation/preview";
import { id, messageRow, seedMailbox, seedThread } from "./helpers/seed";

/**
 * Browser Run link previews and PDF export on real D1 and R2, with a recording
 * fake for the BROWSER binding. A preview is a visit, and a visit can click a
 * one-click link, so the browser must only ever run when the reader asks.
 */
const SECRET = "test-only-preview-secret-not-real-00000000";
const ORIGIN = "https://mail.example.test";
const db = createDb(env);
const OWNER: SessionUser = { id: "owner@example.test", email: "owner@example.test", name: "Owner", role: "owner" };
const MEMBER: SessionUser = { id: "guest@example.test", email: "guest@example.test", name: "Guest", role: "member" };

const WEBP = Uint8Array.from([...new TextEncoder().encode("RIFF"), 0x24, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 "), 0, 0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%fake\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

type Call = { action: string; options: Record<string, unknown> };

function fakeBrowser(reply: () => Response = () => new Response(WEBP, { headers: { "content-type": "image/webp" } })) {
  const calls: Call[] = [];
  const browser = {
    async quickAction(action: string, options: Record<string, unknown>) {
      calls.push({ action, options });
      return reply();
    },
    async fetch() {
      throw new Error("sessions are not used");
    },
  };
  return { calls, browser: browser as unknown as BrowserRun };
}

let user = OWNER;
const app = new Hono<AppContext>()
  .use("*", requireSameOrigin)
  .use("*", async (c, next) => {
    c.set("db", createDb(c.env));
    c.set("user", user);
    await next();
  })
  .route("/api/link", linkRoutes)
  .route("/api/orgs/:orgId/threads", threadRoutes)
  .route("/api/orgs/:orgId/preview", previewRoutes);

let mailbox: { orgId: string; addressId: string };

function call(path: string, opts: { method?: string; body?: unknown; browser?: BrowserRun | null; headers?: Record<string, string> } = {}) {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> =
    method === "GET" ? {} : { "content-type": "application/json", origin: ORIGIN, [CSRF_HEADER]: "1", ...opts.headers };
  const bindings = { ...env, BOXOX_SIGNING_SECRET: SECRET, BROWSER: opts.browser ?? undefined };
  return app.request(
    `${ORIGIN}${path}`,
    { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: "manual" },
    bindings,
  );
}

const preview = (body: unknown, browser?: BrowserRun | null, headers?: Record<string, string>) =>
  call(`/api/orgs/${mailbox.orgId}/preview/link`, { body, browser, headers });

async function linkToken(url: string, warn = false) {
  const key = await urlSigningKey({ BOXOX_SIGNING_SECRET: SECRET }, "boxox:link:v1");
  return (await signLinkToken(key!, url, warn))!;
}

async function seedHtmlThread(html: string, subject = "Your weekly digest") {
  const threadId = await seedThread(db, mailbox, { subject });
  const row = messageRow(mailbox, threadId, { subject, fromName: "Digest", fromEmail: "news@ext.test", toEmails: ["me@box.test"] });
  await db.insert(messages).values(row);
  await env.MAIL_STORE.put(row.r2Key, JSON.stringify({ data: { html, text: null } }));
  return threadId;
}

beforeAll(async () => {
  mailbox = await seedMailbox(db, { orgId: `org-${id()}` });
});

describe("link previews", () => {
  it("previews only run when the user asks", async () => {
    const { calls, browser } = fakeBrowser();
    const threadId = await seedHtmlThread('<p>Hi</p><p><a href="https://news.example.com/unsubscribe?u=42">Unsubscribe</a></p>');

    // Opening the thread and following the link never starts a browser.
    const thread = await call(`/api/orgs/${mailbox.orgId}/threads/${threadId}`, { method: "GET", browser });
    expect(thread.status).toBe(200);
    const body = (await thread.json()) as { messages: { html: string }[] };
    const token = /href="\/api\/link\/([^"]+)"/.exec(body.messages[0]!.html)?.[1];
    expect(token).toBeTruthy();
    const followed = await call(`/api/link/${token}`, { method: "GET", browser });
    expect(followed.status).toBe(302);
    expect(calls).toHaveLength(0);

    // Asking without confirming, or confirming anything but true, visits nothing.
    expect((await preview({ token }, browser)).status).toBe(428);
    expect((await preview({ token, confirm: false }, browser)).status).toBe(428);
    expect((await preview({ token, confirm: "yes" }, browser)).status).toBe(400);
    // A cross-site page can't trigger one for the reader.
    expect((await preview({ token, confirm: true }, browser, { origin: "https://evil.example" })).status).toBe(403);
    expect((await preview({ token, confirm: true }, browser, { [CSRF_HEADER]: "" })).status).toBe(403);
    // GET does not exist: a preview is never a side effect of loading something.
    expect((await call(`/api/orgs/${mailbox.orgId}/preview/link?token=${token}&confirm=true`, { method: "GET", browser })).status).toBe(404);
    // Unsigned or altered links are refused before any visit.
    expect((await preview({ token: `${token}x`, confirm: true }, browser)).status).toBe(403);
    const forged = btoa(JSON.stringify({ u: "https://evil.example/" })).replace(/=+$/, "");
    expect((await preview({ token: `${forged}.${token!.split(".")[1]}`, confirm: true }, browser)).status).toBe(403);
    expect(calls).toHaveLength(0);

    // The reader confirms: exactly one screenshot of that exact URL, in a clean browser.
    const res = await preview({ token, confirm: true }, browser);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBP);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toBe("screenshot");
    expect(calls[0]!.options.url).toBe("https://news.example.com/unsubscribe?u=42");
    expect(calls[0]!.options.setJavaScriptEnabled).toBe(false);
    expect(calls[0]!.options.cacheTTL).toBe(0);
    const allowed = calls[0]!.options.allowRequestPattern as string[];
    const allows = (url: string) => allowed.some((p) => new RegExp(p).test(url));
    expect(allows("https://news.example.com/style.css")).toBe(true);
    for (const target of ["http://127.0.0.1/", "https://tracker.example/", "https://news.example.com.evil.test/", "https://news.example.com:8443/"]) {
      expect(allows(target)).toBe(false);
    }
    for (const forwarded of ["cookies", "authenticate", "setExtraHTTPHeaders", "addScriptTag", "html"]) {
      expect(calls[0]!.options).not.toHaveProperty(forwarded);
    }

    // Nothing else in the Worker can start Browser Run: only this route calls quickAction.
    const sources = import.meta.glob<string>("../src/**/*.ts", { eager: true, import: "default", query: "?raw" });
    const callers = Object.entries(sources)
      .filter(([, src]) => /quickAction\s*\(|env\.BROWSER|BROWSER\.fetch/.test(src))
      .map(([path]) => path);
    expect(callers).toEqual(["../src/routes/preview.ts"]);
  });

  it("warns that visiting can trigger one-click links", async () => {
    const { calls, browser } = fakeBrowser();
    const token = await linkToken("https://shop.example.com/login?magic=abc123");
    const res = await preview({ token }, browser);
    expect(res.status).toBe(428);
    const body = (await res.json()) as {
      error: { code: string; message: string };
      preview: { url: string; host: string; flagged: boolean; warning: string };
    };
    expect(body.error.code).toBe("confirmation_required");
    expect(body.preview.warning).toBe(PREVIEW_WARNING);
    expect(body.preview.warning).toMatch(/one-click/i);
    expect(body.preview.warning).toMatch(/unsubscrib/i);
    expect(body.preview.warning).toMatch(/magic link/i);
    expect(body.preview.warning).toMatch(/even if you never click/i);
    // The dialog shows where the visit really goes.
    expect(body.preview.url).toBe("https://shop.example.com/login?magic=abc123");
    expect(body.preview.host).toBe("shop.example.com");
    expect(body.preview.flagged).toBe(false);

    // Links from suspicious mail are marked so the dialog can say so too.
    const flagged = (await (await preview({ token: await linkToken("https://phish.example.net/", true) }, browser)).json()) as {
      preview: { flagged: boolean; warning: string };
    };
    expect(flagged.preview.flagged).toBe(true);
    expect(flagged.preview.warning).toMatch(/one-click/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses private hosts, a missing binding and output that is not an image", async () => {
    const { calls, browser } = fakeBrowser();
    expect((await preview({ token: await linkToken("http://192.168.1.1/admin"), confirm: true }, browser)).status).toBe(400);
    expect((await preview({ token: await linkToken("http://localhost:8080/"), confirm: true }, browser)).status).toBe(400);
    expect(calls).toHaveLength(0);

    const token = await linkToken("https://example.com/");
    const missing = await preview({ token, confirm: true }, null);
    expect(missing.status).toBe(503);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("browser_unavailable");

    const html = fakeBrowser(() => new Response("<script>alert(1)</script>", { headers: { "content-type": "image/webp" } }));
    expect((await preview({ token, confirm: true }, html.browser)).status).toBe(502);
    const failed = fakeBrowser(() => Response.json({ success: false, errors: [{ message: "timeout" }] }, { status: 422 }));
    expect((await preview({ token, confirm: true }, failed.browser)).status).toBe(502);
  });

  it("lists signed links without visiting them or mounting message HTML", async () => {
    const token = await linkToken("https://example.com/猫?q=1&lang=ja");
    const html = `<img src="https://tracking.test/open"><script>alert(1)</script><a href="/api/link/${token}">Open</a>`;
    expect(previewLinks([html, html, '<a href="https://direct.test/">Untrusted</a>', null, '<a href="/api/link/invalid">Bad</a>']))
      .toEqual([{ token, url: "https://example.com/%E7%8C%AB?q=1&lang=ja" }]);
  });

  it("cancels a screenshot stream as soon as it exceeds the size limit", async () => {
    let cancelled = false;
    const { browser } = fakeBrowser(() => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(PREVIEW_MAX_BYTES + 1)); },
      cancel() { cancelled = true; },
    })));
    const res = await preview({ token: await linkToken("https://example.com/"), confirm: true }, browser);
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
  });
});

describe("PDF export", () => {
  it("prints the sanitized thread with scripts off and every request blocked", async () => {
    const { calls, browser } = fakeBrowser(() => new Response(PDF, { headers: { "content-type": "application/pdf" } }));
    const threadId = await seedHtmlThread(
      '<p>Invoice ready</p><img src="https://tracker.example/open.gif"><script>alert(1)</script><a href="https://pay.example.com/confirm?one-click=1">Confirm</a><style>@import url(https://evil.example/x.css)</style>',
      'Invoice "42" </title><script>',
    );

    const res = await call(`/api/orgs/${mailbox.orgId}/preview/threads/${threadId}/pdf`, { browser });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Invoice 42 <\/title><script>\.pdf"; filename\*=UTF-8/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);

    expect(calls).toHaveLength(1);
    const { action, options } = calls[0]!;
    expect(action).toBe("pdf");
    expect(options).not.toHaveProperty("url");
    expect(options.setJavaScriptEnabled).toBe(false);
    for (const url of ["https://tracker.example/open.gif", "http://x.test/", "wss://x.test/", "ftp://x.test/"]) {
      expect((options.rejectRequestPattern as string[]).some((p) => new RegExp(p).test(url))).toBe(true);
    }
    expect((options.rejectRequestPattern as string[]).some((p) => new RegExp(p).test("data:image/png;base64,AA"))).toBe(false);

    const html = options.html as string;
    expect(html).toContain("Invoice ready");
    expect(html).toContain(`content="default-src 'none'; img-src data:;`);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('src="https://tracker.example');
    expect(html).not.toContain('href="https://pay.example.com');
    expect(html).toContain("Invoice &quot;42&quot; &lt;/title&gt;&lt;script&gt;");
    expect(html).toContain("Digest &lt;news@ext.test&gt;");
  });

  it("checks mailbox access and the binding before rendering", async () => {
    const { calls, browser } = fakeBrowser(() => new Response(PDF));
    const threadId = await seedHtmlThread("<p>Private</p>");
    user = MEMBER;
    try {
      expect((await call(`/api/orgs/${mailbox.orgId}/preview/threads/${threadId}/pdf`, { browser })).status).toBe(403);
    } finally {
      user = OWNER;
    }
    expect((await call(`/api/orgs/other-org/preview/threads/${threadId}/pdf`, { browser })).status).toBe(404);
    expect((await call(`/api/orgs/${mailbox.orgId}/preview/threads/${threadId}/pdf`, { headers: { origin: "https://evil.example" }, browser })).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await call(`/api/orgs/${mailbox.orgId}/preview/threads/${threadId}/pdf`, { browser: null })).status).toBe(503);

    const notPdf = fakeBrowser(() => new Response("<html>oops</html>"));
    expect((await call(`/api/orgs/${mailbox.orgId}/preview/threads/${threadId}/pdf`, { browser: notPdf.browser })).status).toBe(502);
  });

  it("escapes plain-text bodies and notes messages left out", () => {
    const html = threadPdfHtml(
      "Notes",
      [{ fromEmail: "a@x.test", fromName: null, toEmails: ["b@x.test"], ccEmails: [], occurredAt: new Date("2026-10-01T00:00:00Z"), html: null, text: "<b>not bold</b>" }],
      3,
    );
    expect(html).toContain("<pre>&lt;b&gt;not bold&lt;/b&gt;</pre>");
    expect(html).toContain("3 more messages not included.");
    expect(html).toContain("Thu, 01 Oct 2026 00:00:00 GMT");
  });

  it("refuses an oversized PDF before consuming the response", async () => {
    let cancelled = false;
    const { browser } = fakeBrowser(() => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { "content-length": String(PDF_MAX_BYTES + 1) } }));
    const threadId = await seedHtmlThread("<p>Hello</p>");
    expect((await call(`/api/orgs/${mailbox.orgId}/preview/threads/${threadId}/pdf`, { browser })).status).toBe(413);
    expect(cancelled).toBe(true);
  });
});
