import { describe, expect, it } from "vitest";
import { BoxOxAgent, BoxOxError } from "../src/index";

describe("agent bearer SDK", () => {
  it("uses the agent API, bounded opt-in body reads and fresh supplied tokens", async () => {
    const calls: { url: URL; init: RequestInit }[] = []; let token = 0;
    const mail = new BoxOxAgent({ url: "https://mail.example.test/", token: () => `synthetic-${++token}`, fetch: async function(input, init = {}) {
      expect(this).toBeUndefined();
      calls.push({ url: new URL(String(input)), init }); return Response.json({ messages: [], nextCursor: null });
    } });
    await mail.changes("address/1", { cursor: "opaque+cursor", limit: 50 });
    await mail.thread("thread/1");
    await mail.message("message/1", { includeBody: true });
    expect(calls.map(c => c.url.pathname + c.url.search)).toEqual([
      "/api/agent/v1/addresses/address%2F1/changes?cursor=opaque%2Bcursor&limit=50", "/api/agent/v1/threads/thread%2F1", "/api/agent/v1/messages/message%2F1?includeBody=true",
    ]);
    expect(calls.map(c => (c.init.headers as Record<string, string>).authorization)).toEqual(["Bearer synthetic-1", "Bearer synthetic-2", "Bearer synthetic-3"]);
  });
  it("sends complete work contracts and explicit send idempotency without automatic retries", async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const mail = new BoxOxAgent({ url: "http://localhost:8787", token: "synthetic", fetch: async (input, init = {}) => {
      calls.push({ path: new URL(String(input)).pathname, init }); return Response.json({ error: { code: "claim_lost", message: "Claim expired" } }, { status: 409 });
    } });
    const ref = { messageId: "m1", claimToken: "synthetic-claim", group: "support" };
    const commands = [() => mail.work.claim({ messageId: "m1", group: "support", leaseSeconds: 60 }), () => mail.work.renew({ ...ref, leaseSeconds: 300 }),
      () => mail.work.retry({ ...ref, delaySeconds: 0 }), () => mail.work.complete(ref), () => mail.work.completeBatch([ref]),
      () => mail.send({ fromAddressId: "a1", to: ["reader@example.test"], subject: "Re: request", text: "Done" }, { idempotencyKey: "reply-m1" })];
    for (const command of commands) await expect(command()).rejects.toMatchObject({ status: 409, code: "claim_lost" });
    expect(calls).toHaveLength(6);
    expect(calls.map(c => c.path)).toEqual(["/api/agent/v1/work/claim", "/api/agent/v1/work/renew", "/api/agent/v1/work/retry", "/api/agent/v1/work/complete", "/api/agent/v1/work/complete-batch", "/api/agent/v1/send"]);
    expect(JSON.parse(calls[4]!.init.body as string)).toEqual({ items: [ref] });
    expect((calls[5]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("reply-m1");
  });
  it("accepts returned claim receipts while sending only the acknowledgment fields", async () => {
    let body: unknown;
    const mail = new BoxOxAgent({ url: "https://example.test", token: "synthetic", fetch: async (_, init) => {
      body = JSON.parse(init!.body as string); return Response.json({ messageId: "m1", completed: true });
    } });
    const receipt = { messageId: "m1", claimToken: "synthetic-claim", group: null, leaseUntil: "2026-01-01T00:05:00Z", attempts: 1 };
    await mail.work.complete(receipt);
    expect(body).toEqual({ messageId: "m1", claimToken: "synthetic-claim" });
    await mail.work.completeBatch([receipt]);
    expect(body).toEqual({ items: [{ messageId: "m1", claimToken: "synthetic-claim" }] });
  });
  it("rejects unsafe URL origins and surfaces unreadable HTTP errors", async () => {
    for (const url of ["https://user:password@example.test", "https://example.test/path", "http://remote.example.test"]) expect(() => new BoxOxAgent({ url, token: "synthetic" })).toThrow();
    const mail = new BoxOxAgent({ url: "https://example.test", token: "synthetic", fetch: async () => new Response("bad gateway", { status: 502 }) });
    await expect(mail.me()).rejects.toBeInstanceOf(BoxOxError);
    await expect(mail.me()).rejects.toMatchObject({ status: 502, code: "http_error" });
  });
});
