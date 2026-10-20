import { Hono } from "hono";
import { z } from "zod";
import { AgentError, attachAgent, type AgentEnv } from "./agent-api";
import { claimAgentWork, completeAgentWork, completeAgentWorkBatch, listAgentWork, renewAgentWork, retryAgentWork, MAX_WORK_BATCH } from "../services/agent-work";

const group = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional();
const reference = z.object({ messageId: z.string().min(1).max(128), claimToken: z.string().min(1).max(256), group }).strict();
const claim = z.object({ messageId: z.string().min(1).max(128), group, leaseSeconds: z.number().int().min(1).max(3600).optional() }).strict();
const renew = reference.extend({ leaseSeconds: z.number().int().min(1).max(3600).optional() });
const retry = reference.extend({ delaySeconds: z.number().int().min(0).max(86400).optional() });
const completeBatch = z.object({ items: z.array(reference).min(1).max(MAX_WORK_BATCH) }).strict();

/** Mounted alongside agent_apiRoutes at /api/agent/v1. Work state never changes read/unread or mail folders. */
export const agentWorkRoutes = new Hono<AgentEnv>().use("/work/*", attachAgent).use("/addresses/:addressId/work", attachAgent)
  .onError((error, c) => {
    if (error instanceof AgentError) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400 | 403 | 404 | 409);
    throw error;
  })
  .get("/addresses/:addressId/work", async (c) => {
    const query = z.object({ group, cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).safeParse(c.req.query());
    if (!query.success) return c.json({ error: { code: "bad_request", message: "Invalid work query" } }, 400);
    return c.json(await listAgentWork(c.get("db"), c.get("agent"), c.get("grants"), c.req.param("addressId"), query.data));
  })
  .post("/work/claim", async (c) => {
    const parsed = claim.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "bad_request", message: "Invalid work claim" } }, 400);
    return c.json(await claimAgentWork(c.get("db"), c.get("agent"), c.get("grants"), parsed.data));
  })
  .post("/work/complete", async (c) => {
    const parsed = reference.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "bad_request", message: "Invalid work acknowledgment" } }, 400);
    return c.json(await completeAgentWork(c.get("db"), c.get("agent"), c.get("grants"), parsed.data));
  })
  .post("/work/complete-batch", async (c) => {
    const parsed = completeBatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "bad_request", message: `Provide 1–${MAX_WORK_BATCH} claims` } }, 400);
    return c.json(await completeAgentWorkBatch(c.get("db"), c.get("agent"), c.get("grants"), parsed.data.items));
  })
  .post("/work/renew", async (c) => {
    const parsed = renew.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "bad_request", message: "Invalid work renewal" } }, 400);
    return c.json(await renewAgentWork(c.get("db"), c.get("agent"), c.get("grants"), parsed.data));
  })
  .post("/work/retry", async (c) => {
    const parsed = retry.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "bad_request", message: "Invalid work retry" } }, 400);
    return c.json(await retryAgentWork(c.get("db"), c.get("agent"), c.get("grants"), parsed.data));
  });
