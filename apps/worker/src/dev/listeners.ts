import type { Env } from "../env";
import { hashSecret, type AuthenticatedKey } from "./keys";
import { log } from "../log";

function hubFor(env: Pick<Env, "MAILBOX_HUB">) {
  return env.MAILBOX_HUB.get(env.MAILBOX_HUB.idFromName("install"));
}
/** Only the authenticated domain-key route may create developer sockets. */
export async function listenerRequest(env: Env, url: string, key: AuthenticatedKey, secret: string, ip: string | null): Promise<Response> {
  return hubFor(env).fetch(new Request(url, { headers: {
    Upgrade: "websocket", "x-boxox-listener-domain": key.domainId!,
    "x-boxox-listener-hash": await hashSecret(secret), ...(ip ? { "x-boxox-listener-ip": ip } : {}),
  } }));
}
export async function notifyListeners(
  env: Partial<Pick<Env, "MAILBOX_HUB">>, domainId: string, frame: { id: string; payload: string },
): Promise<void> {
  if (!env.MAILBOX_HUB) return;
  try { await hubFor({ MAILBOX_HUB: env.MAILBOX_HUB }).broadcastDeveloper(domainId, frame); }
  catch (error) { log.warn("developer_listener_push_failed", { domainId, error }); }
}
