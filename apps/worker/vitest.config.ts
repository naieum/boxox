import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Every suite runs inside workerd (Miniflare) with the bindings from the root
 * wrangler.jsonc: D1, R2, Queues, Workflows, KV, Durable Objects. Each test
 * file gets its own storage, and `test/apply-migrations.ts` runs the real
 * migrations into its D1 first. Workers AI and Vectorize have no local
 * simulator; suites use the fakes in `test/helpers/ai.ts`.
 */
const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // Generated Free installs retain the full config for the full test suite.
      wrangler: { configPath: root(existsSync(root("wrangler.paid.jsonc")) ? "wrangler.paid.jsonc" : "wrangler.jsonc") },
      remoteBindings: false,
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations(root("migrations")) },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/free-profile.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
