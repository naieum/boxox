import { Hono, type Context } from "hono";
import { z } from "zod";
import { attachmentHeaders } from "../services/attachments";
import { requireApiKey, requireDomainKey, type DevContext } from "./auth";
import { MessageError, zodError } from "./messages";
import { getReceived, listReceived, rawDownloadUrl, receivedAttachment, resolveRawToken, MAX_RAW_TTL_S } from "./received";

export const listQuery = z.object({
  to: z.string().min(3).max(320).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const rawQuery = z.object({ expiresIn: z.coerce.number().int().min(60).max(MAX_RAW_TTL_S).optional() });

async function reply(c: Context<DevContext>, run: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json(await run());
  } catch (err) {
    if (!(err instanceof MessageError)) throw err;
    return c.json({ error: err.toJSON() }, err.status);
  }
}

/**
 * /dev/v1/received: domain keys with `read_received`, only the key's domain's
 * app inboxes. GET /raw/:token is the signed .eml link and takes no key; the
 * token is the credential.
 */
export const devReceivedRoutes = new Hono<DevContext>()
  .get("/raw/:token", async (c) => {
    const found = await resolveRawToken(c.env, c.req.param("token"));
    const obj = found ? await c.env.MAIL_STORE.get(found.rawMimeKey) : null;
    if (!found || !obj) {
      return c.json({ error: { code: "not_found", message: "This link is invalid or has expired" } }, 404);
    }
    return new Response(obj.body, {
      headers: {
        "Content-Type": "message/rfc822",
        "Content-Length": String(obj.size),
        "Content-Disposition": `attachment; filename="${found.id}.eml"`,
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  })

  .use("*", requireApiKey, requireDomainKey("read_received"))

  .get("/", (c) =>
    reply(c, async () => {
      const parsed = listQuery.safeParse(c.req.query());
      if (!parsed.success) throw zodError(parsed.error);
      return listReceived(c.get("db"), c.get("apiKey"), parsed.data);
    }),
  )

  .get("/:id", (c) => reply(c, () => getReceived(c.env, c.get("apiKey"), c.req.param("id"))))

  .get("/:id/raw", (c) =>
    reply(c, async () => {
      const parsed = rawQuery.safeParse(c.req.query());
      if (!parsed.success) throw zodError(parsed.error);
      return rawDownloadUrl(c.env, c.get("apiKey"), c.req.param("id"), parsed.data.expiresIn);
    }),
  )

  .get("/:id/attachments/:attachmentId", async (c) => {
    try {
      const att = await receivedAttachment(c.get("db"), c.get("apiKey"), c.req.param("id"), c.req.param("attachmentId"));
      const obj = await c.env.MAIL_STORE.get(att.r2Key);
      if (!obj) throw new MessageError(404, "not_found", "Attachment data missing");
      return new Response(obj.body, { headers: attachmentHeaders(att) });
    } catch (err) {
      if (!(err instanceof MessageError)) throw err;
      return c.json({ error: err.toJSON() }, err.status);
    }
  });
