import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { experimental_readRawConfig } from "wrangler";
// The deployed profile and this test use the same resource selection.
// @ts-expect-error Node installer module is JavaScript.
import { applyDeploymentProfile } from "../../scripts/deploy-profile.mjs";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const { rawConfig } = experimental_readRawConfig({ config: root("wrangler.jsonc") });
const config = applyDeploymentProfile(rawConfig, "free");
config.main = root("apps/worker/src/index.ts");
config.assets.directory = root("apps/web/dist");
config.d1_databases[0].migrations_dir = root("migrations");
mkdirSync(root(".wrangler/test-free"), { recursive: true });
writeFileSync(root(".wrangler/test-free/wrangler.json"), JSON.stringify(config));

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: root(".wrangler/test-free/wrangler.json") },
    remoteBindings: false,
    miniflare: { bindings: { AGENT_JWT_SECRET: "test-only-free-profile-secret-not-for-production", TEST_MIGRATIONS: await readD1Migrations(root("migrations")) } },
  }))],
  test: { include: ["test/free-profile.test.ts"], setupFiles: ["./test/apply-migrations.ts"], testTimeout: 30_000, hookTimeout: 60_000 },
});
