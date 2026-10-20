/** Local-only Wrangler fixture: actual auth/routes/D1/R2/DO; external email and queue are stubbed. */
import { Hono } from "hono";
import { domains } from "@boxox/db";
import { createDb } from "../../../apps/worker/src/db";
import { createManagementKey } from "../../../apps/worker/src/dev/keys";
import { devKeyRoutes } from "../../../apps/worker/src/dev/keys-routes";
import { devMessageRoutes } from "../../../apps/worker/src/dev/messages-routes";
import { devTemplateRoutes } from "../../../apps/worker/src/dev/templates-routes";
import { devWebhookRoutes } from "../../../apps/worker/src/dev/webhooks-routes";
import { emitWebhookEvent } from "../../../apps/worker/src/dev/webhooks";
import type { DevContext } from "../../../apps/worker/src/dev/auth";
import type { Env } from "../../../apps/worker/src/env";
export { MailboxHub } from "../../../apps/worker/src/do/mailbox-hub";

const app = new Hono<DevContext>().use("*", async (c, next) => {
  c.set("db", createDb(c.env)); await next();
}).post("/__seed", async (c) => {
  const { queries } = await c.req.json<{ queries: string[] }>();
  for (const statement of queries) await c.env.DB.prepare(statement).run();
  const db = c.get("db");
  await db.insert(domains).values({ id: "cli-domain", organizationId: "owner", name: "app.test", status: "active", sendingEnabled: true, active: true });
  await db.insert(domains).values({ id: "other-domain", organizationId: "owner", name: "other.test", status: "active", sendingEnabled: true, active: true });
  const created = await createManagementKey(db, "owner", { type: "owner", email: "owner@app.test" }, { name: "local test", domains: [
    { domainId: "cli-domain", grantablePermissions: ["send", "read_log", "templates", "webhooks"] },
    { domainId: "other-domain", grantablePermissions: ["send", "read_log", "templates", "webhooks"] },
  ] });
  return c.json(created);
}).post("/__emit/:domain", async (c) => {
  await emitWebhookEvent(c.env, c.req.param("domain"), "message.delivered", { messageId: "local-test-message" });
  return c.json({ ok: true });
}).route("/dev/v1/keys", devKeyRoutes).route("/dev/v1/messages", devMessageRoutes)
  .route("/dev/v1/templates", devTemplateRoutes).route("/dev/v1/webhooks", devWebhookRoutes);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Keep external effects local while exercising all production API storage and auth.
    const local = { ...env, SEND_WORKFLOW: { create: async () => ({ id: "local-workflow" }) }, WEBHOOK_QUEUE: { send: async () => {}, sendBatch: async () => {} } } as unknown as Env;
    return app.fetch(request, local, ctx);
  },
};
