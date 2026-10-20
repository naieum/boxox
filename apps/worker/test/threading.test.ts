import { describe, expect, it } from "vitest";
import { buildReferences, parseReferences } from "../src/services/ingest";
import { OUTBOUND_ATTACHMENT_LIMIT_BYTES, base64Size, sendMessageSchema } from "@boxox/shared";

/**
 * RFC 5322 threading. Using only In-Reply-To is why conversations fragment: it
 * names one ancestor, and the moment that particular message never reaches this
 * mailbox the reply starts a new thread even though its whole ancestry is right
 * there in References.
 */

describe("parseReferences", () => {
  it("extracts ids from a normal space-separated header", () => {
    expect(parseReferences("<a@x> <b@x> <c@x>")).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });

  it("survives folded headers and stray separators real clients emit", () => {
    // Header folding inserts CRLF + whitespace; some clients also comma-separate.
    expect(parseReferences("<a@x>,\r\n\t<b@x>\n  <c@x>")).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });

  it("ignores unbracketed junk rather than inventing ids", () => {
    expect(parseReferences("garbage <a@x> more-garbage")).toEqual(["<a@x>"]);
  });

  it("returns empty for absent or empty input", () => {
    expect(parseReferences(null)).toEqual([]);
    expect(parseReferences(undefined)).toEqual([]);
    expect(parseReferences("")).toEqual([]);
  });
});

describe("buildReferences", () => {
  it("appends the parent's Message-ID to the parent's chain", () => {
    expect(buildReferences("<a@x> <b@x>", "<c@x>")).toBe("<a@x> <b@x> <c@x>");
  });

  it("starts a chain when the parent had none", () => {
    expect(buildReferences(null, "<a@x>")).toBe("<a@x>");
  });

  it("returns null when there is no ancestry at all", () => {
    expect(buildReferences(null, null)).toBeNull();
  });

  it("does not duplicate an id already present", () => {
    expect(buildReferences("<a@x> <b@x>", "<b@x>")).toBe("<a@x> <b@x>");
  });

  it("caps growth by dropping the MIDDLE, keeping root and recent ancestors", () => {
    // A long thread grows this header without bound and some MTAs reject
    // oversized headers. The root anchors the conversation; the recent ids do
    // the actual matching — so the middle is what can be spared.
    const parent = Array.from({ length: 30 }, (_, i) => `<m${i}@x>`).join(" ");
    const out = buildReferences(parent, "<latest@x>", 5)!;
    const ids = out.split(" ");
    expect(ids).toHaveLength(5);
    expect(ids[0]).toBe("<m0@x>");
    expect(ids.at(-1)).toBe("<latest@x>");
  });
});

describe("outbound attachments", () => {
  it("computes decoded size without decoding", () => {
    // "hello" -> aGVsbG8= is 5 bytes decoded.
    expect(base64Size("aGVsbG8=")).toBe(5);
    expect(base64Size("")).toBe(0);
  });

  it("agrees with an actual decode across padding cases", () => {
    for (const s of ["YQ==", "YWI=", "YWJj", "YWJjZA=="]) {
      expect(base64Size(s)).toBe(atob(s).length);
    }
  });

  it("bounds the outbound total at Resend's message ceiling", () => {
    expect(OUTBOUND_ATTACHMENT_LIMIT_BYTES).toBe(40 * 1024 * 1024);
  });

  it("accepts a send with html and attachments", () => {
    const parsed = sendMessageSchema.safeParse({
      fromAddressId: "a1",
      to: ["b@x.test"],
      subject: "hi",
      text: "plain",
      html: "<p>rich</p>",
      attachments: [{ filename: "a.pdf", content: "YWJj", contentType: "application/pdf" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults attachments to empty so existing callers keep working", () => {
    const parsed = sendMessageSchema.safeParse({
      fromAddressId: "a1",
      to: ["b@x.test"],
      subject: "hi",
      text: "plain",
    });
    expect(parsed.success && parsed.data.attachments).toEqual([]);
  });

  it("rejects an attachment with no filename", () => {
    const parsed = sendMessageSchema.safeParse({
      fromAddressId: "a1",
      to: ["b@x.test"],
      subject: "hi",
      text: "plain",
      attachments: [{ filename: "", content: "YWJj" }],
    });
    expect(parsed.success).toBe(false);
  });
});
