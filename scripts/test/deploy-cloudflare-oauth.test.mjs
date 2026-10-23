import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareCloudflareOAuth } from '../deploy-cloudflare-oauth.mjs';
const config = edition => ({ name: 'boxox', vars: { PUBLIC_URL: 'https://mail.example.test', BOXOX_EDITION: edition } });
test('registers a private PKCE client with the exact callback and Free-only permissions', async () => {
  const c = config('free'), calls = [];
  await prepareCloudflareOAuth(c, async (method, path, body) => { calls.push({method, path, body}); return method === 'GET' ? [] : { client_id: 'registered-client' }; }, undefined, () => {});
  assert.equal(c.vars.CF_OAUTH_CLIENT_ID, 'registered-client');
  assert.deepEqual(calls[1].body.scopes, ['zone.read', 'dns.write', 'zone-settings.write', 'email-routing-rule.write']);
  assert.deepEqual(calls[1].body.redirect_uris, ['https://mail.example.test/api/cloudflare/callback']);
  assert.equal(calls[1].body.token_endpoint_auth_method, 'none');
  assert.equal(calls[1].body.visibility, undefined);
});
test('reuses an exact existing client and preserves supplied installation configuration', async () => {
  const c = config('paid'); let creates = 0;
  await prepareCloudflareOAuth(c, async method => { if (method !== 'GET') creates++; return [{client_id:'existing',client_name:'Box Ox (boxox)',token_endpoint_auth_method:'none',redirect_uris:['https://mail.example.test/api/cloudflare/callback'],grant_types:['authorization_code','refresh_token'],scopes:['zone.read','dns.write','zone-settings.write','email-routing-rule.write','email-sending.write','queues.write']}]; }, undefined, () => {});
  assert.equal(c.vars.CF_OAUTH_CLIENT_ID,'existing'); assert.equal(creates,0);
  await prepareCloudflareOAuth(c, async method => { assert.equal(method, 'GET'); return {scopes:['zone.read','dns.write','zone-settings.write','email-routing-rule.write','email-sending.write','queues.write']}; }, 'supplied', () => {});
  assert.equal(c.vars.CF_OAUTH_CLIENT_ID,'supplied');
});
test('reports missing registration permission without minting or copying deployment tokens', async () => {
  const c = config('paid'), messages=[];
  await prepareCloudflareOAuth(c, async method => { assert.equal(method,'GET'); throw Object.assign(new Error('denied'),{status:403}); }, undefined, message=>messages.push(message));
  assert.equal(c.vars.CF_OAUTH_CLIENT_ID,undefined); assert.match(messages[0],/OAuth Client Write/);
});

test('upgrades an existing configured client without changing its ID, redirect, or existing permissions', async () => {
  const c = config('free'); c.vars.CF_OAUTH_CLIENT_ID = 'installed-client';
  const calls = [], messages = [];
  await prepareCloudflareOAuth(c, async (method, path, body) => {
    calls.push({method, path, body});
    return method === 'GET' ? {scopes:['zone.read','dns.write','email-routing-rule.write','custom.read']} : {};
  }, undefined, message => messages.push(message));
  assert.deepEqual(calls.map(c => c.method), ['GET','PATCH']);
  assert.equal(calls[1].path, '/oauth_clients/installed-client');
  assert.deepEqual(Object.keys(calls[1].body), ['scopes']);
  assert.ok(calls[1].body.scopes.includes('zone-settings.write'));
  assert.ok(calls[1].body.scopes.includes('custom.read'));
  assert.equal(c.vars.CF_OAUTH_CLIENT_ID, 'installed-client');
  assert.match(messages[0], /reconnect/i);
});
test('upgrades a matching older client discovered during installation instead of creating a duplicate', async () => {
  const c = config('free'), calls=[];
  await prepareCloudflareOAuth(c, async (method, path, body) => {
    calls.push({method,path,body});
    return method === 'GET' ? [{client_id:'older-client',client_name:'Box Ox (boxox)',token_endpoint_auth_method:'none',redirect_uris:['https://mail.example.test/api/cloudflare/callback'],grant_types:['authorization_code','refresh_token'],scopes:['zone.read','dns.write','email-routing-rule.write']}] : {};
  }, undefined, () => {});
  assert.deepEqual(calls.map(c=>c.method), ['GET','PATCH']);
  assert.equal(c.vars.CF_OAUTH_CLIENT_ID,'older-client');
  assert.ok(calls[1].body.scopes.includes('zone-settings.write'));
});
