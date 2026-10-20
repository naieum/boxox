import { describe, expect, it } from "vitest";
import { MIME_LIMITS, parseMessage } from "../../src/services/ingest/parse";

const corpus = import.meta.glob<string>("./corpus/*.eml", { eager: true, query: "?raw", import: "default" });
const enc = new TextEncoder();
const prefix = "From: sender@outside.test\r\nTo: me@example.test\r\nSubject: boundary\r\n";

function invariant(result: Awaited<ReturnType<typeof parseMessage>>, bytes: number) {
  if (!result.ok) { expect(result.reason.length).toBeLessThanOrEqual(300); return; }
  expect(result.mail.subject.length).toBeLessThanOrEqual(998);
  expect(result.mail.subject).not.toMatch(/[\r\n]/);
  expect(result.mail.toEmails.length).toBeLessThanOrEqual(200);
  expect(result.mail.ccEmails.length).toBeLessThanOrEqual(200);
  expect(result.mail.attachments.length).toBeLessThanOrEqual(MIME_LIMITS.maxPartCount);
  for (const att of result.mail.attachments) {
    expect(att.filename.length).toBeLessThanOrEqual(255);
    expect(att.filename).not.toMatch(/[\u0000-\u001f\u007f/\\]/);
    expect(att.content.byteLength).toBeLessThanOrEqual(bytes);
  }
}

describe("deterministic MIME fuzz corpus", () => {
  for (const [name, raw] of Object.entries(corpus)) {
    it(`contains parser failures for ${name} and its deterministic byte mutations`, async () => {
      const bytes = enc.encode(raw);
      // Every seed is synthetic. Cuts, bit flips and NULs are reproducible and
      // hit decoders/boundary matching without a flaky random/time assertion.
      const variants = [bytes, bytes.slice(0, Math.floor(bytes.length / 2))];
      for (let offset = 0; offset < bytes.length; offset += Math.max(1, Math.floor(bytes.length / 8))) {
        const flipped = bytes.slice(); flipped[offset] = flipped[offset]! ^ 0xff;
        const nul = bytes.slice(); nul[offset] = 0;
        variants.push(flipped, nul);
      }
      for (const variant of variants) invariant(await parseMessage(variant), variant.length);
      if (name.endsWith("duplicate-auth.eml")) {
        const result = await parseMessage(bytes);
        expect(result.ok && result.mail.authenticated).toBe(false);
      }
    });
  }

  it("rejects excessive parts, headers, nesting and bytes as bounded outcomes", async () => {
    const parts = `${prefix}Content-Type: multipart/mixed; boundary=x\r\n\r\n` + Array.from({ length: MIME_LIMITS.maxPartCount + 1 }, () => "--x\r\nContent-Type: text/plain\r\n\r\na\r\n").join("") + "--x--\r\n";
    const headers = prefix + Array.from({ length: MIME_LIMITS.maxHeaderCount + 1 }, (_, i) => `X-${i}: x\r\n`).join("") + "\r\nbody";
    const hugeHeader = `${prefix}X-Huge: ${"a".repeat(MIME_LIMITS.maxHeadersSize + 1)}\r\n\r\nbody`;
    let nested = "Content-Type: text/plain\r\n\r\nleaf";
    for (let i = 0; i <= MIME_LIMITS.maxNestingDepth + 1; i++) nested = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${nested}\r\n--b${i}--\r\n`;
    for (const raw of [parts, headers, hugeHeader, prefix + nested]) {
      const result = await parseMessage(enc.encode(raw));
      expect(result.ok).toBe(false);
      invariant(result, enc.encode(raw).length);
    }
    const overSize = new Uint8Array(MIME_LIMITS.maxBytes + 1);
    expect(await parseMessage(overSize)).toMatchObject({ ok: false, reason: expect.stringContaining("over the") });
  });

  it("bounds embedded message expansion and recipient lists", async () => {
    let embedded = `${prefix}Content-Type: text/plain\r\n\r\nleaf`;
    for (let i = 0; i < 12; i++) embedded = `${prefix}Content-Type: message/rfc822\r\n\r\n${embedded}`;
    const nested = await parseMessage(enc.encode(embedded));
    expect(nested.ok).toBe(true);
    if (nested.ok) expect(nested.mail.attachments.some((a) => a.contentType === "message/rfc822")).toBe(true);
    const recipients = Array.from({ length: 250 }, (_, i) => `u${i}@example.test`).join(", ");
    const result = await parseMessage(enc.encode(`From: sender@outside.test\r\nTo: ${recipients}\r\n\r\nbody`));
    expect(result.ok && result.mail.toEmails.length).toBe(200);
  });
});
