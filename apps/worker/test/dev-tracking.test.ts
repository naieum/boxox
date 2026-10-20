import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { apiMessages, domains, messageEvents } from "@boxox/db";
import { createDb, type Db } from "../src/db";
import { runApiSend, type ApiSendStep } from "../src/dev/messages";
import { instrumentHtml, verifyToken } from "../src/dev/tracking";
import { trackingRoutes } from "../src/dev/tracking-routes";
import type { Env } from "../src/env";

/**
 * Open/click tracking against a local D1 and R2 (workerd, via Miniflare) with
 * the real migrations. send_email is a fake that records the HTML it was given.
 */
const PUBLIC_URL = "https://mail.example.test";
const SECRET = "test-only-tracking-secret-not-real-000000";

let DB: D1Database;
let MAIL_STORE: R2Bucket;
let db: Db;

beforeAll(() => {
  DB = env.DB;
  MAIL_STORE = env.MAIL_STORE;
  db = createDb({ DB });
});

const step = {
  async do(_name: string, a: unknown, b?: unknown) {
    return ((typeof a === "function" ? a : b) as () => Promise<unknown>)();
  },
  async sleep() {},
  async sleepUntil() {},
} as unknown as ApiSendStep;

const HTML =
  '<html><body><p>Hi</p><a href="https://shop.example.com/order?id=7&amp;t=secret">Your order</a> <a href="mailto:help@example.com">Help</a></body></html>';

const app = new Hono<{ Bindings: Env }>().route("/t", trackingRoutes);

function get(path: string, env: Partial<Env> = {}) {
  return app.request(path, { headers: { "user-agent": "TestMail/1.0" } }, { DB, AGENT_JWT_SECRET: SECRET, PUBLIC_URL, ...env });
}

async function seedDomain(track: { opens?: boolean; clicks?: boolean } = {}) {
  const id = crypto.randomUUID();
  await db.insert(domains).values({
    id,
    organizationId: "owner",
    name: `${id.slice(0, 8)}.test`,
    sendingEnabled: true,
    trackOpens: track.opens ?? false,
    trackClicks: track.clicks ?? false,
  });
  return id;
}

/** Stores a queued API message and runs it through SendWorkflow's steps; returns the HTML handed to send_email. */
async function sendTracked(domainId: string, track: { opens?: boolean; clicks?: boolean } = {}) {
  const id = crypto.randomUUID();
  const r2Key = `api/${domainId}/test/${id}.json`;
  await MAIL_STORE.put(r2Key, JSON.stringify({ text: "Hi", html: HTML, headers: {}, attachments: [] }));
  await db.insert(apiMessages).values({
    id,
    domainId,
    fromEmail: "noreply@example.test",
    toEmails: ["person@example.com"],
    subject: "Order",
    r2Key,
    trackOpens: track.opens ?? false,
    trackClicks: track.clicks ?? false,
  });
  const email = { send: vi.fn(async (_msg: EmailMessageBuilder) => ({ messageId: `<${id}@example.test>` })) };
  const env = { DB, MAIL_STORE, EMAIL: email as unknown as SendEmail, AGENT_JWT_SECRET: SECRET, PUBLIC_URL };
  expect(await runApiSend(env, { kind: "api", messageId: id }, step)).toBe("sent");
  return { id, html: (email.send.mock.calls[0]![0] as unknown as { html: string }).html };
}

function trackingUrls(html: string, kind: "o" | "c") {
  return [...html.matchAll(new RegExp(`${PUBLIC_URL}/t/${kind}/([A-Za-z0-9_.-]+)`, "g"))].map((m) => `/t/${kind}/${m[1]}`);
}

async function eventsFor(id: string) {
  return db.select().from(messageEvents).where(eq(messageEvents.apiMessageId, id));
}

describe("dev tracking", () => {
  it("tracking is off unless enabled", async () => {
    const plain = await sendTracked(await seedDomain());
    expect(plain.html).toBe(HTML);
    expect(plain.html).not.toContain("/t/");

    const opts = { messageId: "m", opens: false, clicks: false };
    expect(await instrumentHtml({ AGENT_JWT_SECRET: SECRET, PUBLIC_URL }, HTML, opts)).toBe(HTML);
    // Turned on but unconfigured: nothing is rewritten rather than pointing at a bad host.
    expect(await instrumentHtml({ AGENT_JWT_SECRET: SECRET }, HTML, { ...opts, opens: true, clicks: true })).toBe(HTML);

    // Per message: only what was asked for.
    const opensOnly = await sendTracked(await seedDomain(), { opens: true });
    expect(trackingUrls(opensOnly.html, "o")).toHaveLength(1);
    expect(trackingUrls(opensOnly.html, "c")).toHaveLength(0);
    expect(opensOnly.html).toContain('href="https://shop.example.com/order?id=7&amp;t=secret"');
    expect(opensOnly.html.indexOf("/t/o/")).toBeLessThan(opensOnly.html.indexOf("</body>"));

    // Per domain: the setting covers messages that didn't ask.
    const domainWide = await sendTracked(await seedDomain({ clicks: true }));
    const clicks = trackingUrls(domainWide.html, "c");
    expect(clicks).toHaveLength(1);
    expect(trackingUrls(domainWide.html, "o")).toHaveLength(0);
    expect(domainWide.html).not.toContain("shop.example.com");
    expect(domainWide.html).toContain('href="mailto:help@example.com"');
    expect(await verifyToken({ AGENT_JWT_SECRET: SECRET }, clicks[0]!.slice("/t/c/".length))).toEqual({
      m: domainWide.id,
      u: "https://shop.example.com/order?id=7&t=secret",
      l: 0,
    });
  });

  it("an unsigned click url is refused", async () => {
    const { id, html } = await sendTracked(await seedDomain(), { clicks: true });
    const [signed] = trackingUrls(html, "c");
    const token = signed!.slice("/t/c/".length);
    const [body, mac] = token.split(".");

    const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const evil = b64(JSON.stringify({ m: id, u: "https://evil.example.net/phish", l: 0 }));
    const refused = [
      `/t/c/${evil}`,
      `/t/c/${evil}.${mac}`,
      `/t/c/${body}.${mac!.slice(0, -2)}AA`,
      `/t/c/${body}`,
      "/t/c/https%3A%2F%2Fevil.example.net",
    ];
    for (const path of refused) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("location"), path).toBeNull();
    }
    // A link signed by another install's secret is just as unsigned here.
    const other = await get(signed!, { AGENT_JWT_SECRET: "a-different-install-secret-0000000000" });
    expect(other.status).toBe(404);
    expect(await eventsFor(id)).toEqual([expect.objectContaining({ type: "sent" })]);

    const ok = await get(signed!);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("https://shop.example.com/order?id=7&t=secret");
    const clicked = (await eventsFor(id)).filter((e) => e.type === "clicked");
    expect(clicked).toHaveLength(1);
    // The query string (tokens in the customer's link) is never stored.
    expect(clicked[0]!.detail).toEqual({ link: 0, url: "https://shop.example.com/order", userAgent: "TestMail/1.0" });
  });

  it("an open records an opened event", async () => {
    const { id, html } = await sendTracked(await seedDomain({ opens: true }));
    const [pixel] = trackingUrls(html, "o");
    expect(pixel).toBeDefined();
    expect((await eventsFor(id)).some((e) => e.type === "opened")).toBe(false);

    const now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 17, 12, 0, 5));
    const res = await get(pixel!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const gif = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(gif.slice(0, 6))).toBe("GIF89a");

    const opened = (await eventsFor(id)).filter((e) => e.type === "opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ apiMessageId: id, recipient: null, detail: { userAgent: "TestMail/1.0" } });

    // A reload within the minute doesn't add a row; a forged pixel looks the same but records nothing.
    await get(pixel!);
    const forged = await get(`/t/o/${pixel!.slice("/t/o/".length).split(".")[0]}.AAAA`);
    expect(forged.status).toBe(200);
    expect(new Uint8Array(await forged.arrayBuffer())).toEqual(gif);
    expect((await eventsFor(id)).filter((e) => e.type === "opened")).toHaveLength(1);

    // A later minute is a new open.
    now.mockReturnValue(Date.UTC(2026, 9, 17, 12, 1, 5));
    await get(pixel!);
    now.mockRestore();
    expect((await eventsFor(id)).filter((e) => e.type === "opened")).toHaveLength(2);
  });
});
