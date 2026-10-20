import { env } from "cloudflare:test";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { createDb } from "../src/db";
import type { Env } from "../src/env";
import type { AppContext } from "../src/middleware";
import { operationsRoutes } from "../src/routes/operations";
import { id } from "./helpers/seed";
const app = new Hono<AppContext>().use("*", async (c, next) => {
  c.set("db", createDb(c.env));
  const role = c.req.header("x-test-role");
  if (role) c.set("user", { id: "owner@test", email: "owner@test", name: "Owner", role });
  await next();
}).route("/", operationsRoutes);
it("protects operational metrics and recovery behind installer-only access", async () => {
  for (const path of ["/capacity", "/ingest"]) {
    expect((await app.request(path, {}, env as Env)).status).toBe(401);
    expect((await app.request(path, { headers: { "x-test-role": "member" } }, env as Env)).status).toBe(403);
  }
});
it("reports durable pending lag, completed latency and ambiguous sends without mail content", async () => {
  const now = Date.now(); const key = id();
  await env.DB.prepare("INSERT INTO ingest_jobs(raw_key,received_at,status,next_attempt_at,updated_at,created_at) VALUES(?,?,'pending',?,?,?)").bind(key, new Date(now).toISOString(), now, now, now - 60_000).run();
  await env.DB.prepare("INSERT INTO ingest_jobs(raw_key,received_at,status,next_attempt_at,updated_at,created_at,completed_at) VALUES(?,?,'complete',?,?,?,?)").bind(id(), new Date(now).toISOString(), now, now, now - 1000, now).run();
  const result = await app.request("/capacity", { headers: { "x-test-role": "owner" } }, env as Env);
  expect(result.status).toBe(200);
  const body = await result.json() as any;
  expect(body.ingestion.oldestPendingAgeMs).toBeGreaterThanOrEqual(60_000);
  expect(body.ingestion.completedLastFiveMinutes).toBeGreaterThanOrEqual(1);
  expect(body.ingestion.averageIngestMs).toBe(1000);
  expect(body.limits.ingestionConcurrency).toBe(8);
  expect(JSON.stringify(body)).not.toContain(key);
  expect(body.measurement).toContain("not physical");
});
