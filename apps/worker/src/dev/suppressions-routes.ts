import { Hono, type Context } from "hono";
import { z } from "zod";
import { suppressions } from "@boxox/db";
import { requireApiKey, requireDomainKey, type DevContext } from "./auth";
import { MessageError, zodError } from "./messages";
import { addSuppression, getSuppression, listSuppressions, removeSuppression } from "./suppressions";

export const listQuery = z.object({
  reason: z.enum(suppressions.reason.enumValues).optional(),
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

async function reply(c: Context<DevContext>, run: () => Promise<unknown>, status: 200 | 201 = 200): Promise<Response> {
  try {
    return c.json(await run(), status);
  } catch (err) {
    if (!(err instanceof MessageError)) throw err;
    return c.json({ error: err.toJSON() }, err.status);
  }
}

/**
 * /dev/v1/suppressions: domain keys only, the key's own domain. Reading needs
 * `read_log`; adding and removing need `send`.
 */
export const devSuppressionRoutes = new Hono<DevContext>()
  .use("*", requireApiKey)

  .get("/", requireDomainKey("read_log"), (c) =>
    reply(c, async () => {
      const parsed = listQuery.safeParse(c.req.query());
      if (!parsed.success) throw zodError(parsed.error);
      return listSuppressions(c.get("db"), c.get("apiKey"), parsed.data);
    }),
  )

  .get("/:email", requireDomainKey("read_log"), (c) => reply(c, () => getSuppression(c.get("db"), c.get("apiKey"), c.req.param("email"))))

  .post("/", requireDomainKey("send"), (c) => reply(c, async () => addSuppression(c.get("db"), c.get("apiKey"), await body(c)), 201))

  .delete("/:email", requireDomainKey("send"), (c) => reply(c, () => removeSuppression(c.get("db"), c.get("apiKey"), c.req.param("email"))));
