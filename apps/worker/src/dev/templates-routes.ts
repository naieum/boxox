import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireApiKey, requireDomainKey, type DevContext } from "./auth";
import { MessageError, zodError } from "./messages";
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  listVersions,
  previewTemplate,
  updateTemplate,
} from "./templates";

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

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(64).optional(),
});

function versionParam(c: Context<DevContext>): number | undefined {
  const raw = c.req.query("version");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new MessageError(400, "bad_request", "version must be a positive integer", "version");
  return n;
}

/**
 * /dev/v1/templates: domain keys with `templates`, scoped to the key's own
 * domain. PUT saves a new version; GET returns the latest unless ?version=.
 */
export const devTemplateRoutes = new Hono<DevContext>()
  .use("*", requireApiKey, requireDomainKey("templates"))

  .get("/", (c) =>
    reply(c, async () => {
      const parsed = listQuery.safeParse(c.req.query());
      if (!parsed.success) throw zodError(parsed.error);
      return listTemplates(c.get("db"), c.get("apiKey"), parsed.data);
    }),
  )

  .post("/", (c) => reply(c, async () => createTemplate(c.get("db"), c.get("apiKey"), await body(c)), 201))

  .get("/:name", (c) => reply(c, async () => getTemplate(c.get("db"), c.get("apiKey"), c.req.param("name"), versionParam(c))))

  .get("/:name/versions", (c) => reply(c, () => listVersions(c.get("db"), c.get("apiKey"), c.req.param("name"))))

  .put("/:name", (c) => reply(c, async () => updateTemplate(c.get("db"), c.get("apiKey"), c.req.param("name"), await body(c))))

  .post("/:name/preview", (c) => reply(c, async () => previewTemplate(c.get("db"), c.get("apiKey"), c.req.param("name"), await body(c))))

  .delete("/:name", (c) => reply(c, () => deleteTemplate(c.get("db"), c.get("apiKey"), c.req.param("name"))));
