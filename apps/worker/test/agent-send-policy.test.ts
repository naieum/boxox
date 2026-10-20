import { describe, expect, it } from "vitest";
import { knownCounterparties } from "../src/routes/agent-api";

/**
 * Reply-only ("send") authorization must not be forgeable via spoofed inbound
 * From headers (Phase 3 HIGH finding). knownCounterparties() is the single
 * security gate: only authenticated inbound or prior outbound establishes a
 * "known" recipient; everything else is net-new and needs send_new.
 */

const netNewOf = (known: Set<string>, to: string[]) =>
  to.filter((e) => !known.has(e.toLowerCase()));

describe("knownCounterparties (reply-only send gate)", () => {
  it("does NOT trust an unauthenticated (spoofed-From) inbound sender", () => {
    const known = knownCounterparties(
      [{ fromEmail: "target@victim.com", authenticated: false }],
      [],
    );
    expect(known.has("target@victim.com")).toBe(false);
    // → the recipient is net-new, so a send-only agent (no send_new) is blocked.
    expect(netNewOf(known, ["target@victim.com"])).toEqual(["target@victim.com"]);
  });

  it("trusts an authenticated inbound sender (real customer, DMARC pass)", () => {
    const known = knownCounterparties(
      [{ fromEmail: "Customer@Example.com", authenticated: true }],
      [],
    );
    expect(known.has("customer@example.com")).toBe(true);
    expect(netNewOf(known, ["customer@example.com"])).toEqual([]);
  });

  it("trusts recipients of prior outbound messages from this address", () => {
    const known = knownCounterparties(
      [],
      [{ toEmails: ["A@partner.com", "b@partner.com"] }],
    );
    expect(known.has("a@partner.com")).toBe(true);
    expect(known.has("b@partner.com")).toBe(true);
  });

  it("mixed: only the authenticated + outbound identities are known", () => {
    const known = knownCounterparties(
      [
        { fromEmail: "spoofed@victim.com", authenticated: false },
        { fromEmail: "real@customer.com", authenticated: true },
      ],
      [{ toEmails: ["reply@partner.com"] }],
    );
    expect(netNewOf(known, ["real@customer.com", "reply@partner.com"])).toEqual([]);
    expect(netNewOf(known, ["spoofed@victim.com"])).toEqual(["spoofed@victim.com"]);
  });

  it("tolerates null fields", () => {
    const known = knownCounterparties(
      [{ fromEmail: null, authenticated: true }],
      [{ toEmails: null }],
    );
    expect(known.size).toBe(0);
  });
});
