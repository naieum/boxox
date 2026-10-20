/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BoxOx, BoxOxError, ROUTES } from "../src/index";

type Spec = { paths: Record<string, Record<string, { operationId?: string }>> };
const spec = JSON.parse(readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8")) as Spec;

interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records each request and answers from `reply`. */
function fakeFetch(reply: (req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req: Recorded = {
      url: new URL(String(input)),
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(req);
    return reply(req);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const KEY = "bxk_fake_test_key";

describe("@boxox/mail client", () => {
  it("covers every operation in the OpenAPI spec with the same method and path", () => {
    const fromSpec: Record<string, [string, string]> = {};
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (op.operationId) fromSpec[op.operationId] = [method.toUpperCase(), path];
      }
    }
    expect(Object.keys(fromSpec).length).toBeGreaterThan(30);
    expect(Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, [...v]]))).toEqual(fromSpec);
  });

  it("sends the bearer key, JSON body and Idempotency-Key, and returns the parsed reply", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: "m1", status: "queued", scheduledAt: null }, 202));
    const mail = new BoxOx({ key: KEY, url: "https://mail.example.test/", fetch });
    const res = await mail.messages.send(
      { from: "noreply@app1.test", to: "a@b.test", subject: "Hi", html: "<p>Hi</p>" },
      { idempotencyKey: "order-42" },
    );
    expect(res).toEqual({ id: "m1", status: "queued", scheduledAt: null });
    const [req] = calls;
    expect(req!.method).toBe("POST");
    expect(req!.url.href).toBe("https://mail.example.test/dev/v1/messages");
    expect(req!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req!.headers["content-type"]).toBe("application/json");
    expect(req!.headers["idempotency-key"]).toBe("order-42");
    expect(req!.body).toEqual({ from: "noreply@app1.test", to: "a@b.test", subject: "Hi", html: "<p>Hi</p>" });
  });

  it("encodes path parameters and drops undefined query values", async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: [], nextCursor: null }));
    const mail = new BoxOx({ key: KEY, url: "https://mail.example.test", fetch });
    await mail.suppressions.get("a+b@x.test");
    await mail.messages.list({ status: "sent", tag: "kind:receipt", limit: 10, cursor: undefined });
    await mail.templates.get("welcome");
    await mail.webhooks.deliveries.replay("wh/1", "d 2");
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "GET /dev/v1/suppressions/a%2Bb%40x.test",
      "GET /dev/v1/messages?status=sent&tag=kind%3Areceipt&limit=10",
      "GET /dev/v1/templates/welcome",
      "POST /dev/v1/webhooks/wh%2F1/deliveries/d%202/replay",
    ]);
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
  });

  it("turns the API's error format into a BoxOxError, keeping batch errors", async () => {
    const { fetch } = fakeFetch((req) =>
      req.url.pathname.endsWith("/batch")
        ? json({ error: { code: "batch_rejected", message: "1 of 2 messages are invalid; none were sent" }, errors: [{ index: 1, code: "bad_request", message: "Invalid", param: "to" }] }, 422)
        : json({ error: { code: "missing_permission", message: "This key lacks the send permission", param: "from" } }, 403),
    );
    const mail = new BoxOx({ key: KEY, url: "https://mail.example.test", fetch });
    const err = await mail.messages.send({ from: "x@y.test", to: "a@b.test", subject: "s" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoxOxError);
    expect(err).toMatchObject({ status: 403, code: "missing_permission", param: "from", message: "This key lacks the send permission" });

    const batch = await mail.messages.batch({ messages: [{ from: "x@y.test", to: "a@b.test", subject: "s" }] }).catch((e: unknown) => e);
    expect(batch).toMatchObject({ status: 422, code: "batch_rejected", errors: [{ index: 1, param: "to" }] });

    const { fetch: htmlFetch } = fakeFetch(() => new Response("<h1>Bad gateway</h1>", { status: 502 }));
    const down = await new BoxOx({ key: KEY, url: "https://mail.example.test", fetch: htmlFetch }).keys.list().catch((e: unknown) => e);
    expect(down).toMatchObject({ status: 502, code: "http_error" });
  });

  it("paginate follows nextCursor until it is null", async () => {
    const pages: Record<string, { data: { id: string }[]; nextCursor: string | null }> = {
      "": { data: [{ id: "1" }, { id: "2" }], nextCursor: "c1" },
      c1: { data: [{ id: "3" }], nextCursor: null },
    };
    const { fetch, calls } = fakeFetch((req) => json(pages[req.url.searchParams.get("cursor") ?? ""]));
    const mail = new BoxOx({ key: KEY, url: "https://mail.example.test", fetch });
    const ids: string[] = [];
    for await (const m of mail.paginate(mail.received.list, { to: "support@app1.test" })) ids.push(m.id);
    expect(ids).toEqual(["1", "2", "3"]);
    expect(calls.map((c) => c.url.search)).toEqual(["?to=support%40app1.test", "?to=support%40app1.test&cursor=c1"]);
  });

  it("returns byte downloads as a Response, and sends no key to the signed .eml link", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("From: a@b.test\r\n\r\nhi", { headers: { "content-type": "message/rfc822" } }));
    const mail = new BoxOx({ key: KEY, url: "https://mail.example.test", fetch });
    const eml = await mail.received.raw("tok.sig");
    expect(await eml.text()).toContain("From: a@b.test");
    expect(calls[0]!.url.pathname).toBe("/dev/v1/received/raw/tok.sig");
    expect(calls[0]!.headers.authorization).toBeUndefined();
    await mail.received.attachment("m1", "a1");
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${KEY}`);
    await expect(mail.download("getMessage", { path: { id: "m1" } })).rejects.toThrow(/returns JSON/);
  });

  it("reads BOXOX_KEY and BOXOX_URL, and refuses to start without them", async () => {
    const saved = { key: process.env.BOXOX_KEY, url: process.env.BOXOX_URL };
    try {
      delete process.env.BOXOX_KEY;
      delete process.env.BOXOX_URL;
      expect(() => new BoxOx()).toThrow(/BOXOX_KEY/);
      process.env.BOXOX_KEY = KEY;
      expect(() => new BoxOx()).toThrow(/BOXOX_URL/);
      process.env.BOXOX_URL = "https://env.example.test";
      const { fetch, calls } = fakeFetch(() => json({ data: [] }));
      await new BoxOx({ fetch }).webhooks.list();
      expect(calls[0]!.url.origin).toBe("https://env.example.test");
      expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    } finally {
      for (const [k, v] of [["BOXOX_KEY", saved.key], ["BOXOX_URL", saved.url]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("opens the domain event stream with SDK-owned URL and bearer authentication", () => {
    const mail = new BoxOx({ key: KEY, url: "https://mail.example.test" });
    const socket = mail.webhooks.listen((url, headers) => ({ url, headers }));
    expect(socket).toEqual({ url: "wss://mail.example.test/dev/v1/webhooks/listen", headers: { authorization: `Bearer ${KEY}` } });
  });

  it("refuses an empty path parameter instead of calling a different route", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const mail = new BoxOx({ key: KEY, url: "https://mail.example.test", fetch });
    await expect(mail.messages.get("")).rejects.toThrow(/missing path parameter id/);
    expect(calls).toHaveLength(0);
  });
});
