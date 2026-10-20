/// <reference types="@cloudflare/vitest-pool-workers/types" />

type BoxoxEnv = import("../src/env").Env;

declare namespace Cloudflare {
  interface Env extends BoxoxEnv {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

/** Vite's eager glob import, used to bundle source text and fixtures into the test worker. */
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; import: "default"; query?: string }): Record<string, T>;
}
