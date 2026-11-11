#!/usr/bin/env node
// pnpm run owner-link
// Writes a single-use sign-in link for the owner into the installation's database
// and prints it. Whoever controls the Cloudflare account can do this; that is the
// same person who could redeploy the app, so it is the recovery path as well.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cloudflareClient, cloudflareToken } from './cloudflare-api.mjs'

export const OWNER_LINK_HOURS = 24

/**
 * `onlyIfNeeded` is for the end of an install: say nothing when Cloudflare
 * Access signs people in, or when the owner already has a passkey.
 */
export async function ownerLink({ api, config, onlyIfNeeded = false, now = Date.now(), random = randomBytes }) {
  const secrets = await api('GET', `/workers/scripts/${config.name}/secrets`)
  const has = name => secrets.some(secret => secret.name === name)
  if (has('ACCESS_AUD') && has('TEAM_DOMAIN')) return { status: 'access' }
  const owner = config.vars?.OWNER_EMAIL?.trim().toLowerCase()
  const origin = config.vars?.PUBLIC_URL
  const database = config.d1_databases?.find(db => db.binding === 'DB')?.database_id
  if (!owner || !origin || !database) throw new Error('Run "pnpm run deploy" first: this checkout has no installation settings yet.')
  const query = async (sql, params = []) => (await api('POST', `/d1/database/${database}/query`, { sql, params }))[0]?.results ?? []
  if (onlyIfNeeded && (await query('SELECT 1 AS present FROM auth_passkeys WHERE user_email = ? LIMIT 1', [owner])).length) return { status: 'ready', owner }
  const code = random(32).toString('base64url')
  // Only the newest unused link from the installer works; only its SHA-256 is stored.
  await query("DELETE FROM auth_invites WHERE created_by = 'installer' AND used_at IS NULL")
  await query('INSERT INTO auth_invites (code_hash, user_email, user_name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [createHash('sha256').update(code).digest('hex'), owner, '', 'installer', now, now + OWNER_LINK_HOURS * 3_600_000])
  return { status: 'created', owner, link: `${new URL(origin).origin}/welcome#${code}` }
}

export function ownerLinkMessage(result) {
  if (result.status === 'access') return 'Cloudflare Access signs people in to this installation. Box Ox sign-in links are not used.'
  if (result.status === 'ready') return `Sign in at your Box Ox address with your passkey (${result.owner}). Lost it? Run "pnpm run owner-link".`
  return `\nCreate the owner's passkey (${result.owner}) by opening this link in your browser.\nIt works once and expires in ${OWNER_LINK_HOURS} hours. Anyone who has it can become the owner, so do not share it.\n\n  ${result.link}\n\nFor a new link, run "pnpm run owner-link".`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const directory = resolve(process.env.BOXOX_DEPLOY_DIR ?? '.wrangler/deploy')
  let config
  try { config = JSON.parse(readFileSync(resolve(directory, 'wrangler.json'), 'utf8')) } catch { throw new Error('Run "pnpm run deploy" first: this checkout has no installation settings yet.') }
  const cloudflare = cloudflareClient(cloudflareToken())
  const api = (method, path, body) => cloudflare(method, `/accounts/${config.account_id}${path}`, body)
  console.log(ownerLinkMessage(await ownerLink({ api, config, onlyIfNeeded: process.argv.includes('--if-needed') })))
}
