import { Hono, type Context } from "hono";
import { z } from "zod";
import { listenerRequest } from "./listeners";
import { requireApiKey, requireDomainKey, type DevContext } from "./auth";
import { MessageError, zodError } from "./messages";
import {
  createWebhook,
  deleteWebhook,
  DELIVERY_STATUSES,
  getDelivery,
  getWebhook,
  listDeliveries,
  listWebhooks,
  replayDelivery,
  rotateWebhookSecret,
  sendTestEvent,
  updateWebhook,
} from "./webhooks";

export const deliveriesQuery = z.object({
  status: z.enum(DELIVERY_STATUSES).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

async function body(c: Context<DevContext>): Promise<unknown> {
  const text = await c.req.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MessageError(400, "bad_request", "The body must be JSON");
  }
}

async function reply(c: Context<DevContext>, status: 200 | 201 | 202, run: () => Promise<unknown>) {
  try {
    return c.json(await run(), status);
  } catch (err) {
    if (!(err instanceof MessageError)) throw err;
    return c.json({ error: err.toJSON() }, err.status);
  }
}

/**
 * /dev/v1/webhooks: domain keys with `webhooks`. Every endpoint and delivery
 * is looked up through the key's own domain.
 */
export const devWebhookRoutes = new Hono<DevContext>()
  .use("*", requireApiKey)
  .use("*", requireDomainKey("webhooks"))

  .post("/", (c) => reply(c, 201, async () => createWebhook(c.env, c.get("db"), c.get("apiKey"), await body(c))))
  .get("/", (c) => reply(c, 200, () => listWebhooks(c.get("db"), c.get("apiKey"))))
  .get("/listen", (c) => {
    if (c.req.header("upgrade") !== "websocket") {
      return c.json({ error: { code: "upgrade_required", message: "Expected a WebSocket upgrade" } }, 426);
    }
    return listenerRequest(c.env, c.req.url, c.get("apiKey"), c.req.header("authorization")!.replace(/^Bearer\s+/i, ""), c.req.header("cf-connecting-ip") ?? null);
  })
  .get("/:id", (c) => reply(c, 200, () => getWebhook(c.get("db"), c.get("apiKey"), c.req.param("id"))))
  .patch("/:id", (c) => reply(c, 200, async () => updateWebhook(c.get("db"), c.get("apiKey"), c.req.param("id"), await body(c))))
  .delete("/:id", (c) => reply(c, 200, () => deleteWebhook(c.get("db"), c.get("apiKey"), c.req.param("id"))))
  .post("/:id/rotate", (c) =>
    reply(c, 200, async () => rotateWebhookSecret(c.env, c.get("db"), c.get("apiKey"), c.req.param("id"), await body(c))),
  )
  .post("/:id/test", (c) => reply(c, 202, () => sendTestEvent(c.env, c.get("apiKey"), c.req.param("id"))))

  .get("/:id/deliveries", (c) =>
    reply(c, 200, async () => {
      const parsed = deliveriesQuery.safeParse(c.req.query());
      if (!parsed.success) throw zodError(parsed.error);
      return listDeliveries(c.get("db"), c.get("apiKey"), c.req.param("id"), parsed.data);
    }),
  )
  .get("/:id/deliveries/:deliveryId", (c) =>
    reply(c, 200, () => getDelivery(c.get("db"), c.get("apiKey"), c.req.param("id"), c.req.param("deliveryId"))),
  )
  .post("/:id/deliveries/:deliveryId/replay", (c) =>
    reply(c, 202, () => replayDelivery(c.env, c.get("apiKey"), c.req.param("id"), c.req.param("deliveryId"))),
  );
