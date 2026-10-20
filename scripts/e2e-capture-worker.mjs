/** Disposable E2E capture only. No mail keys/signing secrets are stored here. */
import { DurableObject } from 'cloudflare:workers';
const TTL_MS = 2 * 60 * 60_000, MAX_EVENTS = 100, MAX_BYTES = 64 * 1024;

async function authorized(request, secret) {
  if (!secret || secret.length < 32) return false;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const digest = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(supplied), digest(secret)]);
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url), hook = /^\/hook\/([a-f0-9]{32})$/.exec(url.pathname), control = /^\/sessions\/([a-f0-9]{32})$/.exec(url.pathname);
    if ((!hook || request.method !== 'POST') && !control) return new Response(null, { status: 404 });
    if (control && !(await authorized(request, env.E2E_CAPTURE_TOKEN))) return new Response(null, { status: 401 });
    const session = (hook ?? control)[1];
    return env.CAPTURES.get(env.CAPTURES.idFromName(session)).fetch(request);
  },
};
export class E2ECapture extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; }
  async fetch(request) {
    const url = new URL(request.url), hook = url.pathname.startsWith('/hook/');
    const expires = await this.ctx.storage.get('expires');
    if (!hook && request.method === 'PUT') {
      if (expires) return new Response(null, { status: 409 });
      const expiresAt = Date.now() + TTL_MS;
      await this.ctx.storage.put('expires', expiresAt); await this.ctx.storage.setAlarm(expiresAt);
      return Response.json({ expiresAt }, { status: 201, headers: { 'cache-control': 'no-store' } });
    }
    if (!expires || expires <= Date.now()) return new Response(null, { status: 410 });
    if (!hook && request.method === 'DELETE') { await this.ctx.storage.deleteAll(); return new Response(null, { status: 204 }); }
    if (!hook && request.method === 'GET') {
      const rows = await this.ctx.storage.list({ prefix: 'event:' });
      return Response.json({ events: [...rows.values()], expiresAt: expires }, { headers: { 'cache-control': 'no-store' } });
    }
    if (!hook) return new Response(null, { status: 405 });
    const bytes = [], reader = request.body?.getReader(); let length = 0;
    if (!reader) return new Response(null, { status: 400 });
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); return new Response(null, { status: 413 }); }
      bytes.push(part.value);
    }
    const body = new Uint8Array(length); let offset = 0;
    for (const part of bytes) { body.set(part, offset); offset += part.byteLength; }
    const headers = Object.fromEntries(['webhook-id', 'webhook-timestamp', 'webhook-signature'].map((name) => [name, request.headers.get(name) ?? '']));
    if (Object.values(headers).some((value) => !value || value.length > 1024)) return new Response(null, { status: 400 });
    const eventKey = `event:${headers['webhook-id']}`;
    if (await this.ctx.storage.get(eventKey)) return new Response(null, { status: 204 });
    const rows = await this.ctx.storage.list({ prefix: 'event:', limit: MAX_EVENTS });
    if (rows.size >= MAX_EVENTS) return new Response(null, { status: 429 });
    await this.ctx.storage.put(eventKey, { body: new TextDecoder('utf-8', { fatal: true }).decode(body), headers, receivedAt: new Date().toISOString() });
    return new Response(null, { status: 204 });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
