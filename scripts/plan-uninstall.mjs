import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Local inventory only. A binding proves use, not exclusive ownership. */
export function planUninstall(config) {
  if (!/^[a-f0-9]{32}$/.test(config.account_id ?? '') || !/^[a-z0-9][a-z0-9_-]*$/.test(config.name ?? '')) {
    throw new Error('Use the generated installation config with its account_id and Worker name. Do not infer an account from the portable source config.');
  }
  const resources = [];
  const seen = new Set();
  const add = (type, name, id, containsData = false) => {
    if (typeof name !== 'string' || !name) throw new Error(`Missing ${type} resource name`);
    const key = JSON.stringify([type, name, id]);
    if (seen.has(key)) return;
    seen.add(key);
    resources.push({ type, name, ...(id ? { id } : {}), ownership: 'unverified', containsData, action: 'review', retainByDefault: true });
  };
  add('worker', config.name, undefined, true);
  for (const row of config.d1_databases ?? []) {
    if (!row.database_id) throw new Error('Missing D1 database_id. Use the generated deployment config.');
    add('d1', row.database_name, row.database_id, true);
  }
  for (const row of config.kv_namespaces ?? []) {
    if (!row.id) throw new Error('Missing KV namespace id. Use the generated deployment config.');
    add('kv', row.binding, row.id, true);
  }
  for (const row of config.r2_buckets ?? []) add('r2', row.bucket_name, undefined, true);
  for (const row of config.vectorize ?? []) add('vectorize', row.index_name, undefined, true);
  for (const row of config.queues?.producers ?? []) add('queue', row.queue, undefined, true);
  for (const row of config.queues?.consumers ?? []) {
    add('queue', row.queue, undefined, true);
    if (row.dead_letter_queue) add('queue', row.dead_letter_queue, undefined, true);
  }
  for (const row of config.workflows ?? []) add('workflow', row.name, undefined, true);
  for (const row of config.durable_objects?.bindings ?? []) {
    if (row.script_name && row.script_name !== config.name) continue;
    add('durable-object-class', row.class_name, undefined, true);
  }
  for (const row of config.analytics_engine_datasets ?? []) add('analytics-dataset', row.dataset, undefined, true);
  return {
    mode: 'review-only', mutations: 0, accountId: config.account_id, worker: config.name,
    dataPolicy: 'preserve-until-explicitly-approved', resources,
    manualInventory: ['Mail domains, DNS and Email Routing rules', 'Email Sending domains and delivery-event subscriptions',
      'Access applications and policies', 'Installation OAuth client and grants', 'Webhooks, API keys, agents and scheduled work',
      'Custom hostnames, deployment pipelines, backups, logs and local credentials'],
    warnings: ['This is a local configuration inventory, not a live ownership audit or an executable removal plan.',
      'Move incoming mail and verify the replacement before removing routing or the Worker.',
      'Worker deletion can also delete Durable Object namespaces and their state.',
      'Retain shared resources and account-wide plans. Confirm every deletion by exact account and resource ID.'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('Usage: node scripts/plan-uninstall.mjs [--config path/to/generated/wrangler.json]. This command cannot apply changes.');
    const file = args[1] ?? '.wrangler/deploy/wrangler.json';
    console.log(JSON.stringify(planUninstall(JSON.parse(readFileSync(file, 'utf8'))), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
