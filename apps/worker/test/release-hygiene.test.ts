import { describe, expect, it } from "vitest";
const readmes = import.meta.glob<string>("../../../README.md", { eager: true, query: "?raw", import: "default" });
const readme = Object.values(readmes).join("\n");

const workflows = import.meta.glob<string>("../../../.github/workflows/*.{yml,yaml}", { eager: true, query: "?raw", import: "default" });

describe("release hygiene", () => {
  it("CI installs from the frozen lockfile and runs pnpm audit", () => {
    expect(Object.keys(workflows).length).toBeGreaterThan(0);
    const ci = Object.values(workflows).join("\n");
    expect(ci).toMatch(/pnpm install --frozen-lockfile/);
    expect(ci).toMatch(/pnpm audit --audit-level high/);
    expect(ci).toMatch(/contents: read/);
    expect(ci).not.toMatch(/pull_request_target|write-all|secrets\.|github\.event\./);
    for (const workflow of Object.values(workflows)) {
      for (const ref of workflow.matchAll(/uses:\s*([^\s#]+)/g)) expect(ref[1]).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(ci).toMatch(/persist-credentials: false/);
  });

  it("README requires two-factor sign-in on Cloudflare and GitHub", () => {
    expect(readme).toMatch(/(?:require|must|enable)[^.\n]*two-factor[^.\n]*(?:Cloudflare[^.\n]*GitHub|GitHub[^.\n]*Cloudflare)/i);
    expect(readme).toMatch(/security keys/i);
    expect(readme).toMatch(/signed release tags/i);
  });
});
