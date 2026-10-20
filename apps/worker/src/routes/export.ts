import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { messages } from "@boxox/db";
import { writeAudit } from "../audit";
import { requireOrgMember, type AppContext } from "../middleware";
import { accessibleAddressIds } from "../services/access";
import { escapeMboxBody, mboxFromLine, sha256Hex, synthesizeRfc822 } from "../services/mbox";

/**
 * Export — the guarantee that using Box Ox is never a one-way door.
 *
 * If someone simply wants out, their mail has to come with them. These routes
 * are part of the product rather than a support process.
 *
 * Two surfaces, honest about fidelity:
 *  - /manifest.ndjson — one JSON line per message, including a SHA-256 of the
 *    original bytes where we hold them, so a recipient can verify the archive.
 *  - /mbox — the format every mail client imports. Lossy by construction (see
 *    services/mbox.ts); the manifest is the source of truth for what is exact.
 *
 * Both stream and are cursor-paginated. A Worker has bounded CPU and a
 * subrequest ceiling, and each message costs at least one R2 read, so a
 * single-shot export of a large mailbox would time out partway and hand back a
 * silently truncated archive — worse than no export at all. A one-click
 * full-archive job that assembles into R2 is the natural follow-up; this is the
 * correct, honest version that works today.
 */

/** Messages per request. Bounded by Worker subrequests (one R2 read each). */
const PAGE = 200;

interface ExportRow {
  id: string;
  threadId: string;
  addressId: string | null;
  direction: "inbound" | "outbound";
  fromEmail: string;
  fromName: string | null;
  toEmails: unknown;
  ccEmails: unknown;
  subject: string;
  occurredAt: Date;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  r2Key: string;
  rawMimeKey: string | null;
  attachmentsMeta: unknown;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asAttachments(v: unknown): { filename: string; size: number; r2Key: string | null }[] {
  if (!Array.isArray(v)) return [];
  return v.map((a) => {
    const o = (a ?? {}) as { filename?: unknown; size?: unknown; r2Key?: unknown };
    return {
      filename: typeof o.filename === "string" ? o.filename : "file",
      size: typeof o.size === "number" ? o.size : 0,
      r2Key: typeof o.r2Key === "string" ? o.r2Key : null,
    };
  });
}

/** Opaque `<epochMillis>.<messageId>` cursor over (occurredAt, id). */
export function encodeExportCursor(occurredAt: Date, id: string): string {
  return `${occurredAt.getTime()}.${id}`;
}

export function parseExportCursor(raw: string | undefined): { occurredAt: Date; id: string } | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const millis = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (!Number.isSafeInteger(millis) || millis < 0 || !id) return null;
  return { occurredAt: new Date(millis), id };
}

export const exportRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember)

  /** Total exportable messages for the caller, so a client can show progress. */
  .get("/status", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const conds = await scopeConditions(c);
    if (!conds) return c.json({ exportable: 0, withOriginal: 0 });
    const rows = await db
      .select({
        total: sql<number>`count(*)`,
        withOriginal: sql<number>`count(${messages.rawMimeKey})`,
      })
      .from(messages)
      .where(and(eq(messages.organizationId, orgId), ...conds));
    return c.json({
      exportable: rows[0]?.total ?? 0,
      withOriginal: rows[0]?.withOriginal ?? 0,
    });
  })

  /**
   * Per-message metadata as NDJSON. Streams one line at a time so the response
   * starts immediately and memory stays flat regardless of mailbox size.
   */
  .get("/manifest.ndjson", async (c) => {
    const rows = await selectPage(c);
    if (!rows) return c.json({ error: { code: "forbidden", message: "No accessible mail" } }, 403);

    const env = c.env;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        for (const m of rows) {
          let sha: string | null = null;
          let bytes: number | null = null;
          if (m.rawMimeKey) {
            const obj = await env.MAIL_STORE.get(m.rawMimeKey);
            if (obj) {
              const buf = await obj.arrayBuffer();
              sha = await sha256Hex(buf);
              bytes = buf.byteLength;
            }
          }
          controller.enqueue(
            enc.encode(
              JSON.stringify({
                messageId: m.id,
                threadId: m.threadId,
                direction: m.direction,
                from: m.fromEmail,
                to: asStrings(m.toEmails),
                cc: asStrings(m.ccEmails),
                subject: m.subject,
                date: m.occurredAt.toISOString(),
                rfcMessageId: m.rfcMessageId,
                // The honest fidelity marker. `original` means these are the
                // exact bytes the sender's server produced; `synthesized` means
                // the message predates capture and was reconstructed from parsed
                // fields — readable, but not verifiable and not byte-exact.
                fidelity: m.rawMimeKey ? "original" : "synthesized",
                originalSha256: sha,
                originalBytes: bytes,
                attachments: asAttachments(m.attachmentsMeta).map((a) => ({
                  filename: a.filename,
                  size: a.size,
                  stored: a.r2Key !== null,
                })),
              }) + "\n",
            ),
          );
        }
        controller.close();
      },
    });

    const last = rows.at(-1);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": 'attachment; filename="boxox-manifest.ndjson"',
        "X-Next-Cursor": last ? encodeExportCursor(last.occurredAt, last.id) : "",
        "X-Complete": rows.length < PAGE ? "true" : "false",
      },
    });
  })

  /** Standard mbox. Lossy by construction — see services/mbox.ts. */
  .get("/mbox", async (c) => {
    const rows = await selectPage(c);
    if (!rows) return c.json({ error: { code: "forbidden", message: "No accessible mail" } }, 403);

    await writeAudit(c.get("db"), {
      organizationId: c.get("orgId"),
      actorType: "user",
      actorId: c.get("user").id,
      action: "mail.exported",
      targetType: "organization",
      targetId: c.get("orgId"),
      metadata: { messages: rows.length, format: "mbox" },
    });

    const env = c.env;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        for (const m of rows) {
          let body: string | null = null;
          if (m.rawMimeKey) {
            const obj = await env.MAIL_STORE.get(m.rawMimeKey);
            if (obj) body = await obj.text();
          }
          if (body === null) {
            // No original: reconstruct from what we stored. Marked in-message
            // with X-BoxOx-Reconstructed so the recipient can tell.
            const parsed = await readStoredParse(env, m.r2Key);
            body = synthesizeRfc822({
              fromEmail: m.fromEmail,
              fromName: m.fromName,
              toEmails: asStrings(m.toEmails),
              ccEmails: asStrings(m.ccEmails),
              subject: m.subject,
              occurredAt: m.occurredAt,
              rfcMessageId: m.rfcMessageId,
              inReplyTo: m.inReplyTo,
              text: parsed.text,
              html: parsed.html,
              attachments: asAttachments(m.attachmentsMeta),
            });
          }
          controller.enqueue(enc.encode(mboxFromLine(m.fromEmail, m.occurredAt)));
          controller.enqueue(enc.encode(escapeMboxBody(body)));
          controller.enqueue(enc.encode(body.endsWith("\n") ? "\n" : "\n\n"));
        }
        controller.close();
      },
    });

    const last = rows.at(-1);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/mbox",
        "Content-Disposition": 'attachment; filename="boxox-export.mbox"',
        "X-Next-Cursor": last ? encodeExportCursor(last.occurredAt, last.id) : "",
        "X-Complete": rows.length < PAGE ? "true" : "false",
      },
    });
  });

/**
 * Mailbox scoping for the caller. Returns null when they can see nothing, or a
 * (possibly empty) list of extra predicates. Owners/admins get the whole org;
 * everyone else is restricted to addresses they hold a read grant on — export
 * must not become a way around the per-address permission model.
 */
async function scopeConditions(c: Context<AppContext>): Promise<SQL[] | null> {
  const db = c.get("db");
  const orgId = c.get("orgId");
  const user = c.get("user") as { id: string; email: string };
  const readable = await accessibleAddressIds(
    db,
    orgId,
    { userId: user.id, email: user.email, role: c.get("orgRole") as string },
    "read",
  );
  if (readable === null) return [];
  if (readable.length === 0) return null;
  return [inArray(messages.addressId, readable)];
}

/** One page of messages in stable (occurredAt, id) order. */
async function selectPage(c: Context<AppContext>): Promise<ExportRow[] | null> {
  const db = c.get("db");
  const orgId = c.get("orgId");
  const conds = await scopeConditions(c);
  if (!conds) return null;
  const after = parseExportCursor(c.req.query("cursor"));
  return (await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      addressId: messages.addressId,
      direction: messages.direction,
      fromEmail: messages.fromEmail,
      fromName: messages.fromName,
      toEmails: messages.toEmails,
      ccEmails: messages.ccEmails,
      subject: messages.subject,
      occurredAt: messages.occurredAt,
      rfcMessageId: messages.rfcMessageId,
      inReplyTo: messages.inReplyTo,
      r2Key: messages.r2Key,
      rawMimeKey: messages.rawMimeKey,
      attachmentsMeta: messages.attachmentsMeta,
    })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, orgId),
        ...conds,
        ...(after
          ? [
              sql`(${messages.occurredAt}, ${messages.id}) > (${after.occurredAt.getTime()}, ${after.id})`,
            ]
          : []),
      ),
    )
    .orderBy(asc(messages.occurredAt), asc(messages.id))
    .limit(PAGE)) as ExportRow[];
}

/** Best-effort read of the stored parse for a message with no original. */
async function readStoredParse(
  env: AppContext["Bindings"],
  r2Key: string,
): Promise<{ html: string | null; text: string | null }> {
  try {
    const obj = await env.MAIL_STORE.get(r2Key);
    if (!obj) return { html: null, text: null };
    const raw = (await obj.json()) as {
      data?: { html?: string | null; text?: string | null };
      html?: string | null;
      text?: string | null;
    };
    return {
      html: raw.data?.html ?? raw.html ?? null,
      text: raw.data?.text ?? raw.text ?? null,
    };
  } catch {
    return { html: null, text: null };
  }
}
