import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { addresses, attachments, domains, messages } from "@boxox/db";
import { requireOrgMember, type AppContext } from "../middleware";
import { accessibleAddressIds } from "../services/access";
import { attachmentHeaders, attachmentKey, attachmentText } from "../services/attachments";
import { loadAssistConfig } from "../services/assist";

function accessorOf(c: { get: (k: "user" | "orgRole") => unknown }) {
  const user = c.get("user") as { id: string; email: string };
  return { userId: user.id, email: user.email, role: c.get("orgRole") as string };
}

const notFound = { error: { code: "not_found", message: "No such attachment" } };

export const attachmentRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember)

  // Download. ?inline=1 views safe images and PDFs in place; dangerous files need ?accept_risk=1.
  .get("/:attachmentId", async (c) => {
    const att = await readable(c);
    if (att instanceof Response) return att;
    if (att.risk === "dangerous" && c.req.query("accept_risk") !== "1") {
      return c.json(
        { error: { code: "dangerous_attachment", message: "This file can harm your computer. Download it only if you trust the sender." } },
        409,
      );
    }
    const obj = await c.env.MAIL_STORE.get(att.r2Key);
    if (!obj) return c.json({ error: { code: "not_found", message: "Attachment data missing" } }, 404);
    return new Response(obj.body, { headers: attachmentHeaders(att, { inline: c.req.query("inline") === "1" }) });
  })

  // toMarkdown text of a document attachment, converted on first request when AI is on.
  .get("/:attachmentId/text", async (c) => {
    const att = await readable(c);
    if (att instanceof Response) return att;
    const db = c.get("db");
    const { consent } = await loadAssistConfig(db);
    const mailbox = att.addressId ? await db.select({ localPart: addresses.localPart, domain: domains.name })
      .from(addresses).innerJoin(domains, eq(domains.id, addresses.domainId))
      .where(eq(addresses.id, att.addressId)).get() : null;
    const result = await attachmentText(
      {
        db,
        bucket: c.env.MAIL_STORE,
        ai: c.env.AI,
        consent: mailbox ? consent : { ...consent, enabled: false },
      },
      att,
      mailbox ? `${mailbox.localPart}@${mailbox.domain}`.toLowerCase() : undefined,
    );
    if (!result.ok) {
      return c.json({ error: { code: "no_text", message: "No text is available for this attachment", reason: result.reason } }, 404);
    }
    return c.json({ id: att.id, filename: att.filename, text: result.text });
  });

/** The row, if this org owns it and the caller may read its mailbox. */
async function readable(c: Context<AppContext>) {
  const db = c.get("db");
  const orgId = c.get("orgId");
  const [row] = await db
    .select({
      id: attachments.id,
      sha256: attachments.sha256,
      filename: attachments.filename,
      detectedType: attachments.detectedType,
      size: attachments.size,
      risk: attachments.risk,
      textR2Key: attachments.textR2Key,
      addressId: messages.addressId,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(attachments.id, c.req.param("attachmentId") ?? ""), eq(messages.organizationId, orgId)))
    .limit(1);
  if (!row) return c.json(notFound, 404);
  const allowed = await accessibleAddressIds(db, orgId, accessorOf(c), "read");
  if (allowed !== null && (!row.addressId || !allowed.includes(row.addressId))) {
    return c.json({ error: { code: "forbidden", message: "No access to this mailbox" } }, 403);
  }
  return { ...row, r2Key: attachmentKey(row.sha256) };
}
