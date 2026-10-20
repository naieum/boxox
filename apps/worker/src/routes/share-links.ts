import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { shareLinks } from "@boxox/db";
import type { Db } from "../db";
import type { Env } from "../env";
import { requireOrgMember, type AppContext } from "../middleware";
import { rateLimitHit } from "../services/agent-rate-limit";
import { contentDisposition } from "../services/attachments";

/**
 * Expiring, revocable download links for files too large to attach. The
 * 128-bit token is only ever in the sent mail; D1 keeps its SHA-256. The
 * public side (/f/*) sits outside Access, so it is rate limited per IP and
 * per link, never lists anything and is marked noindex.
 */

export const DEFAULT_LINK_DAYS = 7;
export const MAX_LINK_DAYS = 30;
/** Per 15-minute window. */
export const SHARE_LINK_LIMITS = { perIp: 60, perLink: 100 } as const;

const DAY_MS = 24 * 3600 * 1000;
const NOINDEX = "noindex, nofollow, noarchive";

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function publicOrigin(env: Pick<Env, "PUBLIC_URL">, requestUrl: string): string {
  return new URL(env.PUBLIC_URL?.trim() || requestUrl).origin;
}

export interface NewShareLink {
  r2Key: string;
  filename: string;
  contentType: string;
  size: number;
  createdBy: string;
  expiresInDays?: number;
}

export async function createShareLink(db: Db, origin: string, input: NewShareLink) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const id = crypto.randomUUID();
  const days = Math.min(Math.max(input.expiresInDays ?? DEFAULT_LINK_DAYS, 1), MAX_LINK_DAYS);
  const expiresAt = new Date(Date.now() + days * DAY_MS);
  await db.insert(shareLinks).values({
    id,
    tokenHash: await hashToken(token),
    r2Key: input.r2Key,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    expiresAt,
    createdBy: input.createdBy,
  });
  return { id, token, url: `${origin}/f/${token}`, filename: input.filename, size: input.size, expiresAt };
}

function accessorOf(c: Context<AppContext>) {
  const role = c.get("orgRole");
  return { userId: c.get("user").id, admin: role === "owner" || role === "admin" };
}

function view(l: typeof shareLinks.$inferSelect) {
  return {
    id: l.id,
    filename: l.filename,
    size: l.size,
    messageId: l.messageId,
    expiresAt: l.expiresAt.toISOString(),
    revokedAt: l.revokedAt?.toISOString() ?? null,
    downloadCount: l.downloadCount,
    createdAt: l.createdAt.toISOString(),
  };
}

/** The owner's view under /api/orgs/:orgId/share-links: list and revoke. */
export const shareLinkRoutes = new Hono<AppContext>()
  .use("*", requireOrgMember)

  .get("/", async (c) => {
    const db = c.get("db");
    const who = accessorOf(c);
    const rows = await db
      .select()
      .from(shareLinks)
      .where(who.admin ? undefined : eq(shareLinks.createdBy, who.userId))
      .orderBy(desc(shareLinks.createdAt))
      .limit(200);
    return c.json({ links: rows.map(view) });
  })

  .post("/:id/revoke", async (c) => {
    const db = c.get("db");
    const who = accessorOf(c);
    const [link] = await db.select().from(shareLinks).where(eq(shareLinks.id, c.req.param("id"))).limit(1);
    if (!link || (!who.admin && link.createdBy !== who.userId)) {
      return c.json({ error: { code: "not_found", message: "No such link" } }, 404);
    }
    await db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareLinks.id, link.id), isNull(shareLinks.revokedAt)));
    return c.json({ ok: true });
  });

type PublicContext = Context<AppContext>;

function gone(c: PublicContext, status: 404 | 410 | 429, message: string) {
  c.header("X-Robots-Tag", NOINDEX);
  c.header("Cache-Control", "no-store");
  return c.text(message, status);
}

/** Rate limit first, so guessing tokens costs the same budget as using them. */
async function resolve(c: PublicContext): Promise<typeof shareLinks.$inferSelect | Response> {
  const db = c.get("db");
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await rateLimitHit(db, `share:ip:${ip}`, SHARE_LINK_LIMITS.perIp)).allowed) {
    return gone(c, 429, "Too many requests. Try again later.");
  }
  const token = c.req.param("token") ?? "";
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) return gone(c, 404, "This link does not exist.");
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.tokenHash, await hashToken(token))).limit(1);
  if (!link) return gone(c, 404, "This link does not exist.");
  if (link.revokedAt) return gone(c, 410, "This link was revoked by its sender.");
  if (link.expiresAt.getTime() <= Date.now()) return gone(c, 410, "This link has expired.");
  if (!(await rateLimitHit(db, `share:link:${link.id}`, SHARE_LINK_LIMITS.perLink)).allowed) {
    return gone(c, 429, "This file has been downloaded too often. Try again later.");
  }
  return link;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Public download page and file, mounted at /f outside Access. */
export const shareLinkPublicRoutes = new Hono<AppContext>()
  .get("/:token", async (c) => {
    const link = await resolve(c);
    if (link instanceof Response) return link;
    const name = escapeHtml(link.filename);
    c.header("X-Robots-Tag", NOINDEX);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="${NOINDEX}">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title></head>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
        `<h1 style="font-size:1.1rem;word-break:break-all">${name}</h1>` +
        `<p>${formatSize(link.size)} · available until ${link.expiresAt.toUTCString()}</p>` +
        `<p><a href="${escapeHtml(c.req.param("token"))}/download" download>Download</a></p>` +
        `</body></html>`,
    );
  })

  .get("/:token/download", async (c) => {
    const link = await resolve(c);
    if (link instanceof Response) return link;
    const obj = await c.env.MAIL_STORE.get(link.r2Key);
    if (!obj) return gone(c, 410, "This file is no longer available.");
    await c
      .get("db")
      .update(shareLinks)
      .set({ downloadCount: sql`${shareLinks.downloadCount} + 1` })
      .where(eq(shareLinks.id, link.id));
    // Never the sender's declared type: the bytes are opaque to us.
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(obj.size),
        "Content-Disposition": contentDisposition("attachment", link.filename),
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": NOINDEX,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
