import assert from 'node:assert/strict';
import test from 'node:test';
import { installedSettings, resolveAccount, resolveOwner } from '../deploy-identity.mjs';

const ACCOUNT = 'a'.repeat(32);
test('the account is found without typing an ID unless the sign-in reaches several', async () => {
  assert.equal(await resolveAccount({}, async () => [{ id: ACCOUNT, name: 'Mine' }]), ACCOUNT);
  assert.equal(await resolveAccount({ CF_ACCOUNT_ID: ACCOUNT }, async () => { throw new Error('not listed'); }), ACCOUNT);
  await assert.rejects(resolveAccount({ CF_ACCOUNT_ID: 'nope' }, async () => []), /32-character/);
  await assert.rejects(resolveAccount({}, async () => []), /no account/);
  await assert.rejects(resolveAccount({}, async () => [{ id: ACCOUNT, name: 'One' }, { id: 'b'.repeat(32), name: 'Two' }]), error => {
    assert.match(error.message, /Set CF_ACCOUNT_ID/); assert.match(error.message, /One/); assert.match(error.message, /Two/); return true;
  });
});

test('an upgrade reads the owner, address and profile from the installed Worker', async () => {
  const api = async () => ({ bindings: [
    { type: 'plain_text', name: 'OWNER_EMAIL', text: 'owner@example.test' },
    { type: 'plain_text', name: 'PUBLIC_URL', text: 'https://mail.example.test' },
    { type: 'plain_text', name: 'BOXOX_EDITION', text: 'paid' },
    { type: 'secret_text', name: 'BOXOX_SIGNING_SECRET' },
  ] });
  const installed = await installedSettings(api, 'boxox');
  assert.equal(installed.customUrl, 'https://mail.example.test');
  assert.equal(installed.BOXOX_EDITION, 'paid');
  assert.equal(installed.BOXOX_SIGNING_SECRET, undefined);
  assert.equal(await resolveOwner({}, installed, async () => { throw new Error('not needed'); }), 'owner@example.test');
  const workersDev = await installedSettings(async () => ({ bindings: [{ type: 'plain_text', name: 'PUBLIC_URL', text: 'https://boxox.test-account.workers.dev' }] }), 'boxox');
  assert.equal(workersDev.customUrl, undefined);
  assert.equal(await installedSettings(async () => { throw Object.assign(new Error('missing'), { status: 404 }); }, 'boxox'), null);
  await assert.rejects(installedSettings(async () => { throw Object.assign(new Error('denied'), { status: 403 }); }, 'boxox'), /denied/);
});

test('a first install makes the signed-in person the owner, unless told otherwise', async () => {
  assert.equal(await resolveOwner({}, null, async () => ({ email: 'Me@Example.Test' })), 'me@example.test');
  assert.equal(await resolveOwner({ OWNER_EMAIL: ' Boss@Example.Test ' }, { OWNER_EMAIL: 'old@example.test' }, async () => ({ email: 'me@example.test' })), 'boss@example.test');
  await assert.rejects(resolveOwner({ OWNER_EMAIL: 'nope' }, null, async () => ({})), /email address/);
  await assert.rejects(resolveOwner({}, null, async () => { throw Object.assign(new Error('denied'), { status: 403 }); }), /Set OWNER_EMAIL/);
});
