import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../dist/cli.js';

async function request(args) {
  const output = [];
  const unavailable = async () => { throw new Error('MCP request must not access the credential store'); };
  await run(['mcp', 'request', ...args], { output: value => output.push(value), keychain: { get: unavailable, set: unavailable } });
  return output[0];
}
test('MCP requests prepare exact mailbox scopes and client arguments without credentials or network access', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('MCP request must not make network requests'); };
  try {
    const result = await request(['--url', 'https://mail.example.test/', '--mailbox', 'Hello@Example.test', '--mailbox', 'hello@example.test', '--mailbox', 'ian@example.test']);
    assert.equal(result.status, 'request_prepared');
    assert.equal(result.approvalRequired, true);
    assert.deepEqual(result.mailboxes, [{ email: 'hello@example.test', permissions: ['read'] }, { email: 'ian@example.test', permissions: ['read'] }]);
    assert.deepEqual(result.scopes, ['boxox:read:hello@example.test', 'boxox:read:ian@example.test']);
    assert.equal(result.oauth.resource, 'https://mail.example.test/mcp');
    assert.equal(result.oauth.scope, result.scopes.join(' '));
    assert.deepEqual(result.codex.args, ['mcp', 'login', 'boxox', '--scopes', result.scopes.join(',')]);
  } finally { globalThis.fetch = fetchBefore; }
});
test('individual grants do not add sending rights to other mailboxes', async () => {
  const result = await request(['--url', 'https://mail.example.test', '--grant', 'read:hello@example.test', '--grant', 'send:hello@example.test', '--grant', 'read:ian@example.test', '--server-name', 'work-mail']);
  assert.deepEqual(result.mailboxes, [{ email: 'hello@example.test', permissions: ['read', 'send'] }, { email: 'ian@example.test', permissions: ['read'] }]);
  assert.equal(result.codex.args[2], 'work-mail');
  assert.ok(!result.scopes.includes('boxox:send:ian@example.test'));
});
test('shared permissions are explicit and duplicate choices do not duplicate scopes', async () => {
  const result = await request(['--url', 'https://mail.example.test', '--mailbox', 'hello@example.test', '--perm', 'read', '--perm', 'send', '--perm', 'read']);
  assert.deepEqual(result.scopes, ['boxox:read:hello@example.test', 'boxox:send:hello@example.test']);
});
test('invalid and ambiguous requests fail before starting authorization', async () => {
  for (const args of [
    [], ['--mailbox', 'hello@example.test'], ['--url', 'https://mail.example.test'],
    ['--url', 'http://mail.example.test', '--mailbox', 'hello@example.test'],
    ['--url', 'https://mail.example.test/path', '--mailbox', 'hello@example.test'],
    ['--url', 'https://mail.example.test', '--mailbox', 'hello@example.test', '--perm', 'owner'],
    ['--url', 'https://mail.example.test', '--grant', 'read:hello@example.test', '--perm', 'send'],
    ['--url', 'https://mail.example.test', '--grant', 'read:hello@example.test', '--mailbox', 'ian@example.test'],
    ['--url', 'https://mail.example.test', '--mailbox', 'hello@example.test,boxox:send:ian@example.test'],
    ['--url', 'https://mail.example.test', '--mailbox', 'hello@example.test', '--server-name', 'bad name'],
    ['--url', 'https://mail.example.test', '--mailbox', 'hello@example.test', '--permissions', 'send'],
    ['--url', 'https://mail.example.test', '--mailbox', 'hello@example.test', 'extra'],
  ]) await assert.rejects(request(args));
});
