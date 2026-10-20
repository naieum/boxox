import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { experimental_readRawConfig } from 'wrangler';
import { applyDeploymentProfile, selectDeploymentPlan, workersPlanFromSubscriptions } from '../deploy-profile.mjs';

const subscription = (id, state = 'Paid') => ({ rate_plan: { id }, state });
test('detects account Workers subscriptions, without treating a paid website as Workers Paid', () => {
  assert.equal(workersPlanFromSubscriptions([subscription('CF_PRO_20_20'), subscription('TEAMS_STANDARD')]), 'free');
  for (const id of ['WORKERS_PAID', 'PARTNERS_WORKERS_ENT', 'PARTNERS_WORKERS_SS', 'PARTNERS_WORKERS_BASIC']) {
    assert.equal(workersPlanFromSubscriptions([subscription(id)]), 'paid');
  }
  assert.equal(workersPlanFromSubscriptions([subscription('WORKERS_PAID', 'Cancelled')]), 'free');
  assert.equal(workersPlanFromSubscriptions([]), 'free');
  assert.throws(() => workersPlanFromSubscriptions([{ rate_plan: { id: 'WORKERS_PAID' } }]), /subscription state/);
  assert.throws(() => workersPlanFromSubscriptions({}), /invalid subscription/);
  assert.throws(() => workersPlanFromSubscriptions([subscription('WORKERS_UNRECOGNIZED')]), /Unrecognized/);
});

test('auto detection is read-only and never treats permission or network failures as a Free account', async () => {
  const calls = [];
  const detected = await selectDeploymentPlan(async (...args) => { calls.push(args); return [subscription('WORKERS_PAID')]; });
  assert.equal(detected.plan, 'paid');
  assert.deepEqual(calls, [['GET', '/subscriptions']]);
  for (const status of [401, 403]) await assert.rejects(selectDeploymentPlan(async () => { throw Object.assign(new Error('forbidden'), { status }); }), /Billing Read/);
  await assert.rejects(selectDeploymentPlan(async () => { throw new Error('network failed'); }), /network failed/);
});

test('an explicit profile permits OAuth installation without making a billing request', async () => {
  for (const plan of ['free', 'paid']) assert.deepEqual(await selectDeploymentPlan(() => assert.fail('must not query'), plan), { plan, source: 'installer choice' });
  await assert.rejects(selectDeploymentPlan(() => assert.fail('must not query'), 'pro'), /auto, free, or paid/);
});

test('Free provisions inbox infrastructure and excludes outbound/AI/browser resources', () => {
  const { rawConfig } = experimental_readRawConfig({ config: existsSync('wrangler.paid.jsonc') ? 'wrangler.paid.jsonc' : 'wrangler.jsonc' });
  const profile = applyDeploymentProfile(structuredClone(rawConfig), 'free');
  for (const key of ['send_email', 'ai', 'vectorize', 'browser', 'analytics_engine_datasets']) assert.equal(profile[key], undefined, key);
  assert.equal(profile.vars.BOXOX_EDITION, 'free');
  assert.deepEqual(profile.workflows.map(w => w.binding).sort(), ['ENRICH_WORKFLOW', 'INGEST_WORKFLOW', 'SNOOZE_WORKFLOW']);
  assert.deepEqual(profile.queues.consumers.map(q => q.queue), ['webhook-delivery']);
  assert.equal(profile.queues.consumers[0].max_batch_size, 1);
  assert.ok(!profile.queues.producers.some(q => q.binding === 'INGEST_QUEUE'));
  assert.ok(profile.durable_objects.bindings.some(b => b.name === 'FREE_RUNTIME'));
  assert.deepEqual(profile.d1_databases, rawConfig.d1_databases);
  assert.deepEqual(profile.r2_buckets, rawConfig.r2_buckets);
  assert.deepEqual(profile.ratelimits, rawConfig.ratelimits);
  const paid = applyDeploymentProfile(structuredClone(rawConfig), 'paid');
  assert.ok(paid.send_email && paid.ai && paid.vectorize && paid.browser);
  assert.deepEqual(paid.workflows, rawConfig.workflows);
});
