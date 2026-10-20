import { createMiddleware } from "hono/factory";
import type { AppContext } from "./index";

/**
 * Mail HTML renders in a sandboxed srcdoc iframe, which inherits this policy:
 * hence inline styles and https images, but never scripts from anywhere else.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** A route's own CSP (e.g. `sandbox` on attachments) is kept, never loosened. */
export const securityHeaders = createMiddleware<AppContext>(async (c, next) => {
  await next();
  // WebSocket upgrades carry the socket on the response object; rebuilding would drop it.
  if (c.res.status === 101) return;
  // Responses from bindings (ASSETS, fetch) have immutable headers.
  c.res = new Response(c.res.body, c.res);
  if (!c.res.headers.has("Content-Security-Policy")) {
    c.res.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }
  for (const [name, value] of Object.entries(HEADERS)) c.res.headers.set(name, value);
});
