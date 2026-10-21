import { createMiddleware } from "hono/factory";
import type { Db } from "../db";
import type { Env } from "../env";

export interface SessionUser {
  /** The Access identity's email, lowercased; it is also the user's id. */
  id: string;
  email: string;
  name: string;
  /** "owner" for the installer; invited people are "member". */
  role: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: {
    db: Db;
    user: SessionUser;
    /** Set by requireOrgMember. */
    orgId: string;
    orgRole: string;
  };
};

export { bypassesAccess, createAccessMiddleware, requireAccess } from "./access";
export { CSRF_HEADER, requireSameOrigin } from "./csrf";
export { CONTENT_SECURITY_POLICY, securityHeaders } from "./security-headers";

/** Defence in depth behind requireAccess, which sets the user on every protected path. */
export const requireSession = createMiddleware<AppContext>(async (c, next) => {
  if (!c.get("user")) {
    return c.json({ error: { code: "unauthorized", message: "Sign in required" } }, 401);
  }
  await next();
});

export const requireOwner = createMiddleware<AppContext>(async (c, next) => {
  if (c.get("user")?.role !== "owner") {
    return c.json({ error: { code: "forbidden", message: "Installation owner required" } }, 403);
  }
  await next();
});

/**
 * Requires :orgId param; scopes the request to it with the identity's role.
 *
 * Single-tenant: there is no membership table. Everyone the Access policy
 * admits is a "member", and what they can see is decided per route by their
 * address grants (services/access.ts). The orgId segment is not validated
 * against anything, so every query must still filter by it; a future
 * multi-organization change must add a real membership check here.
 */
export const requireOrgMember = createMiddleware<AppContext>(async (c, next) => {
  const orgId = c.req.param("orgId");
  if (!orgId) {
    return c.json({ error: { code: "bad_request", message: "Missing orgId" } }, 400);
  }
  const user = c.get("user");
  if (!user) {
    return c.json({ error: { code: "unauthorized", message: "Sign in required" } }, 401);
  }
  c.set("orgId", orgId);
  c.set("orgRole", user.role);
  await next();
});

/** Key management is restricted to the owner. */
export const requireOrgAdmin = createMiddleware<AppContext>(async (c, next) => {
  const role = c.get("orgRole");
  if (role !== "owner" && role !== "admin") {
    return c.json({ error: { code: "forbidden", message: "Admin role required" } }, 403);
  }
  await next();
});
