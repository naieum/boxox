import { createMiddleware } from "hono/factory";
import type { AppContext } from "../middleware";
import {
  authenticateSecret,
  recordKeyUse,
  type AuthenticatedKey,
  type DomainKeyPermission,
} from "./keys";

export type DevContext = {
  Bindings: AppContext["Bindings"];
  Variables: AppContext["Variables"] & { apiKey: AuthenticatedKey };
};

export function devError(status: 401 | 403, code: string, message: string, param?: string) {
  return Response.json({ error: { code, message, ...(param ? { param } : {}) } }, { status });
}

/** Exact IPs or IPv4 CIDRs. An empty list allows any address. */
export function ipAllowed(allowlist: string[], ip: string | null): boolean {
  if (!allowlist.length) return true;
  if (!ip) return false;
  return allowlist.some((entry) => {
    const [base, bits] = entry.split("/");
    if (bits === undefined) return base === ip;
    const toInt = (a: string) => {
      const parts = a.split(".").map(Number);
      if (parts.length !== 4 || parts.some((n) => !(n >= 0 && n <= 255))) return null;
      return parts.reduce((acc, n) => (acc << 8) + n, 0) >>> 0;
    };
    const a = toInt(base!);
    const b = toInt(ip);
    const n = Number(bits);
    if (a === null || b === null || !(n >= 0 && n <= 32)) return false;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    return (a & mask) === (b & mask);
  });
}

/** Authenticates `Authorization: Bearer bxm_…|bxk_…` on /dev/v1. */
export const requireApiKey = createMiddleware<DevContext>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const key = match ? await authenticateSecret(c.get("db"), match[1]!) : null;
  if (!key) return devError(401, "unauthorized", "A valid API key is required");
  const ip = c.req.header("cf-connecting-ip") ?? null;
  if (!ipAllowed(key.ipAllowlist, ip)) {
    return devError(403, "ip_not_allowed", "This key may not be used from this address");
  }
  await recordKeyUse(c.get("db"), key.id, ip);
  c.set("apiKey", key);
  await next();
});

/** Key-management routes: management keys only. */
export const requireManagementKey = createMiddleware<DevContext>(async (c, next) => {
  if (c.get("apiKey")?.kind !== "management") {
    return devError(403, "forbidden", "Only a management key can manage keys");
  }
  await next();
});

/**
 * Mail routes: a domain key holding `permission`. Management keys never pass,
 * so they can't send or read mail.
 */
export function requireDomainKey(permission: DomainKeyPermission) {
  return createMiddleware<DevContext>(async (c, next) => {
    const key = c.get("apiKey");
    if (key?.kind !== "domain") {
      return devError(403, "forbidden", "Management keys cannot send or read mail");
    }
    if (!key.permissions.includes(permission)) {
      return devError(403, "missing_permission", `This key lacks the ${permission} permission`);
    }
    await next();
  });
}

/** True only for the key's own domain; routes check every domain-scoped row with this. */
export function keyCoversDomain(key: AuthenticatedKey, domainId: string | null | undefined): boolean {
  return key.kind === "domain" && !!domainId && key.domainId === domainId;
}

function addressOf(value: string): string {
  const angle = /<([^>]+)>\s*$/.exec(value);
  return (angle ? angle[1]! : value).trim().toLowerCase();
}

/** The From address must be on the key's domain and in its allowedFrom list, if any. */
export function keyMaySendFrom(key: AuthenticatedKey, from: string): boolean {
  if (key.kind !== "domain" || !key.domainName) return false;
  const addr = addressOf(from);
  const at = addr.lastIndexOf("@");
  if (at < 1 || addr.slice(at + 1) !== key.domainName) return false;
  return !key.allowedFrom.length || key.allowedFrom.includes(addr);
}

/** Received-mail reads: the address must be on the key's domain and in allowedRecipients, if any. */
export function keyMayReadAddress(key: AuthenticatedKey, address: string): boolean {
  if (key.kind !== "domain" || !key.domainName) return false;
  const addr = addressOf(address);
  if (addr.slice(addr.lastIndexOf("@") + 1) !== key.domainName) return false;
  return !key.allowedRecipients.length || key.allowedRecipients.includes(addr);
}
