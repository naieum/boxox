import { describe, expect, it } from "vitest";
import { attachmentContentDisposition } from "../src/routes/threads";

describe("attachmentContentDisposition", () => {
  it("passes a plain ASCII filename through", () => {
    expect(attachmentContentDisposition("report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it("strips CR/LF header-injection attempts", () => {
    const value = attachmentContentDisposition('a\r\nContent-Type: text/html\r\n.pdf');
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
    expect(value).toContain('filename="aContent-Type: text/html.pdf"');
  });

  it("strips quotes and backslashes so the quoted-string cannot be escaped", () => {
    const value = attachmentContentDisposition('ev"il\\name.txt');
    expect(value).toContain('filename="evilname.txt"');
    expect(value).not.toContain('\\');
  });

  it("strips other control characters", () => {
    expect(attachmentContentDisposition("a\u0000b\u001Fc\u007Fd.txt")).toContain(
      'filename="abcd.txt"',
    );
  });

  it("keeps unicode in the RFC 5987 form and drops it from the ASCII fallback", () => {
    const value = attachmentContentDisposition("résumé.pdf");
    expect(value).toContain('filename="rsum.pdf"');
    expect(value).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it("percent-encodes RFC 5987 specials like apostrophes and asterisks", () => {
    const value = attachmentContentDisposition("it's (v2)*.txt");
    expect(value).toContain("filename*=UTF-8''it%27s%20%28v2%29%2A.txt");
  });

  it("falls back to file when the name is empty", () => {
    expect(attachmentContentDisposition("")).toBe(
      `attachment; filename="file"; filename*=UTF-8''file`,
    );
  });

  it("falls back to file when sanitization leaves nothing", () => {
    expect(attachmentContentDisposition('"\r\n"')).toBe(
      `attachment; filename="file"; filename*=UTF-8''file`,
    );
  });

  it("falls back to file in the ASCII form for fully non-ASCII names", () => {
    const value = attachmentContentDisposition("履歴書");
    expect(value).toContain('filename="file"');
    expect(value).toContain(
      "filename*=UTF-8''%E5%B1%A5%E6%AD%B4%E6%9B%B8",
    );
  });
});
