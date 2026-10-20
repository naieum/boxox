import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook, verifyWebhookRequest, WebhookVerificationError } from "../src/index";

// From the Standard Webhooks spec's reference test suite.
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};
const AT = VECTOR.timestamp * 1000;
const headersFor = (signature: string, id = VECTOR.id, timestamp = String(VECTOR.timestamp)) => ({
  "webhook-id": id,
  "webhook-timestamp": timestamp,
  "webhook-signature": signature,
});

async function rejects(p: Promise<unknown>, message: RegExp) {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WebhookVerificationError);
  expect((err as Error).message).toMatch(message);
}

describe("webhook signature verification", () => {
  it("matches the Standard Webhooks test vector", async () => {
    expect(await signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.signature);
    const event = await verifyWebhook(VECTOR.body, headersFor(VECTOR.signature), VECTOR.secret, { now: AT });
    expect(event).toEqual({ test: 2432232314 });
  });

  it("rejects a tampered body, a wrong secret, a changed id and an unsigned delivery", async () => {
    const opts = { now: AT };
    await rejects(verifyWebhook('{"test": 2432232315}', headersFor(VECTOR.signature), VECTOR.secret, opts), /No signature matched/);
    await rejects(verifyWebhook(VECTOR.body, headersFor(VECTOR.signature), "whsec_" + btoa("another-secret-entirely"), opts), /No signature matched/);
    await rejects(verifyWebhook(VECTOR.body, headersFor(VECTOR.signature, "msg_other"), VECTOR.secret, opts), /No signature matched/);
    await rejects(verifyWebhook(VECTOR.body, { "webhook-id": VECTOR.id, "webhook-timestamp": String(VECTOR.timestamp) }, VECTOR.secret, opts), /Missing/);
    await rejects(verifyWebhook(VECTOR.body, headersFor("v2," + VECTOR.signature.slice(3)), VECTOR.secret, opts), /No v1 signature/);
    await rejects(verifyWebhook(VECTOR.body, headersFor("v1,@@@@"), VECTOR.secret, opts), /No v1 signature/);
  });

  it("rejects timestamps outside the tolerance window, in either direction", async () => {
    const h = headersFor(VECTOR.signature);
    expect(await verifyWebhook(VECTOR.body, h, VECTOR.secret, { now: AT + 299_000 })).toEqual({ test: 2432232314 });
    await rejects(verifyWebhook(VECTOR.body, h, VECTOR.secret, { now: AT + 301_000 }), /tolerance/);
    await rejects(verifyWebhook(VECTOR.body, h, VECTOR.secret, { now: AT - 301_000 }), /tolerance/);
    expect(await verifyWebhook(VECTOR.body, h, VECTOR.secret, { now: AT + 3_000_000, toleranceSeconds: 3600 })).toBeTruthy();
    await rejects(verifyWebhook(VECTOR.body, headersFor(VECTOR.signature, VECTOR.id, "1614265330.5"), VECTOR.secret, { now: AT }), /Invalid webhook-timestamp/);
  });

  it("accepts either signature during a rotation, and a list of secrets on the receiver", async () => {
    const fresh = "whsec_" + btoa("0123456789abcdef0123456789abcdef");
    const both = `${await signWebhook(fresh, VECTOR.id, VECTOR.timestamp, VECTOR.body)} ${VECTOR.signature}`;
    expect(await verifyWebhook(VECTOR.body, headersFor(both), fresh, { now: AT })).toBeTruthy();
    expect(await verifyWebhook(VECTOR.body, headersFor(both), VECTOR.secret, { now: AT })).toBeTruthy();
    const onlyFresh = await signWebhook(fresh, VECTOR.id, VECTOR.timestamp, VECTOR.body);
    expect(await verifyWebhook(VECTOR.body, headersFor(onlyFresh), [VECTOR.secret, fresh], { now: AT })).toBeTruthy();
    await rejects(verifyWebhook(VECTOR.body, headersFor(onlyFresh), [VECTOR.secret], { now: AT }), /No signature matched/);
  });

  it("verifies a fetch Request using its raw bytes and case-insensitive headers", async () => {
    const req = new Request("https://app.example.test/hooks/boxox", {
      method: "POST",
      headers: { "Webhook-Id": VECTOR.id, "Webhook-Timestamp": String(VECTOR.timestamp), "Webhook-Signature": VECTOR.signature },
      body: VECTOR.body,
    });
    expect(await verifyWebhookRequest(req, VECTOR.secret, { now: AT })).toEqual({ test: 2432232314 });
    const node = { "Webhook-Id": VECTOR.id, "WEBHOOK-TIMESTAMP": String(VECTOR.timestamp), "webhook-signature": [VECTOR.signature] };
    expect(await verifyWebhook(new TextEncoder().encode(VECTOR.body), node, VECTOR.secret, { now: AT })).toBeTruthy();
  });

  it("accepts what the Worker's own signer sends", async () => {
    const workerWebhooks = new URL("../../../apps/worker/src/dev/webhooks.ts", import.meta.url).href;
    const { generateWebhookSecret, signatureHeaders } = (await import(/* @vite-ignore */ workerWebhooks)) as {
      generateWebhookSecret: () => string;
      signatureHeaders: (secrets: string[], id: string, ts: number, body: string) => Promise<Record<string, string>>;
    };
    const current = generateWebhookSecret();
    const previous = generateWebhookSecret();
    const body = JSON.stringify({ type: "message.received", timestamp: "2026-10-17T12:00:00.000Z", data: { id: "r1", subject: "Héllo ✓" } });
    const ts = Math.floor(Date.now() / 1000);
    const headers = await signatureHeaders([current, previous], "msg_worker", ts, body);
    const event = await verifyWebhook(body, headers, current);
    expect(event).toMatchObject({ type: "message.received", data: { id: "r1", subject: "Héllo ✓" } });
    expect(await verifyWebhook(body, headers, previous)).toBeTruthy();
    await rejects(verifyWebhook(body.replace("r1", "r2"), headers, current), /No signature matched/);
  });
});
