import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoxOxError, signWebhook } from '../../packages/sdk/dist/index.js';
import { configuration, parseEnv, runLiveChecks } from '../e2e-live.mjs';
const nonce = 'a'.repeat(32), to = `e2e+${nonce}@boxox.dev`, bounceTo = `boxoxe2e${nonce.slice(0, 20)}@gmail.com`;
const key = 'bxk_fixture_primary', otherKey = 'bxk_fixture_other';
const secret = 'whsec_' + Buffer.alloc(24, 3).toString('base64');
const values = { BOXOX_URL: 'https://boxox.dev', BOXOX_KEY: key, BOXOX_E2E_OTHER_KEY: otherKey, BOXOX_E2E_CAPTURE_URL: 'https://capture.example.test', BOXOX_E2E_CAPTURE_TOKEN: 'local-fixture-capture-token-not-a-real-key' };
function fixture(options = {}) {
  let clock = Date.now(), gets = 0, firstBody;
  const sent = [], logs = [], cleanup = [], calls = [];
  const config = { ...configuration(values), pollTimeoutMs: 50, totalTimeoutMs: 1000, intervalMs: 10 };
  const mail = {
    messages: {
      async list() { if (options.preflightDenied) throw new BoxOxError(403, 'missing_permission', 'sensitive API error body must not escape'); return { data: [] }; },
      async send(body, init) {
        if (init.idempotencyKey.endsWith(':bounce')) { sent.push(body); return { id: 'bounce-1', status: 'queued' }; }
        if (!firstBody) { firstBody = structuredClone(body); sent.push(body); return { id: 'message-1', status: 'queued' }; }
        if (JSON.stringify(body) !== JSON.stringify(firstBody)) {
          if (options.noConflict) return { id: 'incorrect-new-message', status: 'queued' };
          throw new BoxOxError(409, 'idempotency_key_reused', 'request reused');
        }
        return { id: 'message-1', status: 'queued' };
      },
      async get(id) {
        gets++;
        if (id === 'bounce-1') return { status: 'bounced', timeline: [{ type: 'bounced', recipient: bounceTo }] };
        return { status: 'sent', timeline: options.noDelivery || gets < 2 ? [] : [{ type: 'delivered', recipient: to }] };
      },
    },
    received: {
      async list(query) {
        calls.push(['received.list', query]);
        if (query.limit === 1) return { data: [], nextCursor: null };
        if (!query.cursor) return { data: [], nextCursor: 'second-page' };
        return { data: [{ id: 'received-1', subject: `Box Ox live E2E ${nonce}`, toEmails: [to] }], nextCursor: null };
      },
      async get() { return { text: `Synthetic body boxox-e2e:${nonce}` }; },
    },
    webhooks: { async list() { return { data: [] }; }, async create(body) { calls.push(['hook.create', body]); return { id: 'hook-1', secret }; }, async delete(id) { cleanup.push(['webhook', id]); if (options.cleanupFails) throw new Error('cannot delete'); } },
    suppressions: { async list() { return { data: [] }; }, async get(email) { return { email, reason: options.wrongSuppression ? 'manual' : 'bounce' }; } },
  };
  const other = { messages: { async send() { throw new BoxOxError(403, options.otherMissingPermission ? 'missing_permission' : 'from_not_allowed', 'denied'); } } };
  const capture = {
    async create(id) { calls.push(['capture.create', id]); }, hookUrl: (id) => `https://capture.example.test/hook/${id}`,
    async events() {
      const body = JSON.stringify({ type: 'message.delivered', timestamp: new Date(clock).toISOString(), data: { messageId: 'message-1' } });
      const capturedAt = options.oldCapture ? clock - 600_000 : clock;
      const ts = Math.floor(capturedAt / 1000), signature = await signWebhook(secret, 'cf:message-1', ts, body);
      return { events: [{ body, receivedAt: new Date(capturedAt).toISOString(), headers: { 'webhook-id': 'cf:message-1', 'webhook-timestamp': String(ts), 'webhook-signature': options.badSignature ? 'v1,aW52YWxpZA==' : signature } }] };
    },
    async delete(id) { cleanup.push(['capture', id]); },
  };
  return { config, sent, logs, cleanup, calls, deps: { mail, other, capture, nonce, log: (line) => logs.push(line), now: () => clock, sleep: async (ms) => { clock += ms; } } };
}

test('configuration reads literal dotenv without evaluating shell expressions and validates required scope credentials', () => {
  assert.deepEqual(parseEnv('# comment\nexport BOXOX_URL="https://boxox.dev"\nBOXOX_KEY=literal$(do-not-run) # ignored\n'), { BOXOX_URL: 'https://boxox.dev', BOXOX_KEY: 'literal$(do-not-run)' });
  assert.throws(() => configuration({ ...values, BOXOX_E2E_OTHER_KEY: key }), /must differ/);
  assert.throws(() => configuration({ ...values, BOXOX_E2E_CAPTURE_URL: 'http://capture.example.test' }), /HTTPS origin/);
  assert.throws(() => configuration({ ...values, BOXOX_E2E_OTHER_KEY: '' }), /Provide BOXOX_E2E_OTHER_KEY/);
  const fromOtherFile = configuration({ ...values, BOXOX_E2E_OTHER_KEY: undefined }, { BOXOX_KEY: otherKey, BOXOX_URL: values.BOXOX_URL });
  assert.equal(fromOtherFile.otherKey, otherKey);
});
test('all required live checks execute using two new sends, paginated inbox lookup and real SDK signature verification', async () => {
  const f = fixture(); const result = await runLiveChecks(f.config, f.deps);
  assert.equal(result.messageId, 'message-1'); assert.equal(result.receivedId, 'received-1'); assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].to, to); assert.equal(f.sent[1].to, bounceTo); assert.ok(bounceTo.split('@')[0].length <= 30);
  assert.ok(f.calls.filter(([name]) => name === 'received.list').every(([, query]) => query.to === 'e2e@boxox.dev'));
  assert.deepEqual(f.cleanup, [['webhook', 'hook-1'], ['capture', nonce]]);
  assert.ok(f.logs.some((line) => line === 'PASS idempotency-conflict')); assert.ok(f.logs.some((line) => line === 'PASS signed-webhook'));
  assert.ok(!f.logs.join('\n').includes(key)); assert.ok(!f.logs.join('\n').includes(secret));
});
test('a missing permission on the other key cannot masquerade as cross-domain isolation', async () => {
  const f = fixture({ otherMissingPermission: true });
  await assert.rejects(runLiveChecks(f.config, f.deps), (error) => error.step === 'cross-domain-refused' && error.message.includes('from_not_allowed'));
  assert.equal(f.sent.length, 0); assert.equal(f.cleanup.length, 0);
});
test('preflight failure names the step and does not create endpoints or send', async () => {
  const f = fixture({ preflightDenied: true });
  await assert.rejects(runLiveChecks(f.config, f.deps), (error) => error.step === 'preflight-primary' && !error.message.includes('sensitive'));
  assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
});
test('missing delivered evidence reaches a bounded deadline and cleans temporary resources', async () => {
  const f = fixture({ noDelivery: true });
  await assert.rejects(runLiveChecks(f.config, f.deps), (error) => error.step === 'delivered-timeline' && error.message.includes('Timed out'));
  assert.equal(f.sent.length, 1); assert.equal(f.cleanup.length, 2);
});
test('a delayed poll verifies the webhook at its authenticated receipt time', async () => {
  const f = fixture({ oldCapture: true });
  await runLiveChecks(f.config, f.deps);
  assert.ok(f.logs.includes('PASS signed-webhook'));
});
test('an invalid captured signature fails instead of accepting a delivery status alone', async () => {
  const f = fixture({ badSignature: true });
  await assert.rejects(runLiveChecks(f.config, f.deps), (error) => error.step === 'signed-webhook');
  assert.equal(f.sent.length, 1); assert.equal(f.cleanup.length, 2);
});
test('a changed request must produce the actual 409 conflict', async () => {
  const f = fixture({ noConflict: true });
  await assert.rejects(runLiveChecks(f.config, f.deps), (error) => error.step === 'idempotency-conflict' && error.message.includes('unexpectedly succeeded'));
  assert.equal(f.cleanup.length, 2);
});
test('manual suppression cannot satisfy the bounce suppression check', async () => {
  const f = fixture({ wrongSuppression: true });
  await assert.rejects(runLiveChecks(f.config, f.deps), (error) => error.step === 'bounce-suppression' && error.message.includes('Timed out'));
});
test('cleanup failure yields a non-passing run', async () => {
  const f = fixture({ cleanupFails: true });
  await assert.rejects(runLiveChecks(f.config, f.deps), (error) => error.step === 'cleanup');
  assert.equal(f.cleanup.length, 2);
});
