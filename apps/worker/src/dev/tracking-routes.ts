import { Hono } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { log } from "../log";
import { recordTrackingEvent, verifyToken } from "./tracking";

/** Transparent 1×1 GIF. */
const PIXEL = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (ch) => ch.charCodeAt(0));

const NO_STORE = { "cache-control": "no-store, private", "referrer-policy": "no-referrer" };

async function record(env: Env, payload: Parameters<typeof recordTrackingEvent>[1], userAgent: string | undefined) {
  try {
    await recordTrackingEvent(createDb(env), payload, userAgent, Date.now(), env);
  } catch (err) {
    log.error("tracking_record_failed", { messageId: payload.m, error: err });
  }
}

/**
 * Public, unauthenticated: /t/o/:token is the open pixel, /t/c/:token a click
 * redirect. The pixel looks the same whether or not the token is valid; a
 * click is followed only when we signed its URL.
 */
export const trackingRoutes = new Hono<{ Bindings: Env }>()
  .get("/o/:token", async (c) => {
    const payload = await verifyToken(c.env, c.req.param("token"));
    if (payload && payload.u === undefined) await record(c.env, payload, c.req.header("user-agent"));
    return new Response(PIXEL, { headers: { "content-type": "image/gif", ...NO_STORE } });
  })

  .get("/c/:token", async (c) => {
    const payload = await verifyToken(c.env, c.req.param("token"));
    if (!payload?.u) {
      return new Response("This link is not valid.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE } });
    }
    await record(c.env, payload, c.req.header("user-agent"));
    return new Response(null, { status: 302, headers: { location: payload.u, ...NO_STORE } });
  });
