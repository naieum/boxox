import { describe, expect, it } from "vitest";
import {
  decideInboundFolder,
  generateLocalPart,
  makeSnippet,
  normalizeSubject,
  parseAddress,
  routeLocalPart,
  type RoutableAddress,
} from "@boxox/shared";

const NOW = new Date("2026-07-08T12:00:00Z");

const addr = (over: Partial<RoutableAddress> & { id: string; localPart: string }): RoutableAddress => ({
  status: "active",
  expiresAt: null,
  ...over,
});

describe("routeLocalPart", () => {
  const holdDomain = { unknownMailPolicy: "hold" as const, catchAllAddressId: null };
  const dropDomain = { unknownMailPolicy: "drop" as const, catchAllAddressId: null };
  const catchDomain = { unknownMailPolicy: "catch_all" as const, catchAllAddressId: "ca" };

  it("delivers an exact active match", () => {
    const hit = routeLocalPart(
      "Hello",
      holdDomain,
      [addr({ id: "a1", localPart: "hello" })],
      NOW,
    );
    expect(hit).toEqual({ kind: "deliver", addressId: "a1", via: "exact" });
  });

  it("holds unknown local parts under the hold policy", () => {
    expect(
      routeLocalPart("nope", holdDomain, [addr({ id: "a1", localPart: "hello" })], NOW),
    ).toEqual({ kind: "hold" });
  });

  it("drops unknown local parts under the drop policy", () => {
    expect(
      routeLocalPart("nope", dropDomain, [addr({ id: "a1", localPart: "hello" })], NOW),
    ).toEqual({ kind: "drop" });
  });

  it("delivers unknown local parts to the catch-all", () => {
    const hit = routeLocalPart("anything", catchDomain, [addr({ id: "ca", localPart: "inbox" })], NOW);
    expect(hit).toEqual({ kind: "deliver", addressId: "ca", via: "catch_all" });
  });

  it("paused addresses fall through to catch-all", () => {
    const hit = routeLocalPart(
      "hello",
      catchDomain,
      [addr({ id: "a1", localPart: "hello", status: "paused" }), addr({ id: "ca", localPart: "inbox" })],
      NOW,
    );
    expect(hit).toEqual({ kind: "deliver", addressId: "ca", via: "catch_all" });
  });

  it("expired disposable addresses stop receiving (held, not dropped)", () => {
    const expired = addr({
      id: "d1",
      localPart: "x7k2q9",
      expiresAt: new Date("2026-07-01T00:00:00Z"),
    });
    expect(routeLocalPart("x7k2q9", holdDomain, [expired], NOW)).toEqual({ kind: "hold" });
  });

  it("degrades to hold when the catch-all target is paused — mail never vanishes", () => {
    expect(
      routeLocalPart("nope", catchDomain, [addr({ id: "ca", localPart: "inbox", status: "paused" })], NOW),
    ).toEqual({ kind: "hold" });
  });
});

describe("normalizeSubject", () => {
  it("strips reply/forward prefixes recursively", () => {
    expect(normalizeSubject("Re: RE: Fwd: Your invoice #4021")).toBe("your invoice #4021");
    expect(normalizeSubject("FW: hello")).toBe("hello");
    expect(normalizeSubject("Re[2]: nested")).toBe("nested");
  });
  it("collapses whitespace", () => {
    expect(normalizeSubject("  spaced   out ")).toBe("spaced out");
  });
});

describe("parseAddress", () => {
  it("parses display-name forms", () => {
    expect(parseAddress('"Priya Nair" <priya@northwind.co>')).toEqual({
      email: "priya@northwind.co",
      name: "Priya Nair",
    });
    expect(parseAddress("Marcus Lee <marcus@lee.io>")).toEqual({
      email: "marcus@lee.io",
      name: "Marcus Lee",
    });
  });
  it("parses bare and object forms", () => {
    expect(parseAddress("A@B.C")).toEqual({ email: "a@b.c", name: null });
    expect(parseAddress({ email: "X@Y.Z", name: "X" })).toEqual({ email: "x@y.z", name: "X" });
  });
});

describe("decideInboundFolder", () => {
  const base = { senderBlocked: false, authenticated: true, via: "exact" as const };

  it("blocked sender wins over everything — even authenticated exact delivery", () => {
    expect(
      decideInboundFolder({ senderBlocked: true, authenticated: true, via: "exact", addressKind: "personal" }),
    ).toBe("spam");
    expect(
      decideInboundFolder({ senderBlocked: true, authenticated: false, via: "catch_all", addressKind: "role" }),
    ).toBe("spam");
  });

  it("unauthenticated catch-all delivery is spam", () => {
    expect(
      decideInboundFolder({ ...base, authenticated: false, via: "catch_all", addressKind: "personal" }),
    ).toBe("spam");
  });

  it("unauthenticated mail to a role address is spam", () => {
    expect(
      decideInboundFolder({ ...base, authenticated: false, addressKind: "role" }),
    ).toBe("spam");
  });

  it("unauthenticated mail to a personal address stays in the inbox", () => {
    expect(
      decideInboundFolder({ ...base, authenticated: false, addressKind: "personal" }),
    ).toBe("inbox");
  });

  it("authenticated mail to a role address stays in the inbox", () => {
    expect(decideInboundFolder({ ...base, addressKind: "role" })).toBe("inbox");
  });
});

describe("helpers", () => {
  it("snippets collapse and truncate", () => {
    expect(makeSnippet("  a\n\nb   c  ", 5)).toBe("a b c");
    expect(makeSnippet("x".repeat(200)).length).toBe(140);
  });
  it("generated local parts are valid and unambiguous", () => {
    const lp = generateLocalPart();
    expect(lp).toMatch(/^[a-z2-9]{6}$/);
    expect(lp).not.toMatch(/[lio01]/);
  });
});
