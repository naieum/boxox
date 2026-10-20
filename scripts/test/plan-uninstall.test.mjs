import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { planUninstall } from '../plan-uninstall.mjs';

const config = {
  account_id: '00000000000000000000000000000002', name: 'custom-mail',
  d1_databases: [{ database_name: 'custom-db', database_id: 'db-id' }],
  kv_namespaces: [{ binding: 'KV', id: 'kv-id' }], r2_buckets: [{ bucket_name: 'custom-mail-store' }],
  queues: { producers: [{ queue: 'custom-hooks' }], consumers: [{ queue: 'custom-hooks', dead_letter_queue: 'custom-hooks-dlq' }] },
  workflows: [{ name: 'custom-ingest' }],
  durable_objects: { bindings: [{ class_name: 'FreeRuntime' }, { class_name: 'SharedClass', script_name: 'another-app' }] },
};

test('inventory uses installation IDs, deduplicates queues and never assumes ownership', () => {
  const plan = planUninstall(config);
  assert.equal(plan.mutations, 0);
  assert.equal(plan.mode, 'review-only');
  assert.equal(plan.dataPolicy, 'preserve-until-explicitly-approved');
  assert.ok(plan.resources.every(row => row.ownership === 'unverified' && row.retainByDefault));
  assert.deepEqual(plan.resources.filter(row => row.type === 'queue').map(row => row.name), ['custom-hooks', 'custom-hooks-dlq']);
  assert.equal(plan.resources.find(row => row.type === 'd1').id, 'db-id');
  assert.ok(!plan.resources.some(row => row.name === 'SharedClass'));
  assert.match(plan.warnings.join(' '), /Durable Object namespaces/);
});

test('portable or incomplete config cannot masquerade as an installation inventory', () => {
  assert.throws(() => planUninstall({ name: 'boxox' }), /generated installation config/);
  assert.throws(() => planUninstall({ ...config, d1_databases: [{ database_name: 'db' }] }), /database_id/);
  assert.throws(() => planUninstall({ ...config, kv_namespaces: [{ binding: 'KV' }] }), /namespace id/);
});

test('inventory excludes secrets and unrelated configuration', () => {
  const plan = JSON.stringify(planUninstall({ ...config, vars: { TOKEN: 'do-not-print-me' }, secrets: { key: 'also-private' } }));
  assert.ok(!plan.includes('do-not-print-me'));
  assert.ok(!plan.includes('also-private'));
});

test('CLI refuses apply flags before it reads config or contacts Cloudflare', () => {
  const result = spawnSync(process.execPath, ['scripts/plan-uninstall.mjs', '--apply'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot apply changes/);
  assert.equal(result.stdout, '');
});
