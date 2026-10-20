import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { DOMAIN_KEY_PERMISSIONS, domains } from "@boxox/db";
import { z } from "zod";
import { requireOrgAdmin, requireOrgMember, type AppContext } from "../middleware";
import { requireApiKey, requireManagementKey, type DevContext } from "./auth";
import {
  createDomainKey,
  createManagementKey,
  KeyError,
  keyTree,
  listKeysForManagement,
  revokeKey,
  rotateKey,
  type KeyActor,
} from "./keys";

const permission = z.enum(DOMAIN_KEY_PERMISSIONS);
const email = z.string().trim().email().max(320);

const domainKeyFields = {
  name: z.string().trim().min(1).max(100),
  permissions: z.array(permission).min(1),
  allowedFrom: z.array(email).max(50).optional(),
  allowedRecipients: z.array(email).max(50).optional(),
  ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  rateLimitPerMinute: z.number().int().positive().max(100_000).nullish(),
  dailySendCap: z.number().int().min(0).max(10_000_000).nullish(),
  expiresAt: z.string().datetime().nullish(),
};

export const apiCreateSchema = z.object({
  kind: z.literal("domain").optional(),
  domain: z.string().trim().min(1).max(253),
  ...domainKeyFields,
});

const ownerDomainKeySchema = z.object({ domainId: z.string().min(1), ...domainKeyFields });

const managementKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  domains: z
    .array(
      z.object({
        domainId: z.string().min(1),
        grantablePermissions: z.array(permission).min(1),
        dailySendBudget: z.number().int().min(0).max(10_000_000).nullish(),
      }),
    )
    .min(1)
    .max(100),
});

export const rotateSchema = z.object({ overlapHours: z.number().min(0).max(168).optional() }).optional();
const revokeSchema = z.object({ cascade: z.boolean().optional() }).optional();

function badRequest(c: Context, error: z.ZodError) {
  const issue = error.issues[0];
  return c.json(
    {
      error: {
        code: "bad_request",
        message: issue?.message ?? "Invalid request",
        ...(issue?.path.length ? { param: issue.path.join(".") } : {}),
      },
    },
    400,
  );
}

function keyErrorResponse(c: Context, err: unknown) {
  if (!(err instanceof KeyError)) throw err;
  return c.json(
    { error: { code: err.code, message: err.message, ...(err.param ? { param: err.param } : {}) } },
    err.status,
  );
}

async function body(c: Context) {
  const text = await c.req.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function overlapMs(hours: number | undefined) {
  return hours === undefined ? undefined : Math.round(hours * 60 * 60 * 1000);
}

/**
 * /dev/v1/keys: management keys mint, list, rotate and revoke domain keys for
 * their own domains. Management keys are never created here.
 */
export const devKeyRoutes = new Hono<DevContext>()
  .use("*", requireApiKey)
  .use("*", requireManagementKey)

  .get("/", async (c) => c.json({ data: await listKeysForManagement(c.get("db"), c.get("apiKey").id) }))

  .post("/", async (c) => {
    const raw = await body(c);
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (kind !== undefined && kind !== "domain") {
      return c.json(
        { error: { code: "forbidden", message: "Management keys can only be created in the Box Ox UI", param: "kind" } },
        403,
      );
    }
    const parsed = apiCreateSchema.safeParse(raw);
    if (!parsed.success) return badRequest(c, parsed.error);
    const key = c.get("apiKey");
    const db = c.get("db");
    const [domain] = await db
      .select({ id: domains.id })
      .from(domains)
      .where(and(eq(domains.organizationId, key.organizationId), eq(domains.name, parsed.data.domain.toLowerCase())));
    const actor: KeyActor = { type: "management", keyId: key.id, ip: c.req.header("cf-connecting-ip") };
    try {
      if (!domain) throw new KeyError(403, "domain_not_allowed", "This key may not create keys for that domain", "domain");
      const { domain: _d, kind: _k, expiresAt, ...rest } = parsed.data;
      const created = await createDomainKey(db, key.organizationId, actor, {
        ...rest,
        domainId: domain.id,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      });
      return c.json(created, 201);
    } catch (err) {
      return keyErrorResponse(c, err);
    }
  })

  .post("/:id/rotate", async (c) => {
    const parsed = rotateSchema.safeParse(await body(c));
    if (!parsed.success) return badRequest(c, parsed.error);
    const key = c.get("apiKey");
    const actor: KeyActor = { type: "management", keyId: key.id, ip: c.req.header("cf-connecting-ip") };
    try {
      return c.json(await rotateKey(c.get("db"), key.organizationId, actor, c.req.param("id"), overlapMs(parsed.data?.overlapHours)));
    } catch (err) {
      return keyErrorResponse(c, err);
    }
  })

  .post("/:id/revoke", async (c) => {
    const key = c.get("apiKey");
    const actor: KeyActor = { type: "management", keyId: key.id, ip: c.req.header("cf-connecting-ip") };
    try {
      return c.json(await revokeKey(c.get("db"), key.organizationId, actor, c.req.param("id")));
    } catch (err) {
      return keyErrorResponse(c, err);
    }
  });

/** /api/orgs/:orgId/dev/keys: the owner's Developer → Keys page, behind Access. */
export const ownerKeyRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember)
  .use("*", requireOrgAdmin)

  .get("/", async (c) => c.json(await keyTree(c.get("db"), c.get("orgId"))))

  .post("/management", async (c) => {
    const parsed = managementKeySchema.safeParse(await body(c));
    if (!parsed.success) return badRequest(c, parsed.error);
    const user = c.get("user");
    try {
      const created = await createManagementKey(
        c.get("db"),
        c.get("orgId"),
        { type: "owner", email: user.email, ip: c.req.header("cf-connecting-ip") },
        parsed.data,
      );
      return c.json(created, 201);
    } catch (err) {
      return keyErrorResponse(c, err);
    }
  })

  .post("/domain", async (c) => {
    const parsed = ownerDomainKeySchema.safeParse(await body(c));
    if (!parsed.success) return badRequest(c, parsed.error);
    const user = c.get("user");
    const { expiresAt, ...rest } = parsed.data;
    try {
      const created = await createDomainKey(
        c.get("db"),
        c.get("orgId"),
        { type: "owner", email: user.email, ip: c.req.header("cf-connecting-ip") },
        { ...rest, expiresAt: expiresAt ? new Date(expiresAt) : null },
      );
      return c.json(created, 201);
    } catch (err) {
      return keyErrorResponse(c, err);
    }
  })

  .post("/:id/rotate", async (c) => {
    const parsed = rotateSchema.safeParse(await body(c));
    if (!parsed.success) return badRequest(c, parsed.error);
    const user = c.get("user");
    try {
      return c.json(
        await rotateKey(
          c.get("db"),
          c.get("orgId"),
          { type: "owner", email: user.email, ip: c.req.header("cf-connecting-ip") },
          c.req.param("id"),
          overlapMs(parsed.data?.overlapHours),
        ),
      );
    } catch (err) {
      return keyErrorResponse(c, err);
    }
  })

  .post("/:id/revoke", async (c) => {
    const parsed = revokeSchema.safeParse(await body(c));
    if (!parsed.success) return badRequest(c, parsed.error);
    const user = c.get("user");
    try {
      return c.json(
        await revokeKey(
          c.get("db"),
          c.get("orgId"),
          { type: "owner", email: user.email, ip: c.req.header("cf-connecting-ip") },
          c.req.param("id"),
          { cascade: parsed.data?.cascade },
        ),
      );
    } catch (err) {
      return keyErrorResponse(c, err);
    }
  });
