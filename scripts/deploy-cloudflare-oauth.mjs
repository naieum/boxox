/** Register an installation-owned client; never copy Wrangler's credentials into the Worker. */
export async function prepareCloudflareOAuth(config, api, suppliedClientId, report = console.log) {
  if (suppliedClientId) config.vars.CF_OAUTH_CLIENT_ID = suppliedClientId;
  const callback = new URL('/api/cloudflare/callback', config.vars.PUBLIC_URL).href;
  const scopes = ['zone.read', 'dns.write', 'zone-settings.write', 'email-routing-rule.write',
    ...(config.vars.BOXOX_EDITION === 'free' ? [] : ['email-sending.write', 'queues.write'])];
  const name = `Box Ox (${config.name})`;
  try {
    const configuredId = config.vars.CF_OAUTH_CLIENT_ID;
    if (configuredId) {
      const existing = await api('GET', `/oauth_clients/${encodeURIComponent(configuredId)}`);
      const missing = scopes.filter(scope => !existing.scopes?.includes(scope));
      if (missing.length) {
        await api('PATCH', `/oauth_clients/${encodeURIComponent(configuredId)}`, {
          scopes: [...new Set([...(existing.scopes ?? []), ...scopes])],
        });
        report('Updated Cloudflare OAuth client permissions. The owner must reconnect from Domains → Add domain to approve the new access. Existing grants are unchanged until approval.');
      }
      return;
    }
    const clients = await api('GET', '/oauth_clients');
    const existing = clients.find(client => client.client_name === name
      && client.token_endpoint_auth_method === 'none'
      && client.redirect_uris?.length === 1 && client.redirect_uris[0] === callback
      && client.grant_types?.includes('refresh_token'));
    if (existing && scopes.some(scope => !existing.scopes?.includes(scope))) {
      await api('PATCH', `/oauth_clients/${encodeURIComponent(existing.client_id)}`, {
        scopes: [...new Set([...(existing.scopes ?? []), ...scopes])],
      });
      report('Updated Cloudflare OAuth client permissions. Reconnect from Domains → Add domain to approve the new access.');
    }
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
    report('Connect with Cloudflare needs an installation-owned OAuth client with the current scopes (including Zone Settings Write). The deployment credential lacks OAuth Client Write. Create or update that client (see docs/cloudflare-connection.md), then deploy with CF_OAUTH_CLIENT_ID and reconnect to approve the required scopes. Existing configured connections are preserved.');
  }
}
