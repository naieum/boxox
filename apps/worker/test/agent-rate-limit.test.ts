import { describe, expect, it } from "vitest";
import { RATE_LIMITS, RATE_WINDOW_MS } from "../src/services/agent-rate-limit";

describe("RATE_LIMITS", () => {
  it("uses a 15-minute fixed window", () => {
    expect(RATE_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it("carries a per-org outbound send backstop of 200 (~800/hr)", () => {
    expect(RATE_LIMITS.sendPerOrg).toBe(200);
    // Four windows per hour; the backstop is generous, not a billing cap.
    expect(RATE_LIMITS.sendPerOrg * (60 / 15)).toBe(800);
  });

  it("keeps the pre-existing endpoint budgets intact", () => {
    expect(RATE_LIMITS.pairPerIp).toBe(10);
    expect(RATE_LIMITS.tokenPerIp).toBe(60);
    expect(RATE_LIMITS.tokenPerClient).toBe(30);
  });
});
