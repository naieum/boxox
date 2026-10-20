import { describe, expect, it } from "vitest";
import { TOTAL_ATTACHMENT_LIMIT_BYTES, base64DecodedSize, planAttachments } from "../src/services/ingest";

// Base64 → decoded byte length, estimated from length + padding without decoding.
describe("base64DecodedSize", () => {
  it("is exact for unpadded, single- and double-padded strings", () => {
    // "M" -> "TQ==" (1 byte), "Ma" -> "TWE=" (2 bytes), "Man" -> "TWFu" (3 bytes).
    expect(base64DecodedSize("TQ==")).toBe(1);
    expect(base64DecodedSize("TWE=")).toBe(2);
    expect(base64DecodedSize("TWFu")).toBe(3);
  });

  it("agrees with actual atob length across padding cases", () => {
    for (const raw of ["", "a", "ab", "abc", "abcd", "hello world!!"]) {
      const b64 = btoa(raw);
      expect(base64DecodedSize(b64)).toBe(atob(b64).length);
    }
  });

  it("returns 0 for empty input", () => {
    expect(base64DecodedSize("")).toBe(0);
  });
});

// Partition attachments against a total byte budget. Uses a small explicit limit
// so the base64 fixtures stay tiny; a final case checks the real 25MB constant.
describe("planAttachments", () => {
  // Base64 that decodes to exactly `bytes` bytes (bytes must be a multiple of 3).
  const b64OfSize = (bytes: number) => "A".repeat((bytes / 3) * 4);
  const att = (filename: string, bytes: number) => ({
    filename,
    contentType: "application/octet-stream",
    content: b64OfSize(bytes),
  });

  it("stores every attachment when the total is under the limit", () => {
    const plan = planAttachments([att("a", 3), att("b", 6)], 30);
    expect(plan.map((p) => p.store)).toEqual([true, true]);
    expect(plan.map((p) => p.size)).toEqual([3, 6]);
  });

  it("skips a single oversized attachment", () => {
    const plan = planAttachments([att("big", 60)], 30);
    expect(plan[0]?.store).toBe(false);
    expect(plan[0]?.size).toBe(60);
    expect(plan[0]?.filename).toBe("big");
  });

  it("stores earlier attachments then skips once the budget is exceeded", () => {
    const plan = planAttachments([att("1", 12), att("2", 12), att("3", 12)], 30);
    // 12 (running 12) fits, 12 (running 24) fits, third would be 36 > 30 → skipped.
    expect(plan.map((p) => p.store)).toEqual([true, true, false]);
  });

  it("only stored attachments consume budget — a later small one can still fit", () => {
    const plan = planAttachments([att("big", 24), att("huge", 24), att("tiny", 3)], 30);
    // 24 stored, second 24 → 48 > 30 skipped (budget stays 24), tiny 3 → 27 ≤ 30 stored.
    expect(plan.map((p) => p.store)).toEqual([true, false, true]);
  });

  it("stores an attachment exactly at the limit boundary", () => {
    const plan = planAttachments([att("exact", 30)], 30);
    expect(plan[0]?.store).toBe(true);
  });

  it("caps at Resend's ~40MB message ceiling rather than below it", () => {
    // Raised from 25MB deliberately. A cap under the provider's own maximum
    // message size destroys attachments Resend already accepted and delivered —
    // the sender sees success while the content is silently discarded. The cap
    // exists to bound Worker memory, not to second-guess the provider.
    expect(TOTAL_ATTACHMENT_LIMIT_BYTES).toBe(40 * 1024 * 1024);
  });
});
