import type { Env } from "../env";

export const isFree = (env: Pick<Env, "BOXOX_EDITION">) => env.BOXOX_EDITION === "free";

export function capabilities(env: Pick<Env, "BOXOX_EDITION">) {
  const free = isFree(env);
  return { edition: free ? "free" as const : "paid" as const, receiving: true, sending: !free,
    ai: !free, semanticSearch: !free, browser: !free, webhooks: true };
}

export function freeRuntime(env: Pick<Env, "FREE_RUNTIME">) {
  if (!env.FREE_RUNTIME) throw new Error("The Free profile requires the FREE_RUNTIME SQLite Durable Object binding");
  return env.FREE_RUNTIME.get(env.FREE_RUNTIME.idFromName("runtime"));
}
