import { DurableObject } from "cloudflare:workers";
import { eq, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { messages } from "@boxox/db";
import { ipAllowed } from "../dev/auth";
import type { Db } from "../db";
import type { Env } from "../env";
import { log } from "../log";
import { requireOrgMember, type AppContext } from "../middleware";
import { isOrgAdmin } from "../services/access";

/** Events carry ids and status, never bodies; clients refetch what they show. */
export type HubEvent =
  | { type: "message.new"; addressId: string | null; threadId: string; messageId: string; folder: string }
  | { type: "message.status"; addressId: string | null; threadId: string; messageId: string; deliveryStatus: string };

/** Who a socket belongs to, set by the Worker route; clients never reach the hub directly. */
export interface HubClient {
  email: string;
  admin: boolean;
}

type Listener = { listener: true; domainId: string; hash: string; ip: string | null };

const USER_HEADER = "x-boxox-hub-user";
const ADMIN_HEADER = "x-boxox-hub-admin";

/**
 * Realtime push of new mail and delivery status to open clients. One instance
 * per install; sockets use the hibernation API so idle tabs cost nothing.
 * Each push goes only to admins and to users holding a read grant on the
 * event's address, checked against D1 at send time so a revoked grant stops
 * the next push.
 */
export class MailboxHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const listenerDomain = request.headers.get("x-boxox-listener-domain");
    if (listenerDomain) {
      const hash = request.headers.get("x-boxox-listener-hash")!;
      const ip = request.headers.get("x-boxox-listener-ip");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["developer"]);
      pair[1].serializeAttachment({ listener: true, domainId: listenerDomain, hash, ip } satisfies Listener);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const email = request.headers.get(USER_HEADER)?.trim().toLowerCase();
    if (!email) return new Response("Missing user", { status: 400 });
    const client: HubClient = { email, admin: request.headers.get(ADMIN_HEADER) === "1" };

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(client);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Push one event to every client allowed to read its address; returns how many got it. */
  async broadcast(event: HubEvent): Promise<number> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return 0;
    const readers = await this.readersOf(event.addressId);
    const payload = JSON.stringify(event);
    let sent = 0;
    for (const ws of sockets) {
      const client = ws.deserializeAttachment() as (HubClient & Partial<Listener>) | null;
      if (client?.listener) continue;
      if (!client || !(client.admin || readers.has(client.email))) continue;
      try {
        ws.send(payload);
        sent++;
      } catch {
        // A socket closing mid-send is not an error for the others.
      }
    }
    return sent;
  }

  /** Re-authenticate each developer socket so revoke, expiry and rotation take effect. */
  async broadcastDeveloper(domainId: string, frame: { id: string; payload: string }): Promise<void> {
    const sockets = this.ctx.getWebSockets("developer");
    if (!sockets.some((ws) => (ws.deserializeAttachment() as Listener).domainId === domainId)) return;
    // Queue/workflow retries must not forward a second local event. Keep ids
    // through a week of retries without retaining payloads or credential values.
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS developer_event_ids (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)");
    sql.exec("DELETE FROM developer_event_ids WHERE seen_at < ?", Date.now() - 7 * 24 * 3600_000);
    const inserted = [...sql.exec("INSERT OR IGNORE INTO developer_event_ids (id, seen_at) VALUES (?, ?) RETURNING id", `${domainId}:${frame.id}`, Date.now())];
    if (!inserted.length) return;
    for (const ws of sockets) {
      const client = ws.deserializeAttachment() as Listener;
      if (client.domainId !== domainId) continue;
      const now = Date.now();
      const key = await this.env.DB.prepare(`SELECT domain_id, permissions, ip_allowlist FROM api_keys
        WHERE kind = 'domain' AND domain_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND (secret_hash = ? OR (previous_secret_hash = ? AND previous_secret_expires_at > ?))`)
        .bind(domainId, now, client.hash, client.hash, now)
        .first<{ domain_id: string; permissions: string; ip_allowlist: string }>();
      if (!key || !JSON.parse(key.permissions).includes("webhooks") || !ipAllowed(JSON.parse(key.ip_allowlist), client.ip)) {
        ws.close(1008, "Key no longer authorized");
        continue;
      }
      try { ws.send(JSON.stringify(frame)); } catch { /* closing socket */ }
    }
  }

  /** Emails with a read grant on the address. Unrouted mail (no address) is admin-only. */
  private async readersOf(addressId: string | null): Promise<Set<string>> {
    if (!addressId) return new Set();
    const { results } = await this.env.DB.prepare(
      "SELECT principal_id, invite_email, permissions FROM address_grants WHERE address_id = ? AND principal_type = 'user'",
    )
      .bind(addressId)
      .all<{ principal_id: string | null; invite_email: string | null; permissions: string }>();
    const readers = new Set<string>();
    for (const row of results) {
      let perms: unknown;
      try {
        perms = JSON.parse(row.permissions);
      } catch {
        continue;
      }
      if (!Array.isArray(perms) || !perms.includes("read")) continue;
      if (row.principal_id) readers.add(row.principal_id.toLowerCase());
      if (row.invite_email) readers.add(row.invite_email.toLowerCase());
    }
    return readers;
  }

  async webSocketMessage(): Promise<void> {
    // Clients only listen; anything but the auto-answered ping is ignored.
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
  }
}

function hubFor(env: Pick<Env, "MAILBOX_HUB">) {
  return env.MAILBOX_HUB.get(env.MAILBOX_HUB.idFromName("install"));
}

/** Best effort: a push that fails never fails the ingest or event that caused it. */
export async function notifyHub(env: Partial<Pick<Env, "MAILBOX_HUB">>, event: HubEvent): Promise<void> {
  if (!env.MAILBOX_HUB) return;
  try {
    await hubFor({ MAILBOX_HUB: env.MAILBOX_HUB }).broadcast(event);
  } catch (err) {
    log.warn("hub_push_failed", { type: event.type, messageId: event.messageId, error: err });
  }
}

type MessageRef = { id: string; threadId: string; addressId: string | null; status: string | null };

async function messageRef(db: Db, where: SQL): Promise<MessageRef | undefined> {
  try {
    const [row] = await db
      .select({ id: messages.id, threadId: messages.threadId, addressId: messages.addressId, status: messages.deliveryStatus })
      .from(messages)
      .where(where)
      .limit(1);
    return row;
  } catch (err) {
    log.warn("hub_lookup_failed", { error: err });
    return undefined;
  }
}

/** Push a newly stored inbound message to the clients allowed to read its address. */
export async function notifyNewMessage(
  env: Partial<Pick<Env, "MAILBOX_HUB">>,
  db: Db,
  messageId: string,
  folder: string,
): Promise<void> {
  if (!env.MAILBOX_HUB) return;
  const row = await messageRef(db, eq(messages.id, messageId));
  if (!row) return;
  await notifyHub(env, { type: "message.new", addressId: row.addressId, threadId: row.threadId, messageId: row.id, folder });
}

/** Push the current delivery status of the mailbox message sent as `sentMessageId`, if any. */
export async function notifyDeliveryStatus(
  env: Partial<Pick<Env, "MAILBOX_HUB">>,
  db: Db,
  sentMessageId: string,
): Promise<void> {
  if (!env.MAILBOX_HUB) return;
  const row = await messageRef(db, eq(messages.sentMessageId, sentMessageId));
  if (!row?.status) return;
  await notifyHub(env, {
    type: "message.status",
    addressId: row.addressId,
    threadId: row.threadId,
    messageId: row.id,
    deliveryStatus: row.status,
  });
}

/**
 * GET /api/orgs/:orgId/realtime upgrades to a hub socket. Access has already
 * identified the user; the Origin must be the app's own, since a cross-site
 * page could otherwise open a socket with the Access cookie.
 */
export const realtimeRoutes = new Hono<AppContext>().get("/", requireOrgMember, async (c) => {
  if (c.req.header("upgrade") !== "websocket") {
    return c.json({ error: { code: "upgrade_required", message: "Expected a WebSocket upgrade" } }, 426);
  }
  if (c.req.header("origin") !== new URL(c.req.url).origin) {
    return c.json({ error: { code: "forbidden", message: "Cross-site socket refused" } }, 403);
  }
  const user = c.get("user");
  const admin = isOrgAdmin({ userId: user.id, email: user.email, role: c.get("orgRole") });
  const headers = new Headers({ Upgrade: "websocket", [USER_HEADER]: user.email });
  if (admin) headers.set(ADMIN_HEADER, "1");
  return hubFor(c.env).fetch(new Request(c.req.url, { headers }));
});
