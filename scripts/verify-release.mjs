import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'apps/site/dist/downloads');
const release = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
const checksums = readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8');
for (const artifact of release.artifacts) {
  const bytes = readFileSync(join(directory, artifact.name));
  assert.equal(bytes.length, artifact.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  assert.ok(checksums.includes(`${artifact.sha256}  ${artifact.name}\n`));
}
const sourceFiles = execFileSync('unzip', ['-Z1', join(directory, 'boxox-v2.zip')], { encoding: 'utf8' }).trim().split('\n');
if (['2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.4.5', '2.4.6', '2.4.7', '2.4.8'].includes(release.version)) for (const name of ['scripts/plan-uninstall.mjs', 'scripts/deploy-storage.mjs', 'docs/uninstall.md', 'apps/site/public/uninstall-agent.md']) {
  assert.ok(sourceFiles.includes(`boxox-v2/${name}`), `Source archive missing removal/installer file ${name}`);
}
for (const name of ['.github/workflows/ci.yml', 'skills/boxox-email/SKILL.md', 'scripts/test/db-generator.test.mjs', 'migrations/0003_api_sent_copies.sql', 'migrations/0004_sent_folder.sql', 'migrations/0005_cloudflare_connections.sql', 'scripts/deploy-cloudflare-oauth.mjs', 'migrations/0006_agent_changes.sql', 'migrations/0007_agent_work.sql', 'migrations/0008_ingest_jobs.sql', 'migrations/0009_agent_send_requests.sql', 'scripts/build-tool-release.mjs', 'docs/agent-automation.md']) {
  assert.ok(sourceFiles.includes(`boxox-v2/${name}`), `Source archive missing ${name}`);
}
assert.ok(sourceFiles.every(name => !/(?:^|\/)(?:\.git|\.loops|\.wrangler|node_modules|dist|snitchfindings)(?:\/|$)/.test(name)), 'Runtime/private directories in source archive');
assert.ok(sourceFiles.every(name => !/(?:^|\/)(?:\.env|\.dev.vars)$/.test(name)), 'Runtime secrets file in source archive');
if (['2.4.3', '2.4.4', '2.4.5', '2.4.6', '2.4.7', '2.4.8'].includes(release.version)) {
  for (const path of ['scripts/check-release-privacy.py', 'scripts/install-gitleaks.mjs', 'scripts/release-secret-fixtures.json']) assert.ok(sourceFiles.includes(`boxox-v2/${path}`), `Privacy check missing: ${path}`);
  assert.ok(sourceFiles.every(name => !/^boxox-v2\/(?:spikes\/|docs\/spikes\/|docs\/security-review.md)/.test(name)), 'Internal experiments and audit prose are not installable source');
}
if (['2.4.4', '2.4.5', '2.4.6', '2.4.7', '2.4.8'].includes(release.version)) assert.ok(!sourceFiles.includes('boxox-v2/docs/v2-plan.md'), 'Internal planning document is not installable source');
if (release.version === '2.4.8') for (const name of ['apps/worker/src/oauth/consent-page.ts', 'apps/worker/src/oauth/consent.ts', 'docs/release-2.4.8.md']) assert.ok(sourceFiles.includes(`boxox-v2/${name}`), `MCP consent release missing ${name}`);
const currentSkillFiles=execFileSync('unzip',['-Z1',join(directory,release.artifacts.find(a=>a.name.startsWith('boxox-email-skill-')).name)],{encoding:'utf8'}).split('\n');
for(const name of ['SKILL.md','assets/send-email.mjs','assets/webhook-route.mjs','assets/invoice-template.json','references/email-design.md'])assert.ok(currentSkillFiles.includes(name),`Current skill missing ${name}`);
const skillText=execFileSync('unzip',['-p',join(directory,release.artifacts.find(a=>a.name.startsWith('boxox-email-skill-')).name),'SKILL.md'],{encoding:'utf8'});
for(const prefix of ['boxox-mail-','boxox-cli-']){
  const dependency=release.artifacts.find(a=>a.name.startsWith(prefix)&&a.name.endsWith('.tgz'));
  assert.ok(skillText.includes(`/downloads/${dependency.name}`),`Email skill must install the SDK/CLI covered by this release's checksums: ${dependency.name}`);
}
const temporary = mkdtempSync(join(tmpdir(), 'boxox-release-packages-'));
try {
  // Offline installs prove the public packages need no private workspace or npm registry dependency.
  execFileSync('npm', ['install', '--global', '--prefix', temporary, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, 'boxox-cli-0.2.0.tgz')], { stdio: 'pipe' });
  assert.match(execFileSync(join(temporary, 'bin/boxox'), ['--help'], { encoding: 'utf8' }), /agent claim/);
  assert.equal(execFileSync(join(temporary, 'bin/boxox'), ['--version'], { encoding: 'utf8' }).trim(), '0.2.0');
  execFileSync('npm', ['install', '--prefix', temporary, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, 'boxox-mail-0.2.0.tgz')], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--input-type=module', '-e', "import { BoxOx, BoxOxAgent, verifyWebhook } from '@boxox/mail'; if (typeof BoxOx !== 'function' || typeof BoxOxAgent !== 'function' || typeof verifyWebhook !== 'function') process.exit(1)"], { cwd: temporary, stdio: 'pipe' });
  assert.match(execFileSync(process.execPath, [join(directory, 'boxox-cli-0.2.0.mjs'), '--help'], { encoding: 'utf8', cwd: temporary }), /agent claim/);
  assert.equal(execFileSync(process.execPath, [join(directory, 'boxox-cli-0.2.0.mjs'), '--version'], { encoding: 'utf8', cwd: temporary }).trim(), '0.2.0');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(`Verified Box Ox ${release.version}: all artifact checksums, source inventory, skill layout, offline SDK/CLI installs, standalone CLI`);
execFileSync('python3', ['scripts/check-release-privacy.py', directory], { stdio: 'inherit' });
