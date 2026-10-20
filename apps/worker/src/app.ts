import { log } from "./log";
import { Hono } from "hono";
import { createDb } from "./db";
import { devKeyRoutes, ownerKeyRoutes } from "./dev/keys-routes";
import { devMessageRoutes } from "./dev/messages-routes";
import { devOpenApiRoutes } from "./dev/openapi";
import { devReceivedRoutes } from "./dev/received-routes";
import { devSuppressionRoutes } from "./dev/suppressions-routes";
import { devTemplateRoutes } from "./dev/templates-routes";
import { trackingRoutes } from "./dev/tracking-routes";
import { devWebhookRoutes } from "./dev/webhooks-routes";
import { realtimeRoutes } from "./do/mailbox-hub";
import { mcpClientRoutes } from "./oauth/clients";
import { consentRoutes } from "./oauth/consent";
import { withOAuth } from "./oauth/provider";
import {
  requireAccess,
  requireSameOrigin,
  requireSession,
  requireOwner,
  securityHeaders,
  type AppContext,
} from "./middleware";
import { addressRoutes } from "./routes/addresses";
import { attachmentRoutes } from "./routes/attachments";
import { agentWorkRoutes } from "./routes/agent-work";
import { operationsRoutes } from "./routes/operations";
import { agent_apiRoutes } from "./routes/agent-api";
import { agent_publicRoutes } from "./routes/agent-public";
import { agentsRoutes } from "./routes/agents";
import { exportRoutes } from "./routes/export";
import { imageProxyRoutes } from "./routes/image-proxy";
import { domainRoutes } from "./routes/domains";
import { labelRoutes } from "./routes/labels";
import { linkRoutes } from "./routes/link";
import { previewRoutes } from "./routes/preview";
import { draftRoutes } from "./routes/drafts";
import { sendRoutes } from "./routes/send";
import { setupRoutes } from "./routes/setup";
import { settingsRoutes } from "./routes/settings";
import { shareLinkPublicRoutes, shareLinkRoutes } from "./routes/share-links";
import { threadRoutes } from "./routes/threads";
import { capabilities, isFree } from "./services/capabilities";
import { publicDomainHealthRoutes } from "./routes/health";
import { completeCloudflareOAuth } from "./services/cloudflare-oauth";


const app = new Hono<AppContext>()
  .use("*", securityHeaders)
  .use("*", requireAccess)
  .use("*", requireSameOrigin)
  .use("*", async (c, next) => {
    if (isFree(c.env)) {
      const path = c.req.path;
      const outbound = path === "/api/setup/test-send" || /^\/api\/agent\/v1\/send\/?$/.test(path)
        || /^\/api\/orgs\/[^/]+\/send(?:\/|$)/.test(path)
        || (path.startsWith("/dev/v1/messages") && c.req.method !== "GET");
      const aiOrBrowser = /^\/api\/orgs\/[^/]+\/preview(?:\/|$)/.test(path)
        || /^\/api\/orgs\/[^/]+\/threads\/[^/]+\/(summary|replies)\/?$/.test(path);
      if (aiOrBrowser) return c.json({ error: { code: "feature_unavailable", message: "AI and Browser Run are not installed in the Free inbox profile." } }, 403);
      if (outbound) return c.json({ error: { code: "feature_unavailable", message: "Sending is unavailable in the Free inbox profile. Upgrade your Cloudflare Workers plan and rerun the installer for outbound mail." } }, 403);
    }
    await next();
  })
  // Per-request db instance (Workers have no shared global state).
  .use("*", async (c, next) => {
    c.set("db", createDb(c.env));
    await next();
  })

  .get("/api/health", (c) => c.json({ ok: true, service: "boxox" }))
  .get("/health", (c) => c.json({ ok: true, version: c.env.BUILD_SHA ?? "development" }))
  .route("/health/domains", publicDomainHealthRoutes)

  // Public agent endpoints (pair/token) — own rate limiter, no session.
  .route("/api/agent", agent_publicRoutes)

  // Agent REST API (bearer JWT, not session-authenticated). /mcp, /oauth/token and
  // /oauth/register are served by the OAuth provider before the app sees them.
  .route("/api/agent/v1", agentWorkRoutes)
  .route("/api/agent/v1", agent_apiRoutes)
  .route("/api/operations", operationsRoutes)

  // MCP consent page, behind Access; only the owner approves.
  .route("/oauth", consentRoutes)

  // Developer API (API keys, not Access).
  .route("/dev/v1/templates", devTemplateRoutes)
  .route("/dev/v1/keys", devKeyRoutes)
  .route("/dev/v1/messages", devMessageRoutes)
  .route("/dev/v1/webhooks", devWebhookRoutes)
  .route("/dev/v1/received", devReceivedRoutes)
  .route("/dev/v1/suppressions", devSuppressionRoutes)
  .route("/dev/v1/openapi.json", devOpenApiRoutes)

  // Signed open pixels and click redirects (no auth; the signature is the credential).
  .route("/t", trackingRoutes)

  // Large-file download links (no auth; the token is the credential).
  .route("/f", shareLinkPublicRoutes)

  // Authenticated org-scoped API
  .get("/api/me", requireSession, (c) => c.json({ user: c.get("user"), capabilities: capabilities(c.env) }))
  .get("/api/cloudflare/callback", requireSession, requireOwner, (c) => completeCloudflareOAuth(c))

  // Signed links and remote images from mail shown in the message frame.
  .use("/api/link/*", requireSession)
  .route("/api/link", linkRoutes)
  .use("/api/image-proxy/*", requireSession)
  .route("/api/image-proxy", imageProxyRoutes)

  .use("/api/setup/*", requireSession, requireOwner)
  .use("/api/setup", requireSession, requireOwner)
  .route("/api/setup", setupRoutes)
  .route("/api/settings", settingsRoutes)

  .use("/api/orgs/*", requireSession)
  .route("/api/orgs/:orgId/domains", domainRoutes)
  .route("/api/orgs/:orgId/addresses", addressRoutes)
  .route("/api/orgs/:orgId/threads", threadRoutes)
  .route("/api/orgs/:orgId/labels", labelRoutes)
  .route("/api/orgs/:orgId/attachments", attachmentRoutes)
  .route("/api/orgs/:orgId/send", sendRoutes)
  .route("/api/orgs/:orgId/drafts", draftRoutes)
  .route("/api/orgs/:orgId/share-links", shareLinkRoutes)
  .route("/api/orgs/:orgId/agents", agentsRoutes)
  .route("/api/orgs/:orgId/export", exportRoutes)
  .route("/api/orgs/:orgId/preview", previewRoutes)
  .route("/api/orgs/:orgId/dev/keys", ownerKeyRoutes)
  .route("/api/orgs/:orgId/realtime", realtimeRoutes)
  .route("/api/orgs/:orgId/mcp-clients", mcpClientRoutes)

  .notFound((c) =>
    c.req.path.startsWith("/api/") || c.req.path.startsWith("/dev/")
      ? c.json({ error: { code: "not_found", message: "No such endpoint" } }, 404)
      : c.env.ASSETS.fetch(c.req.raw),
  )

  .onError((err, c) => {
    // Never echo internals to clients; keys must never appear in errors.
    log.error("unhandled_error", { path: c.req.path, error: err });
    return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
  });


export const appFetch = withOAuth(app);
