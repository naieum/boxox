import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimental_readRawConfig } from 'wrangler';
import { applyDeploymentProfile } from '../deploy-profile.mjs';

function prepare(form, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'boxox-deploy-form-'));
  try {
    const { rawConfig: config } = experimental_readRawConfig({ config: existsSync('wrangler.paid.jsonc') ? 'wrangler.paid.jsonc' : 'wrangler.jsonc' });
    config.vars = form;
    if (form.BOXOX_EDITION === 'free') applyDeploymentProfile(config, 'free');
    config.d1_databases[0].database_id = '00000000-0000-4000-8000-000000000001';
    config.kv_namespaces[0].id = '00000000000000000000000000000001';
    const configPath = join(directory, 'form.json');
    const log = join(directory, 'requests.jsonl');
    const loader = join(directory, 'fake-cloudflare.mjs');
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(log, '');
    writeFileSync(loader, `import {appendFileSync} from 'node:fs';
globalThis.fetch = async (url, options) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({url, method:options.method}) + '\\n');
  let result;
  if (url.endsWith('/workers/scripts/boxox/settings')) return new Response(JSON.stringify({success:false}), {status:404});
  else if (url.endsWith('/r2/buckets?per_page=1')) result = {buckets:[]};
  else if (url.endsWith('/workers/subdomain')) result = {subdomain:'offline-boxox-test'};
  else if (url.endsWith('/r2/buckets/boxox-mail')) result = {};
  else if (url.endsWith('/queues?per_page=100')) result = [];
  else if (url.endsWith('/queues') && options.method === 'POST') result = {};
  else if (url.endsWith('/vectorize/v2/indexes?per_page=100')) result = [{name:'boxox-search'}];
  else if (url.endsWith('/oauth_clients')) return new Response(JSON.stringify({success:false}), {status:403});
  else if (url.endsWith('/workers/scripts/boxox/secrets')) result = [{name:'AGENT_JWT_SECRET'}];
  else throw new Error('Unexpected provisioning request: ' + options.method + ' ' + url);
  return new Response(JSON.stringify({success:true,result}), {headers:{'content-type':'application/json'}});
};`);
    const execution = spawnSync(process.execPath, ['--import', loader, 'scripts/prepare-deploy.mjs'], {
      cwd: new URL('../../', import.meta.url), encoding: 'utf8',
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        CLOUDFLARE_API_TOKEN: 'offline-test-fixture', BOXOX_PLAN: 'paid',
        BOXOX_CONFIG: configPath, BOXOX_DEPLOY_DIR: join(directory, 'deploy'), ...overrides,
      },
    });
    const requests = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const generated = execution.status === 0 ? JSON.parse(readFileSync(join(directory, 'deploy/wrangler.json'), 'utf8')) : null;
    return { execution, requests, generated };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('hosted form values reach the generated config and selected D1/KV ids are preserved', () => {
  const { execution, generated, requests } = prepare({ CF_ACCOUNT_ID: '00000000000000000000000000000002', OWNER_EMAIL: 'Owner@Example.com' });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(generated.vars.OWNER_EMAIL, 'owner@example.com');
  assert.equal(generated.account_id, '00000000000000000000000000000002');
  assert.equal(generated.d1_databases[0].database_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(generated.kv_namespaces[0].id, '00000000000000000000000000000001');
  assert.ok(requests.length > 0);
  assert.ok(requests.every(({ url }) => url.includes('/accounts/00000000000000000000000000000002/')));
  assert.ok(!requests.some(({ url }) => /\/d1\/|\/storage\/kv\/|\/subscriptions/.test(url)), 'Existing ids and explicit Paid plan avoid resource creation and billing lookup');
});

test('build environment overrides form values', () => {
  const { execution, generated } = prepare({ CF_ACCOUNT_ID: 'old-account', OWNER_EMAIL: 'old@example.com' }, {
    CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000003', OWNER_EMAIL: 'build@example.com',
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(generated.account_id, '00000000000000000000000000000003');
  assert.equal(generated.vars.OWNER_EMAIL, 'build@example.com');
});

test('missing form owner stops before any Cloudflare request', () => {
  const { execution, requests } = prepare({ CF_ACCOUNT_ID: '00000000000000000000000000000002', OWNER_EMAIL: '' });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /Set OWNER_EMAIL/);
  assert.deepEqual(requests, []);
});

test('Free template installs without a billing lookup or paid resources', () => {
  const { execution, generated, requests } = prepare({ CF_ACCOUNT_ID: '00000000000000000000000000000002', OWNER_EMAIL: 'owner@example.com', BOXOX_EDITION: 'free' }, { BOXOX_PLAN: undefined });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(generated.vars.BOXOX_EDITION, 'free');
  for (const field of ['send_email', 'ai', 'vectorize', 'browser', 'analytics_engine_datasets']) assert.equal(generated[field], undefined);
  assert.ok(!requests.some(({ url }) => /\/subscriptions|\/vectorize\//.test(url)));
  assert.deepEqual(generated.queues.producers.map(q => q.binding), ['WEBHOOK_QUEUE']);
});

test('a Free template cannot silently claim a Paid upgrade with missing bindings', () => {
  const { execution, requests } = prepare({ CF_ACCOUNT_ID: '00000000000000000000000000000002', OWNER_EMAIL: 'owner@example.com', BOXOX_EDITION: 'free' });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /review wrangler.paid.jsonc/);
  assert.deepEqual(requests, []);
});
