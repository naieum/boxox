import { describe, expect, it } from "vitest";
import { dedupeKeyFor, isAuthenticated } from "../src/services/ingest";

// FIX A — sender authentication gate. Fail closed on anything but a clear pass
// stamped by the receiving MTA itself.
describe("isAuthenticated", () => {
  it("trusts DMARC pass from the receiving MTA", () => {
    expect(isAuthenticated(["resend.com; dmarc=pass header.from=acme.com"])).toBe(true);
    expect(isAuthenticated(["amazonses.com; dmarc=pass header.from=acme.com"])).toBe(true);
  });

  it("trusts a subdomain authserv-id of the receiving MTA", () => {
    expect(isAuthenticated(["inbound.amazonses.com; dmarc=pass"])).toBe(true);
  });

  it("trusts aligned SPF pass + DKIM pass", () => {
    expect(
      isAuthenticated(["resend.com; spf=pass smtp.mailfrom=acme.com; dkim=pass header.d=acme.com"]),
    ).toBe(true);
  });

  it("rejects an untrusted authserv-id — the sender controls its own headers", () => {
    expect(isAuthenticated(["mx.attacker.example; dmarc=pass"])).toBe(false);
    expect(isAuthenticated(["mx.boxox.dev; dmarc=pass header.from=acme.com"])).toBe(false);
  });

  it("rejects a lookalike authserv-id (suffix without a dot boundary)", () => {
    expect(isAuthenticated(["notresend.com; dmarc=pass"])).toBe(false);
  });

  it("fails closed on duplicate Authentication-Results headers", () => {
    expect(
      isAuthenticated([
        "resend.com; dmarc=fail",
        "resend.com; dmarc=pass", // forged copy the sender attached
      ]),
    ).toBe(false);
  });

  it("rejects SPF pass alone", () => {
    expect(isAuthenticated(["resend.com; spf=pass; dkim=none"])).toBe(false);
  });

  it("rejects DKIM pass alone", () => {
    expect(isAuthenticated(["resend.com; dkim=pass; spf=softfail"])).toBe(false);
  });

  it("rejects dmarc=fail / spoofed results", () => {
    expect(isAuthenticated(["resend.com; dmarc=fail; spf=fail; dkim=fail"])).toBe(false);
  });

  it("fails closed on absent/empty header", () => {
    expect(isAuthenticated([])).toBe(false);
    expect(isAuthenticated([""])).toBe(false);
    expect(isAuthenticated(["resend.com; garbage without verdicts"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isAuthenticated(["RESEND.COM; DMARC=PASS"])).toBe(true);
  });

  it("does not match a substring like dmarc=passx", () => {
    // \b guards against a bogus verdict token slipping past.
    expect(isAuthenticated(["resend.com; dmarc=passable"])).toBe(false);
  });
});

// FIX C — deterministic dedupe fallback for Message-ID-less inbound.
describe("dedupeKeyFor", () => {
  it("uses the real RFC Message-ID when present", () => {
    expect(dedupeKeyFor({ rfcMessageId: "<abc@acme.com>", emailId: "e1", rawKey: "k" })).toBe(
      "<abc@acme.com>",
    );
  });

  it("falls back to email_id (stable across Resend re-delivery)", () => {
    expect(dedupeKeyFor({ rfcMessageId: null, emailId: "email_123", rawKey: "k" })).toBe(
      "syn:email_123",
    );
  });

  it("falls back to rawKey when there is no email_id either", () => {
    expect(dedupeKeyFor({ rfcMessageId: null, emailId: undefined, rawKey: "ingest/o/d/u.json" })).toBe(
      "syn:ingest/o/d/u.json",
    );
  });

  it("is deterministic — same inputs yield the same key (retries dedupe)", () => {
    const a = dedupeKeyFor({ rfcMessageId: null, emailId: "e", rawKey: "k" });
    const b = dedupeKeyFor({ rfcMessageId: null, emailId: "e", rawKey: "k" });
    expect(a).toBe(b);
  });

  it("never collides a synthetic key with a real Message-ID space", () => {
    // Real Message-IDs are angle-addr; the syn: prefix keeps the namespaces disjoint.
    expect(dedupeKeyFor({ rfcMessageId: null, emailId: "x", rawKey: "k" }).startsWith("syn:")).toBe(
      true,
    );
  });
});
