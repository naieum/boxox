import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { experimental_readRawConfig } from 'wrangler'
import { configureDeploymentUrl } from './deploy-url.mjs'
import { applyDeploymentProfile, selectDeploymentPlan } from './deploy-profile.mjs'
import { applyCapacitySettings } from './deploy-limits.mjs'
import { prepareCloudflareOAuth } from './deploy-cloudflare-oauth.mjs'
import { checkMailStorage, prepareMailBuckets } from './deploy-storage.mjs'
import { installedSettings, resolveAccount, resolveOwner } from './deploy-identity.mjs'
import { cloudflareClient, cloudflareToken } from './cloudflare-api.mjs'

const token = cloudflareToken()
const cloudflare = cloudflareClient(token)
// Deploy to Cloudflare writes form values and resource ids into this config.
// Local/CI environment variables still take precedence over those values.
const { rawConfig: config } = experimental_readRawConfig({ config: process.env.BOXOX_CONFIG ?? 'wrangler.jsonc' })
const account = await resolveAccount({ CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? config.vars?.CF_ACCOUNT_ID }, () => cloudflare('GET', '/accounts?per_page=50'))
const api = (method, path, body) => cloudflare(method, `/accounts/${account}${path}`, body,
  path === '/subscriptions' ? (process.env.BOXOX_BILLING_TOKEN ?? token) : token)
const ask = process.stdin.isTTY ? async question => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try { return await prompt.question(question) } finally { prompt.close() }
} : undefined

applyCapacitySettings(config)
// What an earlier run installed. Upgrades need no settings repeated by hand.
const installed = await installedSettings(api, config.name)
const owner = await resolveOwner({ OWNER_EMAIL: process.env.OWNER_EMAIL ?? config.vars?.OWNER_EMAIL }, installed, () => cloudflare('GET', '/user'))
const profile = await selectDeploymentPlan(api, process.env.BOXOX_PLAN ?? config.vars?.BOXOX_EDITION ?? 'auto', { installed: installed?.BOXOX_EDITION, ask })
// Stop a downgrade before touching resources or removing a live send workflow.
if (profile.plan === 'free' && installed && installed.BOXOX_EDITION !== 'free') {
  throw new Error('This Worker already has a full Box Ox installation. Refusing to replace it with the Free profile. Use a separate Worker/resource configuration for a Free installation.')
}
if (profile.plan === 'paid' && !config.send_email) {
  throw new Error('This is the Free deployment template. To upgrade, review wrangler.paid.jsonc and copy your installation resource names and ids into it, then deploy with BOXOX_CONFIG=wrangler.paid.jsonc BOXOX_PLAN=paid. See docs/free-profile.md.')
}
applyDeploymentProfile(config, profile.plan)
console.log(`Selected Workers ${profile.plan === 'free' ? 'Free' : 'Paid'} profile (${profile.source}). No Cloudflare plan changes are made.`)
config.account_id = account
config.main = resolve(config.main)
config.assets.directory = resolve(config.assets.directory)
await checkMailStorage(api, account)
const origin = await configureDeploymentUrl(config, process.env.BOXOX_URL ?? installed?.customUrl, () => api('GET', '/workers/subdomain'), {
  accountId: account,
  requestedSubdomain: process.env.BOXOX_WORKERS_SUBDOMAIN,
  createWorkersSubdomain: subdomain => api('PUT', '/workers/subdomain', { subdomain }),
})
await prepareMailBuckets(config, api)
for (const database of config.d1_databases ?? []) {
  database.migrations_dir = resolve(database.migrations_dir ?? 'migrations')
  if (database.database_id) continue
  const list = await api('GET', '/d1/database?per_page=100')
  const row = list.find(d => d.name === database.database_name)
    ?? await api('POST', '/d1/database', { name: database.database_name, primary_location_hint: 'enam' })
  database.database_id = row.uuid
}
for (const namespace of config.kv_namespaces ?? []) {
  if (namespace.id) continue
  const title = `${config.name}-${namespace.binding}`
  const list = await api('GET', '/storage/kv/namespaces?per_page=1000')
  const row = list.find(n => n.title === title) ?? await api('POST', '/storage/kv/namespaces', { title })
  namespace.id = row.id
}
const queues = await api('GET', '/queues?per_page=100')
const names = new Set([
  ...(config.queues?.producers ?? []).map(q => q.queue),
  ...(config.queues?.consumers ?? []).flatMap(q => [q.queue, q.dead_letter_queue]).filter(Boolean),
])
for (const name of names) {
  if (!queues.some(q => q.queue_name === name)) await api('POST', '/queues', { queue_name: name })
}
if (config.vectorize?.length) {
  const list = await api('GET', '/vectorize/v2/indexes?per_page=100')
  for (const binding of config.vectorize) {
    if (!list.some(index => index.name === binding.index_name)) {
      await api('POST', '/vectorize/v2/indexes', {
        name: binding.index_name,
        config: { dimensions: 1536, metric: 'cosine' },
      })
    }
  }
}
config.vars = { ...config.vars, CF_ACCOUNT_ID: account, WORKER_NAME: config.name,
  EVENTS_QUEUE: config.queues.consumers.find(q => !config.queues.producers.some(p => p.queue === q.queue))?.queue ?? '',
  INGEST_QUEUE_NAME: config.queues.producers.find(p => p.binding === 'INGEST_QUEUE')?.queue ?? '',
  WEBHOOK_QUEUE_NAME: config.queues.producers.find(p => p.binding === 'WEBHOOK_QUEUE').queue,
  MAIL_BUCKET: config.r2_buckets.find(b => b.binding === 'MAIL_STORE').bucket_name,
}
config.vars.OWNER_EMAIL = owner
const deploymentDirectory = resolve(process.env.BOXOX_DEPLOY_DIR ?? '.wrangler/deploy')
mkdirSync(deploymentDirectory, { recursive: true })
const secretFile = resolve(deploymentDirectory, 'initial-secrets.json')
if (existsSync(secretFile)) unlinkSync(secretFile)
let secrets
try {
  secrets = await api('GET', `/workers/scripts/${config.name}/secrets`)
} catch (error) {
  if (error.status !== 404) throw error
  secrets = []
}
const has = name => secrets.some(secret => secret.name === name)
// Two independent roots: AGENT_JWT_SECRET signs agent JWTs and nothing else;
// BOXOX_SIGNING_SECRET derives every other key (links, tracking, sealing).
const initialSecrets = {}
for (const name of ['AGENT_JWT_SECRET', 'BOXOX_SIGNING_SECRET']) {
  if (!has(name)) initialSecrets[name] = randomBytes(32).toString('base64')
}
// Connect with Cloudflare needs an OAuth client registered in this account. An
// installed one is kept as it is; registering one is optional and only attempted on request.
if (process.env.CF_OAUTH_CLIENT_ID) await prepareCloudflareOAuth(config, api, process.env.CF_OAUTH_CLIENT_ID)
else if (installed?.CF_OAUTH_CLIENT_ID) config.vars.CF_OAUTH_CLIENT_ID = installed.CF_OAUTH_CLIENT_ID
writeFileSync(resolve(deploymentDirectory, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n')
if (Object.keys(initialSecrets).length) {
  writeFileSync(secretFile, JSON.stringify(initialSecrets), { mode: 0o600 })
  console.log(`Prepared new secrets for this deployment: ${Object.keys(initialSecrets).join(', ')}`)
}
console.log('Prepared installation resources and deployment configuration')
