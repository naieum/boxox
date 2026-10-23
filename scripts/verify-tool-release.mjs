import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'apps/site/dist/downloads');
const manifest = JSON.parse(readFileSync(join(directory, existsSync(join(directory, 'tools-release.json')) ? 'tools-release.json' : 'release.json'), 'utf8'));
const checksums = readFileSync(join(directory, existsSync(join(directory, 'RESOURCE-SHA256SUMS.txt')) ? 'RESOURCE-SHA256SUMS.txt' : 'SHA256SUMS.txt'), 'utf8');
for (const a of manifest.artifacts) {
  const bytes = readFileSync(join(directory, a.name));
  assert.equal(bytes.length, a.bytes, a.name);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), a.sha256, a.name);
  assert.ok(checksums.includes(`${a.sha256}  ${a.name}\n`), a.name);
}
const skill = join(directory, `boxox-email-skill-${manifest.skillVersion}.zip`);
const members = execFileSync('unzip', ['-Z1', skill], { encoding: 'utf8' }).split('\n');
for (const file of ['SKILL.md', 'LICENSE', 'references/mcp-access.md', 'references/email-design.md', 'assets/send-email.mjs', 'assets/webhook-route.mjs', 'assets/invoice-template.json']) assert.ok(members.includes(file), file);
const instructions = execFileSync('unzip', ['-p', skill, 'SKILL.md'], { encoding: 'utf8' });
assert.ok(instructions.includes(`version: ${manifest.skillVersion}`));
assert.ok(instructions.includes(`/downloads/boxox-cli-${manifest.cliVersion}.tgz`));
assert.ok(instructions.includes(`/downloads/boxox-mail-${manifest.sdkVersion}.tgz`));
const temporary = mkdtempSync(join(tmpdir(), 'boxox-tool-release-'));
try {
  execFileSync('npm', ['install', '--global', '--prefix', temporary, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, `boxox-cli-${manifest.cliVersion}.tgz`)], { stdio: 'pipe' });
  const executable = join(temporary, 'bin/boxox');
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), manifest.cliVersion);
  const args = ['mcp', 'request', '--url', 'https://mail.example.test', '--grant', 'read:hello@example.test', '--grant', 'send:hello@example.test', '--grant', 'read:ian@example.test'];
  const installed = JSON.parse(execFileSync(executable, args, { encoding: 'utf8' }));
  const standalone = JSON.parse(execFileSync(process.execPath, [join(directory, `boxox-cli-${manifest.cliVersion}.mjs`), ...args], { encoding: 'utf8' }));
  assert.deepEqual(installed, standalone);
  assert.deepEqual(installed.scopes, ['boxox:read:hello@example.test', 'boxox:send:hello@example.test', 'boxox:read:ian@example.test']);
  assert.equal(installed.approvalRequired, true);
  assert.equal(installed.status, 'request_prepared');
  assert.deepEqual(installed.codex.args.slice(-2), ['--scopes', installed.scopes.join(',')]);
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log(`Verified CLI ${manifest.cliVersion} and skill ${manifest.skillVersion}: hashes, packaged references, offline install, standalone execution, and exact requested scopes`);
