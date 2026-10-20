import { createMiddleware } from "hono/factory";
import { bypassesAccess } from "./access";
import type { AppContext } from "./index";

/** The SPA sends this on every mutating request; a cross-site form cannot set it. */
export const CSRF_HEADER = "x-boxox-csrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Mutating requests to Access-protected paths need an Origin equal to the app's
 * own and the custom header. A missing Origin is refused. Agent and developer
 * paths authenticate with bearer credentials, not the Access cookie, so they skip this.
 */
export const requireSameOrigin = createMiddleware<AppContext>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || bypassesAccess(c.req.path)) return next();

  const origin = c.req.header("origin");
  if (!origin || origin !== new URL(c.req.url).origin || c.req.header(CSRF_HEADER) !== "1") {
    return c.json({ error: { code: "csrf_rejected", message: "Cross-site request refused" } }, 403);
  }
  await next();
});
