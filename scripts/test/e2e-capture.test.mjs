import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { unstable_dev } from 'wrangler';
import { fileURLToPath } from 'node:url';
const token = 'local-only-fixture-operator-token-not-a-real-secret';
const session = 'b'.repeat(32);
let worker, base;
before(async () => {
  worker = await unstable_dev(fileURLToPath(new URL('../e2e-capture-worker.mjs', import.meta.url)), {
    config: fileURLToPath(new URL('../e2e-capture.wrangler.jsonc', import.meta.url)), local: true, ip: '127.0.0.1', port: 0, persist: false,
    vars: { E2E_CAPTURE_TOKEN: token }, experimental: { disableExperimentalWarning: true }, logLevel: 'error',
  });
  base = `http://${worker.address}:${worker.port}`;
}, { timeout: 60000 });
after(async () => { await worker?.stop(); });
const request = (path, method = 'GET', options = {}) => fetch(base + path, { method, ...options });
const control = (id, method) => request(`/sessions/${id}`, method, { headers: { authorization: `Bearer ${token}` } });
const post = (id, body, eventId = 'fixture-event-1') => request(`/hook/${id}`, 'POST', { body, headers: { 'webhook-id': eventId, 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,fixture-signature' } });

test('capture control requires operator authentication and hook requires an initialized session', async () => {
  assert.equal((await request(`/sessions/${session}`, 'PUT')).status, 401);
  assert.equal((await post(session, '{}')).status, 410);
  const created = await control(session, 'PUT'); assert.equal(created.status, 201);
  const body = await created.json(); assert.ok(body.expiresAt > Date.now()); assert.ok(body.expiresAt <= Date.now() + 2 * 60 * 60_000);
  assert.equal((await control(session, 'PUT')).status, 409);
});
test('capture retains exact raw JSON and Standard Webhooks headers without exposing it publicly', async () => {
  const raw = '{ "type":"message.delivered", "unicode":"é", "data":{"messageId":"fixture"} }\n';
  assert.equal((await post(session, raw)).status, 204);
  assert.equal((await post(session, 'duplicate body')).status, 204);
  assert.equal((await request(`/sessions/${session}`)).status, 401);
  const response = await control(session, 'GET'); const data = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(data.events.length, 1); assert.equal(data.events[0].body, raw);
  assert.equal(data.events[0].headers['webhook-id'], 'fixture-event-1');
});
test('oversized payload is rejected without storing its body', async () => {
  assert.equal((await post(session, 'x'.repeat(65537), 'oversized')).status, 413);
  assert.equal((await (await control(session, 'GET')).json()).events.length, 1);
});
test('cleanup removes session records and rejects future delivery', async () => {
  assert.equal((await control(session, 'DELETE')).status, 204);
  assert.equal((await control(session, 'GET')).status, 410);
  assert.equal((await post(session, '{}')).status, 410);
});
