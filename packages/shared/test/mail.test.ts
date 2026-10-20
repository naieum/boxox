import { describe, expect, it } from "vitest";
import { routeLocalPart, type RoutableAddress } from "../src/mail";

// apps/worker/test/mail.test.ts already covers the common paths (exact match,
// hold/drop policies, catch_all delivery, paused-falls-to-catch-all, expired
// disposable held). This file only adds the gaps: case-insensitivity, a
// catch-all target that isn't in the candidate set at all (not just paused),
// and an expired exact match under catch_all policy.

const NOW = new Date("2026-07-08T12:00:00Z");

const addr = (over: Partial<RoutableAddress> & { id: string; localPart: string }): RoutableAddress => ({
  status: "active",
  expiresAt: null,
  ...over,
});

describe("routeLocalPart — case insensitivity", () => {
  it("matches an exact local part regardless of case, on either side", () => {
    const holdDomain = { unknownMailPolicy: "hold" as const, catchAllAddressId: null };
    expect(
      routeLocalPart("HELLO", holdDomain, [addr({ id: "a1", localPart: "hello" })], NOW),
    ).toEqual({ kind: "deliver", addressId: "a1", via: "exact" });
    expect(
      routeLocalPart("hello", holdDomain, [addr({ id: "a1", localPart: "HELLO" })], NOW),
    ).toEqual({ kind: "deliver", addressId: "a1", via: "exact" });
    expect(
      routeLocalPart("HeLLo", holdDomain, [addr({ id: "a1", localPart: "hELLO" })], NOW),
    ).toEqual({ kind: "deliver", addressId: "a1", via: "exact" });
  });
});

describe("routeLocalPart — catch-all target missing from candidates", () => {
  it("degrades to hold when catchAllAddressId doesn't match any candidate (never drop)", () => {
    const catchDomain = { unknownMailPolicy: "catch_all" as const, catchAllAddressId: "deleted-address" };
    expect(
      routeLocalPart("nope", catchDomain, [addr({ id: "a1", localPart: "hello" })], NOW),
    ).toEqual({ kind: "hold" });
    // Also true with an empty candidate list (e.g. domain has no addresses left).
    expect(routeLocalPart("nope", catchDomain, [], NOW)).toEqual({ kind: "hold" });
  });
});

describe("routeLocalPart — expired exact match under catch_all policy", () => {
  it("falls through to the catch-all, not straight to hold, when the policy is catch_all", () => {
    const catchDomain = { unknownMailPolicy: "catch_all" as const, catchAllAddressId: "ca" };
    const expired = addr({ id: "d1", localPart: "x7k2q9", expiresAt: new Date("2026-07-01T00:00:00Z") });
    const hit = routeLocalPart(
      "x7k2q9",
      catchDomain,
      [expired, addr({ id: "ca", localPart: "inbox" })],
      NOW,
    );
    expect(hit).toEqual({ kind: "deliver", addressId: "ca", via: "catch_all" });
  });
});
