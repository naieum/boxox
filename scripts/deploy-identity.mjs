/** The account the sign-in covers. Asking is only needed when there are several. */
export async function resolveAccount(env, listAccounts) {
  const chosen = (env.CF_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID)?.trim()
  if (chosen) {
    if (!/^[a-f0-9]{32}$/.test(chosen)) throw new Error('CF_ACCOUNT_ID must be the 32-character Cloudflare account ID')
    return chosen
  }
  const accounts = await listAccounts()
  if (accounts.length === 1) return accounts[0].id
  if (!accounts.length) throw new Error('This Cloudflare sign-in has no account. Sign in as a member of the account that will own Box Ox.')
  throw new Error(`This sign-in can reach ${accounts.length} Cloudflare accounts. Set CF_ACCOUNT_ID to the one that will own Box Ox and run the installer again:\n${accounts.map(a => `  ${a.id}  ${a.name}`).join('\n')}`)
}

/** Plain settings of an installed Worker, or null when this is a first install. */
export async function installedSettings(api, workerName) {
  let settings
  try {
    settings = await api('GET', `/workers/scripts/${workerName}/settings`)
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
  const values = Object.fromEntries((settings.bindings ?? []).filter(b => b.type === 'plain_text').map(b => [b.name, b.text]))
  let customUrl
  try {
    if (values.PUBLIC_URL && !new URL(values.PUBLIC_URL).hostname.endsWith('.workers.dev')) customUrl = values.PUBLIC_URL
  } catch { /* An unreadable address is treated as unset. */ }
  return { ...values, customUrl }
}

/** Explicit choice, then the installed owner, then whoever is signed in to Cloudflare. */
export async function resolveOwner(env, installed, getUser) {
  const explicit = env.OWNER_EMAIL?.trim().toLowerCase()
  if (explicit !== undefined && explicit !== '') {
    if (!explicit.includes('@')) throw new Error('OWNER_EMAIL must be an email address')
    return explicit
  }
  if (installed?.OWNER_EMAIL?.includes('@')) return installed.OWNER_EMAIL.trim().toLowerCase()
  let email
  try { email = (await getUser())?.email } catch (error) { if (error.status !== 401 && error.status !== 403) throw error }
  if (!email?.includes('@')) throw new Error('Set OWNER_EMAIL to the email address that will sign in to Box Ox')
  return email.trim().toLowerCase()
}
