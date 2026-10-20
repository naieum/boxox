import { describe, expect, it } from "vitest";
import { escapeMboxBody, mboxFromLine, sha256Hex, synthesizeRfc822 } from "../src/services/mbox";
import { encodeExportCursor, parseExportCursor } from "../src/routes/export";

/**
 * Export is the promise that using Box Ox is not a one-way door, so its failure
 * modes are silent corruption rather than errors: a truncated archive still
 * looks like an archive.
 */

describe("escapeMboxBody", () => {
  it("escapes a line that would be read as a record separator", () => {
    // Unescaped, this line ends the current message and starts a bogus one —
    // truncating real mail and corrupting whatever follows.
    expect(escapeMboxBody("hello\nFrom the desk of Bob\nbye")).toBe(
      "hello\n>From the desk of Bob\nbye",
    );
  });

  it("escapes at the very start of a body", () => {
    expect(escapeMboxBody("From nowhere")).toBe(">From nowhere");
  });

  it("is reversible — existing >From runs gain one more >", () => {
    expect(escapeMboxBody(">From x")).toBe(">>From x");
    expect(escapeMboxBody(">>From x")).toBe(">>>From x");
  });

  it("leaves 'From' without a trailing space alone", () => {
    // "Fromage" and "From:" are not separators and must not be mangled.
    expect(escapeMboxBody("Fromage is nice\nFrom: a@b.c")).toBe("Fromage is nice\nFrom: a@b.c");
  });

  it("escapes every occurrence, not just the first", () => {
    expect(escapeMboxBody("From a\nx\nFrom b")).toBe(">From a\nx\n>From b");
  });
});

describe("mboxFromLine", () => {
  it("emits an asctime-shaped separator in UTC", () => {
    const line = mboxFromLine("bob@example.com", new Date("2026-07-24T09:05:03Z"));
    expect(line).toBe("From bob@example.com Fri Jul 24 09:05:03 2026\n");
  });

  it("strips whitespace and angle brackets that would break parsing", () => {
    const line = mboxFromLine("<bob @example.com>", new Date("2026-01-02T03:04:05Z"));
    expect(line.startsWith("From bob@example.com ")).toBe(true);
  });

  it("falls back to MAILER-DAEMON for an empty sender", () => {
    expect(mboxFromLine("", new Date("2026-01-02T03:04:05Z")).startsWith("From MAILER-DAEMON ")).toBe(
      true,
    );
  });
});

describe("synthesizeRfc822", () => {
  const base = {
    fromEmail: "a@x.test",
    fromName: "Ada",
    toEmails: ["b@y.test"],
    ccEmails: [],
    subject: "Hello",
    occurredAt: new Date("2026-07-24T00:00:00Z"),
    rfcMessageId: "<m1@x.test>",
    inReplyTo: null,
    text: "body text",
    html: null,
    attachments: [],
  };

  it("marks reconstructed messages so nobody mistakes them for originals", () => {
    // A recipient must be able to tell verifiable bytes from a best-effort
    // rebuild; silently presenting one as the other is the dishonest failure.
    expect(synthesizeRfc822(base)).toContain("X-BoxOx-Reconstructed: yes");
  });

  it("includes the headers a client needs to thread and display it", () => {
    const out = synthesizeRfc822(base);
    expect(out).toContain("From: Ada <a@x.test>");
    expect(out).toContain("To: b@y.test");
    expect(out).toContain("Subject: Hello");
    expect(out).toContain("Message-ID: <m1@x.test>");
    expect(out).toContain("body text");
  });

  it("separates headers from body with a blank line", () => {
    const out = synthesizeRfc822(base);
    expect(out).toMatch(/\n\nbody text/);
  });

  it("records attachments it cannot embed rather than dropping them silently", () => {
    const out = synthesizeRfc822({
      ...base,
      attachments: [{ filename: "invoice.pdf", size: 1234 }],
    });
    expect(out).toContain("invoice.pdf (1234 bytes)");
  });

  it("omits Cc and In-Reply-To when absent instead of emitting empty headers", () => {
    const out = synthesizeRfc822(base);
    expect(out).not.toContain("Cc:");
    expect(out).not.toContain("In-Reply-To:");
  });
});

describe("export cursor", () => {
  it("round-trips", () => {
    const at = new Date("2026-07-24T12:00:00Z");
    const parsed = parseExportCursor(encodeExportCursor(at, "msg_1"));
    expect(parsed?.occurredAt.getTime()).toBe(at.getTime());
    expect(parsed?.id).toBe("msg_1");
  });

  it("treats malformed input as 'start from the beginning' rather than erroring", () => {
    // A junk cursor must degrade to a valid export, never a 500 or a silently
    // empty archive.
    for (const bad of ["", "abc", ".", "12345", "x.y", "-1.msg"]) {
      expect(parseExportCursor(bad)).toBeNull();
    }
  });

  it("keeps ids containing dots intact", () => {
    const parsed = parseExportCursor("1700000000000.a.b.c");
    expect(parsed?.id).toBe("a.b.c");
  });
});

describe("sha256Hex", () => {
  it("produces the known digest of the empty input", () => {
    return sha256Hex(new ArrayBuffer(0)).then((h) =>
      expect(h).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    );
  });

  it("is stable and 64 hex chars", async () => {
    const bytes = new TextEncoder().encode("hello").buffer as ArrayBuffer;
    const a = await sha256Hex(bytes);
    expect(a).toHaveLength(64);
    expect(a).toBe(await sha256Hex(bytes));
  });
});
