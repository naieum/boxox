import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { connectDomain, DELIVERY_EVENTS, receivingBlockers } from '../domain.mjs';

const ACCOUNT = 'a'.repeat(32);
const config = (edition = 'paid') => ({ name: 'boxox', account_id: ACCOUNT, vars: { BOXOX_EDITION: edition, EVENTS_QUEUE: 'cf-email-events', PUBLIC_URL: 'https://boxox.test-account.workers.dev' } });
function cloudflare({ routing = { status: 'unconfigured', support_subaddress: false }, zones = ['example.test'], refuseEnable = false, rows = [], subscriptions = [], subdomains = [] } = {}) {
  const calls = [], sql = [];
  const zoneApi = async (method, path, body) => {
    calls.push(`${method} /zones${path}`);
    if (path.startsWith('?name=')) { const name = new URLSearchParams(path.slice(1)).get('name'); return zones.includes(name) ? [{ id: 'zone-id', name }] : []; }
    if (method === 'GET' && path === '/zone-id/email/routing') return routing;
    if (path === '/zone-id/email/routing/enable') { if (refuseEnable) throw Object.assign(new Error('refused'), { status: 400 }); return { status: 'ready', support_subaddress: false }; }
    if (method === 'GET' && path === '/zone-id/email/sending/subdomains') return subdomains;
    return body ?? {};
  };
  const api = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (path.startsWith('/queues')) return [{ queue_name: 'cf-email-events', queue_id: 'queue-id' }];
    if (method === 'GET' && path === '/event_subscriptions/subscriptions') return subscriptions;
    return body ?? {};
  };
  const query = async (text, params) => { sql.push({ text, params }); return text.startsWith('SELECT') ? rows : []; };
  return { api, zoneApi, query, calls, sql };
}
const clean = async () => [];
const run = (cf, extra = {}) => connectDomain({ api: cf.api, zoneApi: cf.zoneApi, query: cf.query, config: config(), domain: 'example.test', receive: true, confirm: async () => true, lookup: clean, report: () => {}, ...extra });

test('a clean domain is connected for receiving and sending with no DNS permission and no token', async () => {
  const cf = cloudflare();
  assert.deepEqual(await run(cf), { status: 'connected', receiving: true, sending: true, routingStatus: 'ready' });
  for (const call of ['POST /zones/zone-id/email/routing/enable', 'PUT /zones/zone-id/email/routing/rules/catch_all', 'PATCH /zones/zone-id/email/routing', 'POST /zones/zone-id/email/sending/subdomains', 'POST /event_subscriptions/subscriptions']) {
    assert.ok(cf.calls.includes(call), call);
  }
  assert.equal(cf.calls.some(call => call.includes('dns_records')), false);
  const insert = cf.sql.find(q => q.text.startsWith('INSERT INTO domains'));
  assert.deepEqual(insert.params.slice(1, 6), ['default', 'example.test', 'ready', 1, 1]);
});

test('another provider\'s mail records stop it before anything changes, with what to do', async () => {
  const cf = cloudflare();
  const lookup = async (name, type) => type === 'MX' ? ['1 aspmx.l.google.com.'] : ['v=spf1 include:_spf.google.com ~all'];
  const result = await run(cf, { lookup, confirm: async () => { throw new Error('must not ask'); } });
  assert.equal(result.status, 'blocked');
  assert.match(result.lines.join('\n'), /aspmx\.l\.google\.com/);
  assert.match(result.lines.join('\n'), /stops getting mail/);
  assert.match(result.lines.join('\n'), /include:_spf\.mx\.cloudflare\.net/);
  assert.equal(cf.calls.some(call => !call.startsWith('GET')), false);
  assert.deepEqual(cf.sql, []);
  assert.deepEqual(receivingBlockers('example.test', ['10 route1.mx.cloudflare.net.'], ['v=spf1 include:_spf.mx.cloudflare.net ~all']), []);
});

test('declining the summary changes nothing; a refusal from Cloudflare is explained', async () => {
  const declined = cloudflare();
  assert.deepEqual(await run(declined, { confirm: async () => false }), { status: 'cancelled' });
  assert.equal(declined.calls.some(call => !call.startsWith('GET')), false);
  const refused = cloudflare({ refuseEnable: true });
  const result = await run(refused);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(refused.sql, []);
});

test('Workers Free receives only; sending-only keeps existing mail routing untouched', async () => {
  const free = cloudflare();
  assert.deepEqual(await run(free, { config: config('free') }), { status: 'connected', receiving: true, sending: false, routingStatus: 'ready' });
  assert.equal(free.calls.some(call => call.includes('sending') || call.includes('event_subscriptions')), false);
  await assert.rejects(run(cloudflare(), { config: config('free'), receive: false }), /only receives/);
  const sendOnly = cloudflare({ zones: ['example.test'] });
  const result = await run(sendOnly, { receive: false, domain: 'news.example.test' });
  assert.deepEqual(result, { status: 'connected', receiving: false, sending: true, routingStatus: null });
  assert.equal(sendOnly.calls.some(call => call.includes('/email/routing')), false);
  assert.equal(sendOnly.sql.find(q => q.text.startsWith('INSERT')).params[3], 'sending-only');
  await assert.rejects(run(cloudflare(), { domain: 'news.example.test' }), /whole domain/);
});

test('running it again is safe, and unknown domains are refused clearly', async () => {
  const cf = cloudflare({
    routing: { status: 'ready', support_subaddress: true }, rows: [{ id: 'existing', receiving: 1 }],
    subdomains: [{ name: 'example.test' }], subscriptions: [{ source: { type: 'email.sending', domain: 'example.test' }, destination: { queue_id: 'queue-id' } }],
  });
  await run(cf, { lookup: async () => { throw new Error('no lookup needed'); } });
  assert.deepEqual(cf.calls.filter(call => call.startsWith('POST') || call.startsWith('PATCH')), []);
  assert.ok(cf.sql.some(q => q.text.startsWith('UPDATE domains')));
  await assert.rejects(run(cloudflare({ zones: [] })), /not on Cloudflare DNS in this account/);
  await assert.rejects(run(cloudflare(), { domain: 'not a domain' }), /example\.com/);
});

test('delivery events match the Worker\'s list', () => {
  const source = readFileSync(new URL('../../apps/worker/src/services/cloudflare/client.ts', import.meta.url), 'utf8');
  const worker = [...source.match(/DELIVERY_EVENTS = \[[^\]]+\]/)[0].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(DELIVERY_EVENTS, worker);
});
