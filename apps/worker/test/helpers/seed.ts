import { addresses, domains, messages, threads } from "@boxox/db";
import type { Db } from "../../src/db";

export const id = () => crypto.randomUUID();

/** One domain with one address in `orgId`; the D1 counterpart of v1's seedOrg. */
export async function seedMailbox(db: Db, opts: { orgId: string; domain?: string; localPart?: string }) {
  const domainId = id();
  const addressId = id();
  await db.insert(domains).values({ id: domainId, organizationId: opts.orgId, name: opts.domain ?? `${domainId}.test` });
  await db.insert(addresses).values({
    id: addressId,
    domainId,
    organizationId: opts.orgId,
    localPart: opts.localPart ?? "me",
    createdBy: "owner@example.test",
  });
  return { orgId: opts.orgId, domainId, addressId };
}

export async function seedThread(db: Db, mailbox: { orgId: string; addressId: string }, over: Partial<typeof threads.$inferInsert> = {}) {
  const threadId = over.id ?? id();
  await db.insert(threads).values({ organizationId: mailbox.orgId, addressId: mailbox.addressId, ...over, id: threadId });
  return threadId;
}

export function messageRow(
  mailbox: { orgId: string; addressId: string },
  threadId: string,
  over: Partial<typeof messages.$inferInsert> = {},
): typeof messages.$inferInsert {
  const messageId = over.id ?? id();
  return {
    id: messageId,
    threadId,
    organizationId: mailbox.orgId,
    addressId: mailbox.addressId,
    dedupeScope: mailbox.addressId,
    direction: "inbound",
    fromEmail: "sender@ext.test",
    r2Key: `raw/${messageId}`,
    rfcMessageId: `<${messageId}@ext.test>`,
    ...over,
  };
}

/** Drizzle wraps D1 errors; the SQLite reason is on the cause. */
export async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} ${e.cause?.message ?? ""}`;
  }
  throw new Error("expected the statement to be rejected");
}
