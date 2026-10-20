/** Register an installation-owned client; never copy Wrangler's credentials into the Worker. */
export async function prepareCloudflareOAuth(config, api, suppliedClientId, report = console.log) {
  if (suppliedClientId) { config.vars.CF_OAUTH_CLIENT_ID = suppliedClientId; return; }
  if (config.vars.CF_OAUTH_CLIENT_ID) return;
  const callback = new URL('/api/cloudflare/callback', config.vars.PUBLIC_URL).href;
  const scopes = ['zone.read', 'dns.write', 'email-routing-rule.write',
    ...(config.vars.BOXOX_EDITION === 'free' ? [] : ['email-sending.write', 'queues.write'])];
  const name = `Box Ox (${config.name})`;
  try {
    const clients = await api('GET', '/oauth_clients');
    const existing = clients.find(client => client.client_name === name
      && client.token_endpoint_auth_method === 'none'
      && client.redirect_uris?.length === 1 && client.redirect_uris[0] === callback
      && client.grant_types?.includes('refresh_token')
      && scopes.every(scope => client.scopes?.includes(scope)));
    const client = existing ?? await api('POST', '/oauth_clients', {
      client_name: name, grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none',
      redirect_uris: [callback], scopes, client_uri: new URL(config.vars.PUBLIC_URL).origin,
      logo_uri: 'https://boxox.dev/brand/ox-head-v2.png',
      policy_uri: 'https://boxox.dev/privacy/', tos_uri: 'https://boxox.dev/terms/',
    });
    if (!client?.client_id) throw new Error('Cloudflare did not return an OAuth client ID');
    config.vars.CF_OAUTH_CLIENT_ID = client.client_id;
    report('Prepared Connect with Cloudflare. The owner approves domain access in Cloudflare; no token copying is needed.');
  } catch (error) {
    if (error.status !== 403) throw error;
    report('Connect with Cloudflare needs one installation-owned OAuth client. The deployment credential lacks OAuth Client Write. Create that client once (see docs/cloudflare-connection.md), then deploy with CF_OAUTH_CLIENT_ID. Existing configured connections are preserved.');
  }
}
