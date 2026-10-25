import { and, desc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { drafts, messages, threads } from "@boxox/db";
import { makeSnippet } from "@boxox/shared";
import { requireOrgMember, type AppContext } from "../middleware";
import { accessibleAddressIds, canSendFrom } from "../services/access";
import { cleanFilename } from "../services/attachments";
import { DEFAULT_LINK_DAYS, MAX_LINK_DAYS } from "./share-links";
import { actorOf, COMPOSE_MODES, composeAndQueue, composeResponse, MAX_ATTACHMENTS } from "./send";

/**
 * Autosaved drafts: one per thread (replies) plus any number of standalone
 * ones, each private to the person writing it. Draft files are uploaded one
 * per request to drafts/<draftId>/ in R2 and checked against size and count
 * limits. Sending a draft, now or at `sendAt`, goes through the same compose
 * path as /send and removes the draft.
 */

export const MAX_DRAFT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_DRAFT_TOTAL_BYTES = 100 * 1024 * 1024;

interface DraftFile {
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
}

type DraftRow = typeof drafts.$inferSelect;

const recipients = z.array(z.string().max(320)).max(200);

const draftFields = z.object({
  fromAddressId: z.string(),
  threadId: z.string().nullable(),
  replyToMessageId: z.string().nullable(),
  mode: z.enum(COMPOSE_MODES),
  to: recipients,
  cc: recipients,
  bcc: recipients,
  subject: z.string().max(998),
  text: z.string().max(500_000),
  html: z.string().max(2_000_000).nullable(),
  sendAt: z.string().datetime({ offset: true }).nullable(),
});

const createSchema = draftFields.partial().required({ fromAddressId: true });
const patchSchema = draftFields.partial();

const sendSchema = z
  .object({
    sendAt: z.string().datetime({ offset: true }).nullable().optional(),
    attachmentsMode: z.enum(["link", "fail"]).default("link"),
    linkExpiresInDays: z.number().int().min(1).max(MAX_LINK_DAYS).default(DEFAULT_LINK_DAYS),
    includeOriginalAttachments: z.boolean().default(true),
  })
  .prefault({});

const notFound = { error: { code: "not_found", message: "No such draft" } } as const;

function view(d: DraftRow) {
  return {
    id: d.id,
    fromAddressId: d.addressId,
    threadId: d.threadId,
    replyToMessageId: d.replyToMessageId,
    mode: d.mode,
    to: d.toEmails,
    cc: d.ccEmails,
    bcc: d.bccEmails,
    subject: d.subject,
    text: d.bodyText,
    html: d.bodyHtml,
    snippet: makeSnippet(d.bodyText),
    attachments: (d.attachmentsMeta as DraftFile[]).map((a, index) => ({ index, filename: a.filename, contentType: a.contentType, size: a.size })),
    sendAt: d.scheduledAt?.toISOString() ?? null,
    updatedAt: d.updatedAt.toISOString(),
  };
}

async function ownDraft(c: Context<AppContext>): Promise<DraftRow | null> {
  const [d] = await c
    .get("db")
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, c.req.param("id") ?? ""), eq(drafts.createdBy, c.get("user").id)))
    .limit(1);
  return d ?? null;
}

/** The same address, thread and message checks a send makes, so a draft can't hold what can't be sent. */
async function checkScope(
  c: Context<AppContext>,
  scope: { addressId: string; threadId: string | null; replyToMessageId: string | null },
): Promise<Response | null> {
  const actor = actorOf(c);
  const { db, orgId } = actor;
  if (!(await canSendFrom(db, orgId, actor.accessor, scope.addressId))) {
    return c.json({ error: { code: "forbidden", message: "No send permission on this address" } }, 403);
  }
  if (scope.threadId) {
    const [t] = await db
      .select({ addressId: threads.addressId })
      .from(threads)
      .where(and(eq(threads.id, scope.threadId), eq(threads.organizationId, orgId)))
      .limit(1);
    if (!t) return c.json({ error: { code: "not_found", message: "No such thread" } }, 404);
    if (t.addressId !== scope.addressId) {
      return c.json({ error: { code: "thread_address_mismatch", message: "That thread belongs to a different address" } }, 403);
    }
  }
  if (scope.replyToMessageId) {
    const [m] = await db
      .select({ addressId: messages.addressId })
      .from(messages)
      .where(and(eq(messages.id, scope.replyToMessageId), eq(messages.organizationId, orgId)))
      .limit(1);
    const readable = await accessibleAddressIds(db, orgId, actor.accessor, "read");
    if (!m || (readable !== null && (!m.addressId || !readable.includes(m.addressId)))) {
      return c.json({ error: { code: "not_found", message: "No such message" } }, 404);
    }
  }
  return null;
}

function columns(input: z.infer<typeof patchSchema>): Partial<typeof drafts.$inferInsert> {
  return {
    ...(input.fromAddressId !== undefined && { addressId: input.fromAddressId }),
    ...(input.threadId !== undefined && { threadId: input.threadId }),
    ...(input.replyToMessageId !== undefined && { replyToMessageId: input.replyToMessageId }),
    ...(input.mode !== undefined && { mode: input.mode }),
    ...(input.to !== undefined && { toEmails: input.to }),
    ...(input.cc !== undefined && { ccEmails: input.cc }),
    ...(input.bcc !== undefined && { bccEmails: input.bcc }),
    ...(input.subject !== undefined && { subject: input.subject }),
    ...(input.text !== undefined && { bodyText: input.text }),
    ...(input.html !== undefined && { bodyHtml: input.html }),
    ...(input.sendAt !== undefined && { scheduledAt: input.sendAt ? new Date(input.sendAt) : null }),
  };
}

async function removeFiles(bucket: R2Bucket, files: DraftFile[], keep: string[] = []) {
  const keys = files.map((f) => f.r2Key).filter((k) => !keep.includes(k));
  if (keys.length) await bucket.delete(keys);
}

const badRequest = (c: Context<AppContext>, error: z.ZodError) =>
  c.json({ error: { code: "bad_request", message: error.issues[0]?.message ?? "Invalid draft" } }, 400);

export const draftRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember)

  .get("/", async (c) => {
    const rows = await c
      .get("db")
      .select()
      .from(drafts)
      .where(eq(drafts.createdBy, c.get("user").id))
      .orderBy(desc(drafts.updatedAt))
      .limit(200);
    return c.json({ drafts: rows.map(view) });
  })

  // Create, or for a thread that already has this person's draft, update that one.
  .post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error);
    const input = parsed.data;
    const scope = { addressId: input.fromAddressId, threadId: input.threadId ?? null, replyToMessageId: input.replyToMessageId ?? null };
    const refused = await checkScope(c, scope);
    if (refused) return refused;

    const db = c.get("db");
    const user = c.get("user");
    const now = new Date();
    if (scope.threadId) {
      const [existing] = await db.select().from(drafts).where(eq(drafts.threadId, scope.threadId)).limit(1);
      if (existing && existing.createdBy !== user.id) {
        return c.json({ error: { code: "draft_exists", message: "Someone else is drafting a reply on this thread" } }, 409);
      }
      if (existing) {
        const [row] = await db
          .update(drafts)
          .set({ ...columns(input), updatedAt: now })
          .where(eq(drafts.id, existing.id))
          .returning();
        return c.json({ draft: view(row!) });
      }
    }
    const [row] = await db
      .insert(drafts)
      .values({
        id: crypto.randomUUID(),
        addressId: input.fromAddressId,
        createdBy: user.id,
        ...columns(input),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return c.json({ draft: view(row!) }, 201);
  })

  .get("/:id", async (c) => {
    const d = await ownDraft(c);
    return d ? c.json({ draft: view(d) }) : c.json(notFound, 404);
  })

  // Autosave: any subset of fields.
  .patch("/:id", async (c) => {
    const d = await ownDraft(c);
    if (!d) return c.json(notFound, 404);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, parsed.error);
    const input = parsed.data;
    if (input.fromAddressId !== undefined || input.threadId !== undefined || input.replyToMessageId !== undefined) {
      const refused = await checkScope(c, {
        addressId: input.fromAddressId ?? d.addressId,
        threadId: input.threadId !== undefined ? input.threadId : d.threadId,
        replyToMessageId: input.replyToMessageId !== undefined ? input.replyToMessageId : d.replyToMessageId,
      });
      if (refused) return refused;
    }
    try {
      const [row] = await c
        .get("db")
        .update(drafts)
        .set({ ...columns(input), updatedAt: new Date() })
        .where(eq(drafts.id, d.id))
        .returning();
      return c.json({ draft: view(row!) });
    } catch {
      return c.json({ error: { code: "draft_exists", message: "That thread already has a draft" } }, 409);
    }
  })

  .delete("/:id", async (c) => {
    const d = await ownDraft(c);
    if (!d) return c.json(notFound, 404);
    await c.get("db").delete(drafts).where(eq(drafts.id, d.id));
    await removeFiles(c.env.MAIL_STORE, d.attachmentsMeta as DraftFile[]);
    return c.json({ ok: true });
  })

  // One file per request: the raw bytes as the body, ?filename= for its name.
  .post("/:id/attachments", async (c) => {
    const d = await ownDraft(c);
    if (!d) return c.json(notFound, 404);
    const files = d.attachmentsMeta as DraftFile[];
    if (files.length >= MAX_ATTACHMENTS) {
      return c.json({ error: { code: "too_many_attachments", message: `At most ${MAX_ATTACHMENTS} attachments` } }, 422);
    }
    const declared = Number(c.req.header("content-length") ?? "0");
    const used = files.reduce((n, f) => n + f.size, 0);
    const tooLarge = (size: number) => size > MAX_DRAFT_FILE_BYTES || used + size > MAX_DRAFT_TOTAL_BYTES;
    const limitError = () =>
      c.json(
        { error: { code: "file_too_large", message: `Files can be up to ${MAX_DRAFT_FILE_BYTES / 1024 / 1024} MB, ${MAX_DRAFT_TOTAL_BYTES / 1024 / 1024} MB per draft` } },
        413,
      );
    if (tooLarge(declared)) return limitError();
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length) return c.json({ error: { code: "bad_request", message: "Empty file" } }, 400);
    if (tooLarge(bytes.length)) return limitError();

    const file: DraftFile = {
      filename: cleanFilename(c.req.query("filename") ?? "file"),
      contentType: (c.req.header("content-type") ?? "application/octet-stream").slice(0, 255),
      size: bytes.length,
      r2Key: `drafts/${d.id}/${crypto.randomUUID()}`,
    };
    await c.env.MAIL_STORE.put(file.r2Key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    const [row] = await c
      .get("db")
      .update(drafts)
      .set({ attachmentsMeta: [...files, file], updatedAt: new Date() })
      .where(eq(drafts.id, d.id))
      .returning();
    return c.json({ draft: view(row!) }, 201);
  })

  .delete("/:id/attachments/:index", async (c) => {
    const d = await ownDraft(c);
    if (!d) return c.json(notFound, 404);
    const files = d.attachmentsMeta as DraftFile[];
    const index = Number(c.req.param("index"));
    const file = files[index];
    if (!file) return c.json({ error: { code: "not_found", message: "No such attachment" } }, 404);
    const [row] = await c
      .get("db")
      .update(drafts)
      .set({ attachmentsMeta: files.filter((_, i) => i !== index), updatedAt: new Date() })
      .where(eq(drafts.id, d.id))
      .returning();
    await removeFiles(c.env.MAIL_STORE, [file]);
    return c.json({ draft: view(row!) });
  })

  // Send now, or at sendAt (the body's, else the draft's), as a scheduled SendWorkflow.
  .post("/:id/send", async (c) => {
    const d = await ownDraft(c);
    if (!d) return c.json(notFound, 404);
    const parsed = sendSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(c, parsed.error);
    const opts = parsed.data;
    const files = d.attachmentsMeta as DraftFile[];
    const sendAt = opts.sendAt !== undefined ? opts.sendAt : (d.scheduledAt?.toISOString() ?? null);

    const result = await composeAndQueue(actorOf(c), {
      fromAddressId: d.addressId,
      to: d.toEmails,
      cc: d.ccEmails,
      bcc: d.bccEmails,
      subject: d.subject,
      text: d.bodyText,
      html: d.bodyHtml,
      threadId: d.threadId,
      replyToMessageId: d.replyToMessageId,
      mode: d.mode,
      files: files.map((f) => ({ filename: f.filename, contentType: f.contentType, size: f.size, r2Key: f.r2Key })),
      includeOriginalAttachments: opts.includeOriginalAttachments,
      sendAt,
      attachmentsMode: opts.attachmentsMode,
      linkExpiresInDays: opts.linkExpiresInDays,
    });
    if (result.ok) {
      // Files now behind a download link stay in R2; the rest were copied into the sent message.
      await c.get("db").delete(drafts).where(eq(drafts.id, d.id));
      await removeFiles(c.env.MAIL_STORE, files, result.linkedR2Keys);
    }
    return composeResponse(c, result);
  });
