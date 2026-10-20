import { and, eq, inArray } from "drizzle-orm";
import { addresses, blockedSenders, domains } from "@boxox/db";
import { routeLocalPart, type AddressKind } from "@boxox/shared";
import type { Db } from "../../db";
import { splitRecipient } from "../../email";

export type InboundRoute =
  | {
      kind: "deliver";
      orgId: string;
      domainId: string;
      addressId: string;
      addressKind: AddressKind;
      via: "exact" | "catch_all";
      senderBlocked: boolean;
    }
  | { kind: "hold"; orgId: string; domainId: string; recipient: string; senderBlocked: boolean }
  | { kind: "drop"; orgId: string; recipient: string }
  | { kind: "unknown_domain"; recipient: string };

/**
 * Where the envelope recipient's copy goes. Each email() call is one
 * envelope recipient, so this routes exactly one address; the To and Cc
 * headers are sender-controlled and never decide delivery.
 */
export async function routeInbound(db: Db, recipient: string, senders: string[], now: Date): Promise<InboundRoute> {
  const { localPart, domain } = splitRecipient(recipient);
  const to = `${localPart}@${domain}`;
  const dom = await db.query.domains.findFirst({ where: eq(domains.name, domain) });
  if (!dom) return { kind: "unknown_domain", recipient: to };

  const candidates = await db
    .select({ id: addresses.id, localPart: addresses.localPart, status: addresses.status, expiresAt: addresses.expiresAt, kind: addresses.kind })
    .from(addresses)
    .where(eq(addresses.domainId, dom.id));
  const blocked = senders.length
    ? await db
        .select({ id: blockedSenders.id })
        .from(blockedSenders)
        .where(and(eq(blockedSenders.organizationId, dom.organizationId), inArray(blockedSenders.email, senders)))
        .limit(1)
    : [];
  const senderBlocked = blocked.length > 0;

  // Inactive domains follow the hold policy, so their mail is never dropped.
  const policy = dom.active ? dom : { ...dom, unknownMailPolicy: "hold" as const };
  const route = routeLocalPart(localPart, policy, candidates, now);
  if (route.kind === "deliver") {
    const address = candidates.find((a) => a.id === route.addressId)!;
    return {
      kind: "deliver",
      orgId: dom.organizationId,
      domainId: dom.id,
      addressId: address.id,
      addressKind: address.kind,
      via: route.via,
      senderBlocked,
    };
  }
  if (route.kind === "drop") return { kind: "drop", orgId: dom.organizationId, recipient: to };
  return { kind: "hold", orgId: dom.organizationId, domainId: dom.id, recipient: to, senderBlocked };
}
