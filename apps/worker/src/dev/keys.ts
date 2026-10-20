import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { apiKeyDomains, apiKeys, DOMAIN_KEY_PERMISSIONS, domains } from "@boxox/db";
import { writeAudit } from "../audit";
import { batch, type Db } from "../db";

export const MANAGEMENT_PREFIX = "bxm_";
export const DOMAIN_PREFIX = "bxk_";
export const DEFAULT_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;
export const MAX_ROTATION_OVERLAP_MS = 7 * DEFAULT_ROTATION_OVERLAP_MS;

export type DomainKeyPermission = (typeof DOMAIN_KEY_PERMISSIONS)[number];
type ApiKeyRow = typeof apiKeys.$inferSelect;

/** Who is acting: the owner in the UI, or a management key on /dev/v1/keys. */
export type KeyActor =
  | { type: "owner"; email: string; ip?: string }
  | { type: "management"; keyId: string; ip?: string };

export class KeyError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404,
    public readonly code: string,
    message: string,
    public readonly param?: string,
  ) {
    super(message);
    this.name = "KeyError";
  }
}

function toB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Prefix plus 256 random bits, base64url. */
export function generateSecret(prefix: typeof MANAGEMENT_PREFIX | typeof DOMAIN_PREFIX): string {
  return prefix + toB64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function actorRef(actor: KeyActor): string {
  return actor.type === "owner" ? `owner:${actor.email}` : `key:${actor.keyId}`;
}

async function audit(
  db: Db,
  orgId: string,
  actor: KeyActor,
  action: "api_key.created" | "api_key.rotated" | "api_key.revoked",
  keyId: string,
  metadata: Record<string, unknown>,
) {
  await writeAudit(db, {
    organizationId: orgId,
    actorType: actor.type === "owner" ? "user" : "api_key",
    actorId: actor.type === "owner" ? actor.email : actor.keyId,
    action,
    targetType: "api_key",
    targetId: keyId,
    metadata,
    ipAddress: actor.ip,
  });
}

function checkPermissions(perms: string[]): DomainKeyPermission[] {
  for (const p of perms) {
    if (!(DOMAIN_KEY_PERMISSIONS as readonly string[]).includes(p)) {
      throw new KeyError(400, "invalid_permission", `Unknown permission: ${p}`, "permissions");
    }
  }
  return [...new Set(perms)] as DomainKeyPermission[];
}

/** What is shown after creation: never the secret or its hash. */
export function publicKey(row: ApiKeyRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    domainId: row.domainId,
    parentKeyId: row.parentKeyId,
    display: `${row.prefix}…${row.last4}`,
    permissions: row.permissions,
    allowedFrom: row.allowedFrom,
    allowedRecipients: row.allowedRecipients,
    ipAllowlist: row.ipAllowlist,
    rateLimitPerMinute: row.rateLimitPerMinute,
    dailySendCap: row.dailySendCap,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    rotationEndsAt:
      row.previousSecretExpiresAt && row.previousSecretExpiresAt.getTime() > Date.now()
        ? row.previousSecretExpiresAt.toISOString()
        : null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}
export type PublicKey = ReturnType<typeof publicKey>;

async function orgDomains(db: Db, orgId: string, ids: string[]) {
  if (!ids.length) return [];
  return db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(and(eq(domains.organizationId, orgId), inArray(domains.id, ids)));
}

export interface ManagementKeyInput {
  name: string;
  domains: { domainId: string; grantablePermissions: string[]; dailySendBudget?: number | null }[];
}

/** Owner only: callers must be behind Access. There is no API route to this. */
export async function createManagementKey(
  db: Db,
  orgId: string,
  actor: Extract<KeyActor, { type: "owner" }>,
  input: ManagementKeyInput,
) {
  if (!input.domains.length) {
    throw new KeyError(400, "bad_request", "A management key needs at least one domain", "domains");
  }
  const ids = [...new Set(input.domains.map((d) => d.domainId))];
  if (ids.length !== input.domains.length) {
    throw new KeyError(400, "bad_request", "Each domain may be listed once", "domains");
  }
  if ((await orgDomains(db, orgId, ids)).length !== ids.length) {
    throw new KeyError(404, "not_found", "No such domain", "domains");
  }
  const grants = input.domains.map((d) => ({
    domainId: d.domainId,
    grantablePermissions: checkPermissions(d.grantablePermissions),
    dailySendBudget: d.dailySendBudget ?? null,
  }));

  const id = crypto.randomUUID();
  const secret = generateSecret(MANAGEMENT_PREFIX);
  await batch(db, [
    db.insert(apiKeys).values({
      id,
      kind: "management",
      name: input.name,
      secretHash: await hashSecret(secret),
      prefix: MANAGEMENT_PREFIX,
      last4: secret.slice(-4),
      createdBy: actorRef(actor),
    }),
    db.insert(apiKeyDomains).values(grants.map((g) => ({ apiKeyId: id, ...g }))),
  ]);
  await audit(db, orgId, actor, "api_key.created", id, { kind: "management", domains: grants });
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  return { key: { ...publicKey(row!), domains: grants }, secret };
}

export interface DomainKeyInput {
  name: string;
  domainId: string;
  permissions: string[];
  allowedFrom?: string[];
  allowedRecipients?: string[];
  ipAllowlist?: string[];
  rateLimitPerMinute?: number | null;
  dailySendCap?: number | null;
  expiresAt?: Date | null;
}

/** Live (unrevoked, unexpired) children of a management key on one domain. */
async function liveChildren(db: Db, parentKeyId: string, domainId: string) {
  return db
    .select({ id: apiKeys.id, dailySendCap: apiKeys.dailySendCap })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.parentKeyId, parentKeyId),
        eq(apiKeys.domainId, domainId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    );
}

/**
 * A management key may only mint for its own domains, with permissions it may
 * grant there, and caps inside its budget for that domain.
 */
export async function createDomainKey(db: Db, orgId: string, actor: KeyActor, input: DomainKeyInput) {
  const [domain] = await orgDomains(db, orgId, [input.domainId]);
  if (!domain) throw new KeyError(404, "not_found", "No such domain", "domain");
  const permissions = checkPermissions(input.permissions);
  if (!permissions.length) {
    throw new KeyError(400, "bad_request", "A domain key needs at least one permission", "permissions");
  }
  if (input.dailySendCap != null && input.dailySendCap < 0) {
    throw new KeyError(400, "bad_request", "dailySendCap must not be negative", "dailySendCap");
  }
  for (const from of input.allowedFrom ?? []) {
    if (!from.toLowerCase().endsWith(`@${domain.name.toLowerCase()}`)) {
      throw new KeyError(400, "bad_request", `${from} is not on ${domain.name}`, "allowedFrom");
    }
  }

  let dailySendCap = input.dailySendCap ?? null;
  if (actor.type === "management") {
    const [grant] = await db
      .select()
      .from(apiKeyDomains)
      .where(and(eq(apiKeyDomains.apiKeyId, actor.keyId), eq(apiKeyDomains.domainId, domain.id)));
    if (!grant) {
      throw new KeyError(403, "domain_not_allowed", "This key may not create keys for that domain", "domain");
    }
    const over = permissions.filter((p) => !grant.grantablePermissions.includes(p));
    if (over.length) {
      throw new KeyError(403, "exceeds_parent", `This key may not grant: ${over.join(", ")}`, "permissions");
    }
    if (grant.dailySendBudget != null && permissions.includes("send")) {
      const used = (await liveChildren(db, actor.keyId, domain.id)).reduce(
        (sum, k) => sum + (k.dailySendCap ?? 0),
        0,
      );
      const left = grant.dailySendBudget - used;
      if (dailySendCap == null) dailySendCap = left;
      if (dailySendCap > left || left <= 0) {
        throw new KeyError(
          403,
          "exceeds_parent",
          `dailySendCap exceeds the ${left} sends/day left in this key's budget`,
          "dailySendCap",
        );
      }
    }
  }

  const id = crypto.randomUUID();
  const secret = generateSecret(DOMAIN_PREFIX);
  await db.insert(apiKeys).values({
    id,
    kind: "domain",
    name: input.name,
    domainId: domain.id,
    parentKeyId: actor.type === "management" ? actor.keyId : null,
    secretHash: await hashSecret(secret),
    prefix: DOMAIN_PREFIX,
    last4: secret.slice(-4),
    permissions,
    allowedFrom: (input.allowedFrom ?? []).map((a) => a.toLowerCase()),
    allowedRecipients: (input.allowedRecipients ?? []).map((a) => a.toLowerCase()),
    ipAllowlist: input.ipAllowlist ?? [],
    rateLimitPerMinute: input.rateLimitPerMinute ?? null,
    dailySendCap,
    expiresAt: input.expiresAt ?? null,
    createdBy: actorRef(actor),
  });
  await audit(db, orgId, actor, "api_key.created", id, {
    kind: "domain",
    domain: domain.name,
    permissions,
    dailySendCap,
  });
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  return { key: publicKey(row!), secret };
}

/**
 * The keys an actor may change: the owner any key on its org's domains or any
 * management key; a management key only the children it created.
 */
async function loadForChange(db: Db, orgId: string, actor: KeyActor, keyId: string): Promise<ApiKeyRow> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
  const notFound = new KeyError(404, "not_found", "No such key");
  if (!row) throw notFound;
  if (actor.type === "management") {
    if (row.parentKeyId !== actor.keyId) throw notFound;
  } else if (row.domainId && !(await orgDomains(db, orgId, [row.domainId])).length) {
    throw notFound;
  }
  return row;
}

export async function rotateKey(
  db: Db,
  orgId: string,
  actor: KeyActor,
  keyId: string,
  overlapMs = DEFAULT_ROTATION_OVERLAP_MS,
) {
  if (!(overlapMs >= 0 && overlapMs <= MAX_ROTATION_OVERLAP_MS)) {
    throw new KeyError(400, "bad_request", "Overlap must be between 0 and 7 days", "overlapHours");
  }
  const row = await loadForChange(db, orgId, actor, keyId);
  if (row.revokedAt) throw new KeyError(400, "revoked", "A revoked key cannot be rotated");
  const secret = generateSecret(row.kind === "management" ? MANAGEMENT_PREFIX : DOMAIN_PREFIX);
  const previousSecretExpiresAt = new Date(Date.now() + overlapMs);
  await db
    .update(apiKeys)
    .set({
      secretHash: await hashSecret(secret),
      previousSecretHash: overlapMs > 0 ? row.secretHash : null,
      previousSecretExpiresAt: overlapMs > 0 ? previousSecretExpiresAt : null,
      last4: secret.slice(-4),
    })
    .where(eq(apiKeys.id, row.id));
  await audit(db, orgId, actor, "api_key.rotated", row.id, {
    kind: row.kind,
    previousValidUntil: previousSecretExpiresAt.toISOString(),
  });
  const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, row.id));
  return { key: publicKey(updated!), secret };
}

/**
 * Blocks the key at once. A management key's children keep working unless
 * `cascade` is set; only the owner can revoke a management key.
 */
export async function revokeKey(
  db: Db,
  orgId: string,
  actor: KeyActor,
  keyId: string,
  opts: { cascade?: boolean } = {},
) {
  const row = await loadForChange(db, orgId, actor, keyId);
  const now = new Date();
  const ids = [row.id];
  if (row.kind === "management" && opts.cascade) {
    const children = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.parentKeyId, row.id), isNull(apiKeys.revokedAt)));
    ids.push(...children.map((c) => c.id));
  }
  await db
    .update(apiKeys)
    .set({ revokedAt: now, previousSecretHash: null, previousSecretExpiresAt: null })
    .where(and(inArray(apiKeys.id, ids), isNull(apiKeys.revokedAt)));
  for (const id of ids) {
    await audit(db, orgId, actor, "api_key.revoked", id, {
      kind: id === row.id ? row.kind : "domain",
      ...(id === row.id ? { cascade: !!opts.cascade } : { byParent: row.id }),
    });
  }
  return { revoked: ids };
}

/** Owner view: management keys with their domains and children, then owner-made domain keys. */
export async function keyTree(db: Db, orgId: string) {
  const orgDomainRows = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(eq(domains.organizationId, orgId));
  const domainIds = orgDomainRows.map((d) => d.id);
  if (!domainIds.length) return { management: [], unparented: [], domains: [] };
  const grants = await db.select().from(apiKeyDomains).where(inArray(apiKeyDomains.domainId, domainIds));
  const mgmtIds = [...new Set(grants.map((g) => g.apiKeyId))];
  const rows = await db
    .select()
    .from(apiKeys)
    .where(
      or(
        inArray(apiKeys.domainId, domainIds),
        mgmtIds.length ? inArray(apiKeys.id, mgmtIds) : sql`0`,
      ),
    )
    .orderBy(apiKeys.createdAt);
  const children = rows.filter((r) => r.kind === "domain");
  return {
    domains: orgDomainRows,
    management: rows
      .filter((r) => r.kind === "management")
      .map((m) => ({
        ...publicKey(m),
        domains: grants
          .filter((g) => g.apiKeyId === m.id)
          .map((g) => ({
            domainId: g.domainId,
            grantablePermissions: g.grantablePermissions,
            dailySendBudget: g.dailySendBudget,
          })),
        children: children.filter((c) => c.parentKeyId === m.id).map(publicKey),
      })),
    unparented: children.filter((c) => !c.parentKeyId).map(publicKey),
  };
}

/** Management key view: domain keys on the domains it holds. */
export async function listKeysForManagement(db: Db, managementKeyId: string) {
  const grants = await db
    .select({ domainId: apiKeyDomains.domainId })
    .from(apiKeyDomains)
    .where(eq(apiKeyDomains.apiKeyId, managementKeyId));
  if (!grants.length) return [];
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.kind, "domain"), inArray(apiKeys.domainId, grants.map((g) => g.domainId))))
    .orderBy(apiKeys.createdAt);
  return rows.map(publicKey);
}

export interface AuthenticatedKey {
  id: string;
  kind: "management" | "domain";
  domainId: string | null;
  /** Lowercased domain name for domain keys. */
  domainName: string | null;
  permissions: DomainKeyPermission[];
  allowedFrom: string[];
  allowedRecipients: string[];
  ipAllowlist: string[];
  rateLimitPerMinute: number | null;
  dailySendCap: number | null;
  /** The org that owns the key's domain(s). */
  organizationId: string;
}

/**
 * Resolves a presented secret. The previous secret works until its overlap
 * window ends. Revoked and expired keys resolve to null.
 */
export async function authenticateSecret(
  db: Db,
  secret: string,
  now = new Date(),
): Promise<AuthenticatedKey | null> {
  if (!secret.startsWith(MANAGEMENT_PREFIX) && !secret.startsWith(DOMAIN_PREFIX)) return null;
  const hash = await hashSecret(secret);
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(
      or(
        eq(apiKeys.secretHash, hash),
        and(eq(apiKeys.previousSecretHash, hash), gt(apiKeys.previousSecretExpiresAt, now)),
      ),
    )
    .limit(1);
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  if (!secret.startsWith(row.prefix)) return null;

  let organizationId: string | undefined;
  let domainName: string | null = null;
  if (row.domainId) {
    const [d] = await db
      .select({ organizationId: domains.organizationId, name: domains.name })
      .from(domains)
      .where(eq(domains.id, row.domainId));
    organizationId = d?.organizationId;
    domainName = d?.name.toLowerCase() ?? null;
  } else {
    const [d] = await db
      .select({ organizationId: domains.organizationId })
      .from(apiKeyDomains)
      .innerJoin(domains, eq(domains.id, apiKeyDomains.domainId))
      .where(eq(apiKeyDomains.apiKeyId, row.id))
      .limit(1);
    organizationId = d?.organizationId;
  }
  if (!organizationId) return null;

  return {
    id: row.id,
    kind: row.kind,
    domainId: row.domainId,
    domainName,
    permissions: row.permissions as DomainKeyPermission[],
    allowedFrom: row.allowedFrom,
    allowedRecipients: row.allowedRecipients,
    ipAllowlist: row.ipAllowlist,
    rateLimitPerMinute: row.rateLimitPerMinute,
    dailySendCap: row.dailySendCap,
    organizationId,
  };
}

export async function recordKeyUse(db: Db, keyId: string, ip: string | null) {
  await db.update(apiKeys).set({ lastUsedAt: new Date(), lastUsedIp: ip }).where(eq(apiKeys.id, keyId));
}
