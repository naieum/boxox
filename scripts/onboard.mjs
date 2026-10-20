#!/usr/bin/env node
// node scripts/onboard.mjs example.com [--gateway-configured-in-dashboard]
// Uses the same domain client as /api/setup; Wrangler OAuth stays in memory.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const child = spawnSync(process.execPath, ['--experimental-transform-types', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(child.status ?? 1)
}
const { CloudflareClient, mergeLifecycleRules, DELIVERY_EVENTS } = await import('../apps/worker/src/services/cloudflare/client.ts')
const { checkDomainHealth } = await import('../apps/worker/src/services/domain-health.ts')
const domain = process.argv[2]?.toLowerCase()
if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) throw new Error('Usage: node scripts/onboard.mjs example.com [--gateway-configured-in-dashboard]')
const account = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID
if (!account) throw new Error('Set CF_ACCOUNT_ID to your installation account')
const worker = process.env.BOXOX_WORKER ?? 'boxox'
const databaseName = process.env.BOXOX_DATABASE ?? 'boxox'
const bucket = process.env.BOXOX_BUCKET ?? 'boxox-mail'
const gateway = process.env.AI_GATEWAY_ID ?? 'default'
const token = process.env.CLOUDFLARE_API_TOKEN ?? (() => {
  const raw = execFileSync('pnpm', ['exec', 'wrangler', 'auth', 'token', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(raw.slice(raw.indexOf('{'))).token
})()
const client = new CloudflareClient({ token, accountId: account })
const changes = []
async function api(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  })
  const envelope = await res.json()
  if (!res.ok || !envelope.success) throw new Error(`Cloudflare ${method} ${path}: HTTP ${res.status} (${envelope.errors?.map(e => e.code).join(', ')})`)
  return envelope.result
}
const zone = await client.findZone(domain)
let routing = await client.getRoutingSettings(zone.id)
if (routing.status !== 'ready') {
  // This may need DNS edit scope. A ready zone needs no DNS record edits.
  const result = await client.onboardZone(domain, { routing: true, confirmMxReplacement: process.argv.includes('--replace-mx') })
  if (result.status !== 'onboarded') throw new Error(`${result.plan.warning ?? 'DNS changes require approval'}. Rerun with --replace-mx only after approving this change.`)
  routing = result.routing
  changes.push('routing enabled')
}
const sending = await client.enableSending(zone.id, domain)
const sendingDns = await client.getSendingDnsStatus(zone.id, sending.id)
if (!sending.enabled || sendingDns.status !== 'ready' || routing?.status !== 'ready') throw new Error(`Mail DNS is not ready: routing=${routing?.status}, sending=${sendingDns.status}`)
const catchAll = await client.getCatchAll(zone.id)
if (!catchAll.enabled || catchAll.actions.length !== 1 || catchAll.actions[0]?.type !== 'worker' || catchAll.actions[0]?.value?.[0] !== worker) {
  await client.setCatchAllToWorker(zone.id, worker)
  changes.push('catch-all routed to installation Worker')
}
if (!routing.support_subaddress) {
  await client.setSubaddressing(zone.id, true)
  changes.push('subaddressing enabled')
}
const queue = await client.findQueue(process.env.BOXOX_EVENTS_QUEUE ?? 'cf-email-events')
const existingSubscriptions = await client.listEventSubscriptions()
const subscription = await client.subscribeDeliveryEvents({ zoneId: zone.id, domain, queueId: queue.queue_id })
if (!existingSubscriptions.some(s => s.id === subscription.id)) changes.push('delivery event subscription created')
if (!subscription.enabled || DELIVERY_EVENTS.some(e => !subscription.events.includes(e))) throw new Error('Existing delivery subscription is disabled or missing required events; repair it before continuing')

// Preserve stored mail. Trash expiry is handled by the D1-aware retention cron;
// only incomplete multipart uploads get an automatic lifecycle expiration.
const lifecycle = await client.getBucketLifecycle(bucket)
const desiredLifecycle = mergeLifecycleRules(lifecycle, [])
if (JSON.stringify(lifecycle) !== JSON.stringify(desiredLifecycle)) {
  await client.applyRetentionLifecycle(bucket, [])
  changes.push('incomplete multipart cleanup configured')
}
let gatewayVerification = 'API'
try {
  const current = await api('GET', `/ai-gateway/gateways/${gateway}`)
  const safe = current.zdr === true && current.collect_logs === false && current.cache_ttl === 0
    && current.authentication === true && current.spend_limits?.enabled
    && current.spend_limits.rules.some(r => r.limitType === 'cost' && r.limit <= 1 && r.window === 86400)
  if (!safe) {
    await client.applyGatewaySettings(gateway, { dailySpendLimitUsd: 1 })
    changes.push('gateway privacy and daily spend limit configured')
  }
} catch (error) {
  if (!/HTTP 403/.test(error.message) || !process.argv.includes('--gateway-configured-in-dashboard')) throw error
  gatewayVerification = 'owner dashboard; API permission unavailable'
  console.log('Gateway settings were configured in the dashboard; this OAuth session cannot verify them through the API.')
}
const health = await checkDomainHealth(domain, { selector: sending.dkim_selector, returnPath: sending.return_path_domain, receiving: true }, fetch)
if (!health.healthy) throw new Error(`Public mail DNS failed: ${health.checks.filter(c => c.required && c.status !== 'ok').map(c => `${c.name}=${c.status}`).join(', ')}`)
const databases = await api('GET', '/d1/database?per_page=100')
const database = databases.find(d => d.name === databaseName)
if (!database) throw new Error(`D1 database ${databaseName} does not exist`)
const query = (sql, params = []) => api('POST', `/d1/database/${database.uuid}/query`, { sql, params })
const [read] = await query('SELECT id, status, sending_enabled, receiving_enabled FROM domains WHERE organization_id = ? AND name = ?', ['default', domain])
const existing = read.results[0]
if (!existing) {
  await query('INSERT INTO domains (id, organization_id, name, status, sending_enabled, receiving_enabled, health, health_checked_at, last_synced_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)', [randomUUID(), 'default', domain, 'ready', JSON.stringify(health), Date.now(), Date.now()])
  changes.push('domain registered in application')
} else if (existing.status !== 'ready' || !existing.sending_enabled || !existing.receiving_enabled) {
  await query('UPDATE domains SET status = ?, sending_enabled = 1, receiving_enabled = 1, health = ?, health_checked_at = ?, last_synced_at = ?, updated_at = ? WHERE id = ?', ['ready', JSON.stringify(health), Date.now(), Date.now(), Date.now(), existing.id])
  changes.push('application domain configuration repaired')
}
mkdirSync('.loops/runs', { recursive: true })
const report = { domain, worker, status: 'ready', health, gatewayVerification, changes, checkedAt: new Date().toISOString() }
writeFileSync(`.loops/runs/onboard-${domain}.json`, JSON.stringify(report, null, 2) + '\n')
console.log(`${domain}: mail DNS ready; ${changes.length ? changes.join('; ') : 'already configured; no changes'}`)
