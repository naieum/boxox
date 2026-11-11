import { Hono } from "hono";
import { z } from "zod";
import { log } from "../log";
import { requireOwner, requireSession, type AppContext } from "../middleware";
import {
  beginAddPasskey, beginInvite, beginLogin, createInvite, endSession, finishAddPasskey, finishInvite, finishLogin,
  MEMBER_LINK_MS, normalEmail, ownerClaimed, signinMode,
} from "../services/signin";

/**
 * /api/auth: Box Ox sign-in. `state`, `invite/*`, `login/*` and `logout` are
 * reachable signed out (middleware/signin.ts); everything else needs a session.
 * With Cloudflare Access in front, only `state` answers.
 */

const bad = (message: string, code = "bad_request") => ({ error: { code, message } });
const credential = z.object({ id: z.string().min(1).max(1024), rawId: z.string().max(1024), type: z.literal("public-key"), response: z.record(z.string(), z.unknown()) }).passthrough();
const finishSchema = z.object({ response: credential, name: z.string().trim().max(80).optional() });
const inviteSchema = z.object({ code: z.string().min(20).max(128) });
const memberSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), name: z.string().trim().max(120).default("") });
const NOT_VERIFIED = "That passkey could not be verified. Try again.";

export const signinRoutes = new Hono<AppContext>()
  .get("/state", async (c) => {
    const mode = signinMode(c.env);
    c.header("cache-control", "no-store");
    return c.json({ mode, user: c.get("user") ?? null, ...(mode === "native" ? { ownerReady: await ownerClaimed(c.env) } : {}) });
  })

  .use("*", async (c, next) => {
    if (signinMode(c.env) !== "native") return c.json(bad("This installation signs in through Cloudflare Access.", "not_found"), 404);
    c.header("cache-control", "no-store");
    if (c.req.method !== "GET" && c.env.SIGNIN_RATE_LIMIT) {
      const { success } = await c.env.SIGNIN_RATE_LIMIT.limit({ key: c.req.header("cf-connecting-ip") ?? "unknown" });
      if (!success) return c.json(bad("Too many attempts. Wait a minute and try again.", "rate_limited"), 429);
    }
    await next();
  })

  // A single-use link: the owner's from the installer, a member's from the owner.
  .post("/invite/begin", async (c) => {
    const parsed = inviteSchema.safeParse(await c.req.json().catch(() => null));
    const started = parsed.success ? await beginInvite(c, parsed.data.code) : null;
    if (!started) return c.json(bad("This link has been used or has expired. Ask for a new one.", "invite_invalid"), 404);
    return c.json(started);
  })
  .post("/invite/finish", async (c) => {
    const parsed = finishSchema.safeParse(await c.req.json().catch(() => null));
    const user = parsed.success ? await finishInvite(c, parsed.data.response as never, parsed.data.name ?? "") : null;
    if (!user) return c.json(bad(NOT_VERIFIED, "passkey_rejected"), 400);
    log.info("signin_passkey_created", { role: user.role, via: "invite" });
    return c.json({ user });
  })

  .post("/login/begin", async (c) => c.json({ options: await beginLogin(c) }))
  .post("/login/finish", async (c) => {
    const parsed = z.object({ response: credential }).safeParse(await c.req.json().catch(() => null));
    const user = parsed.success ? await finishLogin(c, parsed.data.response as never) : null;
    if (!user) {
      log.warn("signin_rejected", {});
      return c.json(bad("That passkey is not registered here.", "passkey_rejected"), 401);
    }
    return c.json({ user });
  })
  .post("/logout", async (c) => {
    await endSession(c);
    return c.json({ ok: true });
  })

  // Signed in from here on.
  .use("*", requireSession)
  .get("/passkeys", async (c) => {
    const rows = await c.env.DB.prepare("SELECT credential_id AS id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM auth_passkeys WHERE user_email = ? ORDER BY created_at")
      .bind(c.get("user").email).all();
    return c.json({ passkeys: rows.results });
  })
  .post("/passkeys/begin", async (c) => c.json({ options: await beginAddPasskey(c) }))
  .post("/passkeys/finish", async (c) => {
    const parsed = finishSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !(await finishAddPasskey(c, parsed.data.response as never, parsed.data.name ?? ""))) return c.json(bad(NOT_VERIFIED, "passkey_rejected"), 400);
    log.info("signin_passkey_created", { role: c.get("user").role, via: "settings" });
    return c.json({ ok: true });
  })
  .delete("/passkeys/:id", async (c) => {
    const email = c.get("user").email;
    // Removing the last passkey would lock the person out; the statement refuses it.
    const removed = await c.env.DB.prepare(
      "DELETE FROM auth_passkeys WHERE credential_id = ? AND user_email = ? AND (SELECT COUNT(*) FROM auth_passkeys WHERE user_email = ?) > 1",
    ).bind(c.req.param("id"), email, email).run();
    if (!removed.meta.changes) return c.json(bad("Add another passkey before removing your only one.", "last_passkey"), 409);
    return c.json({ ok: true });
  })

  // Members: only the owner decides who else can sign in.
  .get("/members", requireOwner, async (c) => {
    const owner = normalEmail(c.env.OWNER_EMAIL ?? "");
    const [users, invites] = await Promise.all([
      c.env.DB.prepare("SELECT u.email, u.name, u.created_at AS createdAt, (SELECT COUNT(*) FROM auth_passkeys p WHERE p.user_email = u.email) AS passkeys FROM auth_users u ORDER BY u.created_at").all<{ email: string; name: string; createdAt: number; passkeys: number }>(),
      c.env.DB.prepare("SELECT user_email AS email, user_name AS name, expires_at AS expiresAt FROM auth_invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at").bind(Date.now()).all<{ email: string; name: string; expiresAt: number }>(),
    ]);
    return c.json({
      members: users.results.map((u) => ({ ...u, role: u.email === owner ? "owner" : "member" })),
      pending: invites.results.filter((i) => !users.results.some((u) => u.email === i.email)),
    });
  })
  .post("/members", requireOwner, async (c) => {
    const parsed = memberSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(bad("Enter the person's email address."), 400);
    const code = await createInvite(c.env.DB, { ...parsed.data, createdBy: c.get("user").email, ttlMs: MEMBER_LINK_MS });
    log.info("signin_invite_created", {});
    // The fragment keeps the code out of request logs and Referer headers.
    return c.json({ email: parsed.data.email, link: `${new URL(c.env.PUBLIC_URL || c.req.url).origin}/welcome#${code}`, expiresAt: Date.now() + MEMBER_LINK_MS });
  })
  .delete("/members/:email", requireOwner, async (c) => {
    const email = normalEmail(c.req.param("email"));
    if (email === normalEmail(c.env.OWNER_EMAIL ?? "")) return c.json(bad("The owner cannot be removed.", "owner_required"), 409);
    // Passkeys and sessions go with the person (ON DELETE CASCADE); unused links too.
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM auth_users WHERE email = ?").bind(email),
      c.env.DB.prepare("DELETE FROM auth_invites WHERE user_email = ? AND used_at IS NULL").bind(email),
    ]);
    log.info("signin_member_removed", {});
    return c.json({ ok: true });
  });
