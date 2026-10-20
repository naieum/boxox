import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { labels, threadLabels } from "@boxox/db";
import { requireOrgAdmin, requireOrgMember, type AppContext } from "../middleware";

const labelSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine((n) => !/[\u0000-\u001F\u007F]/.test(n), "Label names cannot contain control characters"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});

const duplicate = (err: unknown) => /UNIQUE/i.test(`${(err as Error).message} ${(err as Error & { cause?: Error }).cause?.message ?? ""}`);

/** Gmail-style labels, shared by everyone on the install; threads carry many. */
export const labelRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember)

  .get("/", async (c) => {
    const db = c.get("db");
    const rows = await db
      .select({
        id: labels.id,
        name: labels.name,
        color: labels.color,
        threadCount: sql<number>`(SELECT count(*) FROM ${threadLabels} WHERE ${threadLabels.labelId} = ${labels.id})`,
      })
      .from(labels)
      .orderBy(asc(sql`lower(${labels.name})`));
    return c.json({ labels: rows });
  })

  .post("/", async (c) => {
    const parsed = labelSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: "Invalid label" } }, 400);
    }
    const db = c.get("db");
    const label = { id: crypto.randomUUID(), name: parsed.data.name, color: parsed.data.color ?? null };
    try {
      await db.insert(labels).values({ ...label, createdBy: c.get("user").id });
    } catch (err) {
      if (duplicate(err)) return c.json({ error: { code: "conflict", message: "A label with that name exists" } }, 409);
      throw err;
    }
    return c.json({ label }, 201);
  })

  .patch("/:labelId", async (c) => {
    const parsed = labelSchema.partial().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: "Invalid label" } }, 400);
    }
    const db = c.get("db");
    const patch: Partial<typeof labels.$inferInsert> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.color !== undefined) patch.color = parsed.data.color;
    if (!Object.keys(patch).length) return c.json({ error: { code: "bad_request", message: "Nothing to change" } }, 400);
    try {
      const updated = await db.update(labels).set(patch).where(eq(labels.id, c.req.param("labelId"))).returning();
      if (!updated[0]) return c.json({ error: { code: "not_found", message: "No such label" } }, 404);
      const { id, name, color } = updated[0];
      return c.json({ label: { id, name, color } });
    } catch (err) {
      if (duplicate(err)) return c.json({ error: { code: "conflict", message: "A label with that name exists" } }, 409);
      throw err;
    }
  })

  // Removes the label from every thread; the threads themselves stay put.
  .delete("/:labelId", requireOrgAdmin, async (c) => {
    const db = c.get("db");
    const labelId = c.req.param("labelId");
    const removed = await db.delete(labels).where(eq(labels.id, labelId)).returning({ id: labels.id });
    if (!removed[0]) return c.json({ error: { code: "not_found", message: "No such label" } }, 404);
    return c.json({ ok: true });
  });
