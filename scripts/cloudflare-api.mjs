import { execFileSync, spawnSync } from 'node:child_process'

/**
 * The installer signs in through Wrangler, Cloudflare's own tool. Box Ox
 * registers no application of its own with Cloudflare, so installing and
 * running it never depends on its publisher.
 */
export function cloudflareToken(env = process.env) {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN
  const read = () => {
    const raw = execFileSync('pnpm', ['exec', 'wrangler', 'auth', 'token', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return JSON.parse(raw.slice(raw.indexOf('{'))).token
  }
  try { return read() } catch { /* Not signed in yet. */ }
  if (!process.stdin.isTTY) throw new Error('No Cloudflare sign-in found. Run "pnpm exec wrangler login", or set CLOUDFLARE_API_TOKEN, and try again.')
  console.log('Sign in to Cloudflare in the browser page that opens, and allow Wrangler. Wrangler is Cloudflare\'s own deployment tool.')
  if (spawnSync('pnpm', ['exec', 'wrangler', 'login'], { stdio: 'inherit' }).status !== 0) throw new Error('Cloudflare sign-in did not complete')
  return read()
}

/** Errors carry the HTTP status and Cloudflare's codes, never the account ID or a token. */
export function cloudflareClient(token, fetcher = fetch) {
  return async function cloudflare(method, path, body, bearer = token) {
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const envelope = await response.json().catch(() => null)
    if (!response.ok || !envelope?.success) {
      const error = new Error(`Cloudflare ${method} ${path.replace(/^\/accounts\/[a-f0-9]{32}/, '')}: HTTP ${response.status} (${envelope?.errors?.map(e => e.code).join(', ')})`)
      error.status = response.status
      error.codes = envelope?.errors?.map(e => e.code) ?? []
      throw error
    }
    return envelope.result
  }
}
