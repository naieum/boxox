import { createMiddleware } from "hono/factory";
import { sessionUser, signinMode } from "../services/signin";
import { bypassesAccess, createAccessMiddleware } from "./access";
import type { AppContext } from "./index";

/** Sign-in itself has to work signed out. Everything else under /api/auth needs a session. */
const SIGNED_OUT_API = new Set(["/api/auth/state", "/api/auth/invite/begin", "/api/auth/invite/finish", "/api/auth/login/begin", "/api/auth/login/finish", "/api/auth/logout"]);

const access = createAccessMiddleware();

/**
 * Who is making this request. With ACCESS_AUD and TEAM_DOMAIN set, Cloudflare
 * Access decides, exactly as before. Otherwise Box Ox's own passkey session
 * does. Either way the app is closed by default: without an identity, only the
 * machine endpoints (which carry their own credentials), the sign-in calls
 * and the static web app are answered.
 */
export const requireIdentity = createMiddleware<AppContext>(async (c, next) => {
  if (signinMode(c.env) === "access") return access(c, next);
  const path = c.req.path;
  if (bypassesAccess(path)) return next();
  const user = await sessionUser(c);
  if (user) {
    c.set("user", user);
    return next();
  }
  if (SIGNED_OUT_API.has(path)) return next();
  const read = c.req.method === "GET" || c.req.method === "HEAD";
  // The agent consent page is a document, so send the owner to sign in and back.
  if (path === "/oauth/authorize" && read) return c.redirect(`/signin?next=${encodeURIComponent(path + new URL(c.req.url).search)}`);
  // Every authenticated endpoint lives under /api or /oauth. Anything else a
  // signed-out browser can GET is the web app's own public files.
  if (!read || path === "/api" || path.startsWith("/api/") || path === "/oauth" || path.startsWith("/oauth/")) {
    return c.json({ error: { code: "unauthorized", message: "Sign in required" } }, 401);
  }
  return next();
});
