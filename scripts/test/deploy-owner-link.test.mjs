import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ownerLink, ownerLinkMessage } from '../owner-link.mjs';

const config = { name: 'boxox', vars: { OWNER_EMAIL: 'Owner@Example.Test', PUBLIC_URL: 'https://boxox.test-account.workers.dev' }, d1_databases: [{ binding: 'DB', database_id: 'db-id' }] };
function cloudflare({ secrets = [], passkeys = 0 } = {}) {
  const queries = [];
  const api = async (method, path, body) => {
    if (path.endsWith('/secrets')) return secrets.map(name => ({ name }));
    assert.equal(path, '/d1/database/db-id/query');
    queries.push(body);
    return [{ results: body.sql.startsWith('SELECT') ? Array(passkeys).fill({ present: 1 }) : [] }];
  };
  return { api, queries };
}

test('a new installation gets one single-use owner link; only its hash is stored', async () => {
  const cf = cloudflare();
  const result = await ownerLink({ api: cf.api, config, onlyIfNeeded: true, now: 1_000 });
  assert.equal(result.status, 'created');
  assert.equal(result.owner, 'owner@example.test');
  const [origin, code] = result.link.split('/welcome#');
  assert.equal(origin, 'https://boxox.test-account.workers.dev');
  assert.ok(code.length >= 43);
  const insert = cf.queries.find(q => q.sql.startsWith('INSERT'));
  assert.deepEqual(insert.params, [createHash('sha256').update(code).digest('hex'), 'owner@example.test', '', 'installer', 1_000, 1_000 + 24 * 3_600_000]);
  assert.equal(JSON.stringify(cf.queries).includes(code), false);
  // An older unused link stops working when a new one is made.
  assert.ok(cf.queries.findIndex(q => q.sql.startsWith('DELETE FROM auth_invites')) < cf.queries.indexOf(insert));
  assert.match(ownerLinkMessage(result), /works once/);
  assert.match(ownerLinkMessage(result), /do not share/);
});

test('an install run says nothing new when the owner already has a passkey, but recovery always makes a link', async () => {
  const cf = cloudflare({ passkeys: 1 });
  assert.deepEqual(await ownerLink({ api: cf.api, config, onlyIfNeeded: true }), { status: 'ready', owner: 'owner@example.test' });
  assert.equal(cf.queries.some(q => q.sql.startsWith('INSERT')), false);
  assert.equal((await ownerLink({ api: cf.api, config })).status, 'created');
});

test('installations behind Cloudflare Access get no Box Ox link', async () => {
  const cf = cloudflare({ secrets: ['ACCESS_AUD', 'TEAM_DOMAIN'] });
  assert.deepEqual(await ownerLink({ api: cf.api, config }), { status: 'access' });
  assert.deepEqual(cf.queries, []);
  // One value alone is not Access: the app would use its own sign-in.
  assert.equal((await ownerLink({ api: cloudflare({ secrets: ['ACCESS_AUD'] }).api, config })).status, 'created');
});

test('an unconfigured checkout is told to deploy first', async () => {
  await assert.rejects(ownerLink({ api: cloudflare().api, config: { name: 'boxox', vars: {} } }), /pnpm run deploy/);
});
