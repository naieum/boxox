#!/usr/bin/env node
// pnpm run domain example.com [--send-only] [--yes]
// Connects a mail domain to this installation with your Cloudflare sign-in on this
// computer. Nothing is stored in the app: it needs no Cloudflare credential for mail.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { cloudflareClient, cloudflareToken } from './cloudflare-api.mjs'

// Keep in step with DELIVERY_EVENTS in apps/worker/src/services/cloudflare/client.ts.
export const DELIVERY_EVENTS = ['message.delivered', 'message.deferred', 'message.bounced', 'message.failed', 'message.rejected', 'message.complained']
const CF_MX = '.mx.cloudflare.net'
const CF_SPF = 'include:_spf.mx.cloudflare.net'
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/

/** Public DNS, because the installer's sign-in cannot read a zone's records. */
export async function publicRecords(name, type, fetcher = fetch) {
  const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } })
  if (!response.ok) throw new Error(`Could not look up ${type} records for ${name} (HTTP ${response.status})`)
  const wanted = type === 'MX' ? 15 : 16
  return ((await response.json()).Answer ?? []).filter(a => a.type === wanted).map(a => a.data.replace(/^"|"$/g, '').replace(/" "/g, ''))
}

/** What stands in the way of receiving, in the owner's words. Empty means nothing does. */
export function receivingBlockers(domain, mx, txt) {
  const foreignMx = mx.map(r => r.replace(/\.$/, '')).filter(r => !r.split(/\s+/).pop().toLowerCase().endsWith(CF_MX))
  const spf = txt.find(r => /^v=spf1\b/i.test(r))
  const foreignSpf = spf && !spf.toLowerCase().includes(CF_SPF) ? spf : null
  const lines = []
  if (foreignMx.length) {
    lines.push(`${domain} receives mail somewhere else today:`, ...foreignMx.map(r => `    MX  ${r}`),
      'Receiving in Box Ox replaces these, and your current provider stops getting mail for this domain.',
      `Delete those MX records in the Cloudflare dashboard (${domain} → DNS → Records), then run this command again.`)
  }
  if (foreignSpf) {
    lines.push(`${domain} has an SPF record for another provider:`, `    TXT  ${foreignSpf}`,
      `Add ${CF_SPF} to it in the Cloudflare dashboard (keep what you still send through), then run this command again.`)
  }
  return lines
}

export async function connectDomain({ api, zoneApi, query, config, domain, receive, confirm, lookup = publicRecords, report = console.log }) {
  if (!DOMAIN.test(domain)) throw new Error('Give the domain as example.com')
  const paid = config.vars.BOXOX_EDITION !== 'free'
  if (!paid && !receive) throw new Error('The Workers Free install only receives mail. Run the command without --send-only.')
  // The zone is the domain or a parent of it; receiving needs the zone itself.
  let zone
  for (let name = domain; name.includes('.') && !zone; name = name.slice(name.indexOf('.') + 1)) {
    zone = (await zoneApi('GET', `?name=${encodeURIComponent(name)}&account.id=${config.account_id}`))[0]
  }
  if (!zone) throw new Error(`${domain} is not on Cloudflare DNS in this account. Add the domain to Cloudflare first, then run this command again.`)
  if (receive && zone.name !== domain) throw new Error(`Receiving needs the whole domain. Use ${zone.name}, or add --send-only to send from ${domain}.`)
  const z = (method, path, body) => zoneApi(method, `/${zone.id}${path}`, body)

  let routing = null
  if (receive) {
    routing = await z('GET', '/email/routing').catch(error => { if (error.status === 404) return null; throw error })
    if (routing?.status !== 'ready') {
      const blockers = receivingBlockers(domain, await lookup(domain, 'MX'), await lookup(domain, 'TXT'))
      if (blockers.length) return { status: 'blocked', lines: blockers }
    }
  }
  const plan = [
    receive && routing?.status !== 'ready' && `turn on Email Routing for ${domain} (Cloudflare adds its MX and SPF records)`,
    receive && `deliver all mail for ${domain} to this Box Ox, and turn on plus-addressing`,
    paid && `turn on Email Sending for ${domain} (Cloudflare adds DKIM and return-path records)`,
    paid && 'send delivery events to this Box Ox',
  ].filter(Boolean)
  report(`\nThis will:\n${plan.map(line => `  - ${line}`).join('\n')}\n`)
  if (!(await confirm('Continue? Type yes: '))) return { status: 'cancelled' }

  if (receive) {
    if (routing?.status !== 'ready') {
      try {
        routing = await z('POST', '/email/routing/enable', {})
      } catch (error) {
        // Cloudflare refuses while another provider's MX or SPF is present.
        if (error.status !== 400 && error.status !== 409) throw error
        return { status: 'blocked', lines: [`Cloudflare would not turn on Email Routing for ${domain}. Remove MX and SPF records that belong to another mail provider in ${domain} → DNS → Records, then run this command again.`] }
      }
      if (routing.status !== 'ready') routing = await z('GET', '/email/routing')
    }
    await z('PUT', '/email/routing/rules/catch_all', { enabled: true, name: 'Box Ox catch-all', matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [config.name] }] })
    if (!routing.support_subaddress) await z('PATCH', '/email/routing', { support_subaddress: true })
  }
  if (paid) {
    const subdomains = await z('GET', '/email/sending/subdomains')
    if (!subdomains.some(s => s.name === domain)) await z('POST', '/email/sending/subdomains', { name: domain })
    const queueName = config.vars.EVENTS_QUEUE || 'cf-email-events'
    const queue = (await api('GET', '/queues?per_page=100')).find(q => q.queue_name === queueName)
    if (!queue) throw new Error(`The ${queueName} queue is missing. Run "pnpm run deploy" again, then this command.`)
    const subscriptions = await api('GET', '/event_subscriptions/subscriptions')
    if (!subscriptions.some(s => s.source?.type === 'email.sending' && s.source.domain === domain && s.destination?.queue_id === queue.queue_id)) {
      await api('POST', '/event_subscriptions/subscriptions', {
        name: `boxox-email-events-${domain.replace(/\./g, '-')}`, enabled: true,
        source: { type: 'email.sending', zone_id: zone.id, domain },
        destination: { type: 'queues.queue', queue_id: queue.queue_id }, events: DELIVERY_EVENTS,
      })
    }
  }

  // The same row the in-app setup writes.
  const status = receive ? (routing?.status ?? 'pending') : 'sending-only'
  const now = Date.now()
  const existing = (await query('SELECT id, receiving_enabled AS receiving FROM domains WHERE organization_id = ? AND name = ?', ['default', domain]))[0]
  if (existing) {
    await query('UPDATE domains SET status = ?, sending_enabled = ?, receiving_enabled = ?, last_synced_at = ?, updated_at = ? WHERE id = ?',
      [status, paid ? 1 : 0, existing.receiving || receive ? 1 : 0, now, now, existing.id])
  } else {
    await query('INSERT INTO domains (id, organization_id, name, status, sending_enabled, receiving_enabled, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), 'default', domain, status, paid ? 1 : 0, receive ? 1 : 0, now])
  }
  return { status: 'connected', receiving: receive, sending: paid, routingStatus: routing?.status ?? null }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const domain = args.find(a => !a.startsWith('--'))?.toLowerCase()
  if (!domain) throw new Error('Usage: pnpm run domain example.com [--send-only]')
  let config
  try { config = JSON.parse(readFileSync(resolve(process.env.BOXOX_DEPLOY_DIR ?? '.wrangler/deploy', 'wrangler.json'), 'utf8')) } catch { throw new Error('Run "pnpm run deploy" first: this checkout has no installation settings yet.') }
  const cloudflare = cloudflareClient(cloudflareToken())
  const api = (method, path, body) => cloudflare(method, `/accounts/${config.account_id}${path}`, body)
  const database = config.d1_databases.find(db => db.binding === 'DB').database_id
  const confirm = async question => {
    if (args.includes('--yes')) return true
    if (!process.stdin.isTTY) throw new Error('Add --yes to confirm when no one is at the keyboard.')
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    try { return (await prompt.question(question)).trim().toLowerCase() === 'yes' } finally { prompt.close() }
  }
  const result = await connectDomain({
    api, config, domain, receive: !args.includes('--send-only'), confirm,
    zoneApi: (method, path, body) => cloudflare(method, `/zones${path}`, body),
    query: async (sql, params) => (await api('POST', `/d1/database/${database}/query`, { sql, params }))[0]?.results ?? [],
  })
  if (result.status === 'blocked') { console.log(`\n${result.lines.join('\n')}\n\nNothing was changed.`); process.exit(1) }
  if (result.status === 'cancelled') { console.log('Nothing was changed.'); process.exit(1) }
  console.log(`${domain} is connected: ${[result.receiving && 'receiving', result.sending && 'sending'].filter(Boolean).join(' and ')}.`)
  if (result.receiving && result.routingStatus !== 'ready') console.log(`Email Routing reports "${result.routingStatus}". DNS can take a few minutes; wait before testing incoming mail.`)
  console.log(`Create your first address at ${new URL('/domains', config.vars.PUBLIC_URL)}`)
}
