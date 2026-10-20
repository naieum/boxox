import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireApiKey, requireDomainKey, type DevContext } from "./auth";
import {
  batchSchema,
  cancelMessage,
  claimIdempotencyKey,
  completeIdempotencyKey,
  getMessage,
  LIST_STATUSES,
  listMessages,
  MessageError,
  prepareMessage,
  queueMessages,
  releaseIdempotencyKey,
  requestHash,
  rescheduleMessage,
  rescheduleSchema,
  zodError,
  type PreparedMessage,
} from "./messages";
import { applyTemplate } from "./templates";

type Reply = { status: number; body: unknown };

export const listQuery = z.object({
  status: z.enum(LIST_STATUSES).optional(),
  tag: z.string().min(1).max(300).optional(),
  recipient: z.string().min(3).max(320).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function errorReply(err: unknown): Reply {
  if (!(err instanceof MessageError)) throw err;
  return { status: err.status, body: { error: err.toJSON() } };
}

function send(reply: Reply, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MessageError(400, "bad_request", "The body must be JSON");
  }
}

/**
 * Runs `handler` once per (key, Idempotency-Key). A replay returns the stored
 * response; a different body or a request still in flight gets 409. Server
 * errors free the key so the client can retry.
 */
async function idempotent(c: Context<DevContext>, handler: (body: unknown) => Promise<Reply>): Promise<Response> {
  const text = await c.req.text();
  const idemKey = c.req.header("idempotency-key")?.trim();
  const run = async () => {
    try {
      return await handler(parseJson(text));
    } catch (err) {
      return errorReply(err);
    }
  };
  if (!idemKey) return send(await run());
  if (idemKey.length > 255) {
    return send(errorReply(new MessageError(400, "bad_request", "Idempotency-Key is at most 255 characters", "Idempotency-Key")));
  }

  const db = c.get("db");
  const key = c.get("apiKey");
  const claim = await claimIdempotencyKey(db, key.id, idemKey, await requestHash(c.req.method, c.req.path, text));
  if (claim.kind === "conflict") return send(errorReply(claim.error));
  if (claim.kind === "replay") {
    return new Response(claim.body, {
      status: claim.status,
      headers: { "content-type": "application/json", "idempotent-replayed": "true" },
    });
  }
  let reply: Reply;
  try {
    reply = await run();
  } catch (err) {
    await releaseIdempotencyKey(db, claim.id);
    throw err;
  }
  if (reply.status >= 500) await releaseIdempotencyKey(db, claim.id);
  else await completeIdempotencyKey(db, claim.id, reply.status, JSON.stringify(reply.body));
  return send(reply);
}

/**
 * /dev/v1/messages: domain keys only, and every row is filtered to the key's
 * own domain. Sending, rescheduling and canceling need `send`; the log needs
 * `read_log`.
 */
export const devMessageRoutes = new Hono<DevContext>()
  .use("*", requireApiKey)

  .post("/", requireDomainKey("send"), (c) =>
    idempotent(c, async (raw) => {
      const { body, templateId } = await applyTemplate(c.get("db"), c.get("apiKey"), raw);
      const prepared = { ...prepareMessage(c.get("apiKey"), body), templateId };
      const [result] = await queueMessages(c.env, c.get("apiKey"), [prepared]);
      return { status: 202, body: result };
    }),
  )

  .post("/batch", requireDomainKey("send"), (c) =>
    idempotent(c, async (raw) => {
      const parsed = batchSchema.safeParse(raw);
      if (!parsed.success) throw zodError(parsed.error);
      const key = c.get("apiKey");
      const ok: { index: number; message: PreparedMessage }[] = [];
      const errors: { index: number; code: string; message: string; param?: string }[] = [];
      for (const [index, m] of parsed.data.messages.entries()) {
        try {
          const { body, templateId } = await applyTemplate(c.get("db"), key, m);
          ok.push({ index, message: { ...prepareMessage(key, body), templateId } });
        } catch (err) {
          if (!(err instanceof MessageError)) throw err;
          errors.push({ index, ...err.toJSON() });
        }
      }
      if (errors.length && (parsed.data.mode === "all_or_nothing" || !ok.length)) {
        return {
          status: 422,
          body: {
            error: { code: "batch_rejected", message: `${errors.length} of ${parsed.data.messages.length} messages are invalid; none were sent` },
            errors,
          },
        };
      }
      const results = await queueMessages(c.env, key, ok.map((o) => o.message));
      return {
        status: 202,
        body: { data: results.map((r, i) => ({ index: ok[i]!.index, ...r })), errors },
      };
    }),
  )

  .get("/", requireDomainKey("read_log"), async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return send(errorReply(zodError(parsed.error)));
    try {
      return c.json(await listMessages(c.get("db"), c.get("apiKey"), parsed.data));
    } catch (err) {
      return send(errorReply(err));
    }
  })

  .get("/:id", requireDomainKey("read_log"), async (c) => {
    try {
      return c.json(await getMessage(c.env, c.get("apiKey"), c.req.param("id")));
    } catch (err) {
      return send(errorReply(err));
    }
  })

  .patch("/:id", requireDomainKey("send"), async (c) => {
    try {
      const parsed = rescheduleSchema.safeParse(parseJson(await c.req.text()));
      if (!parsed.success) throw zodError(parsed.error);
      return c.json(await rescheduleMessage(c.env, c.get("apiKey"), c.req.param("id"), parsed.data.sendAt));
    } catch (err) {
      return send(errorReply(err));
    }
  })

  .post("/:id/cancel", requireDomainKey("send"), async (c) => {
    try {
      return c.json(await cancelMessage(c.env, c.get("apiKey"), c.req.param("id")));
    } catch (err) {
      return send(errorReply(err));
    }
  });
