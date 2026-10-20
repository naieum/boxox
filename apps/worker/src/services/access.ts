import { and, eq, or } from "drizzle-orm";
import { addressGrants, addresses } from "@boxox/db";
import type { GrantPermission } from "@boxox/shared";
import type { Db } from "../db";

export interface Accessor {
  userId: string;
  email: string;
  /** Org role from the membership row. */
  role: string;
}

export function isOrgAdmin(a: Accessor): boolean {
  return a.role === "owner" || a.role === "admin";
}

/**
 * Address ids the accessor may act on with the given permission.
 * Owners/admins see every address in the org; grant holders only theirs.
 * Returns null to mean "all org addresses" (no filter needed).
 */
export async function accessibleAddressIds(
  db: Db,
  orgId: string,
  accessor: Accessor,
  permission: GrantPermission,
): Promise<string[] | null> {
  if (isOrgAdmin(accessor)) return null;
  const rows = await db
    .select({ addressId: addressGrants.addressId, permissions: addressGrants.permissions })
    .from(addressGrants)
    .where(
      and(
        eq(addressGrants.organizationId, orgId),
        eq(addressGrants.principalType, "user"),
        or(
          eq(addressGrants.principalId, accessor.userId),
          eq(addressGrants.inviteEmail, accessor.email.toLowerCase()),
        ),
      ),
    );
  return rows
    .filter((r) => Array.isArray(r.permissions) && (r.permissions as string[]).includes(permission))
    .map((r) => r.addressId);
}

/** True if accessor may send from this address (must be active). */
export async function canSendFrom(
  db: Db,
  orgId: string,
  accessor: Accessor,
  addressId: string,
): Promise<boolean> {
  const rows = await db
    .select({ status: addresses.status })
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.organizationId, orgId)))
    .limit(1);
  const addr = rows[0];
  if (!addr || addr.status !== "active") return false;
  if (isOrgAdmin(accessor)) return true;
  const ids = await accessibleAddressIds(db, orgId, accessor, "send");
  return ids !== null && ids.includes(addressId);
}
