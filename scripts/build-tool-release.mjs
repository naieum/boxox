import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildEmailSkill } from './build-email-skill.mjs';

// Direct-download packages only. npm pack creates local archives and runs no registry publish operation.
const root = resolve(import.meta.dirname, '..');
const sdkVersion = JSON.parse(readFileSync(resolve(root, 'packages/sdk/package.json'), 'utf8')).version;
const cliVersion = JSON.parse(readFileSync(resolve(root, 'packages/cli/package.json'), 'utf8')).version;
const skillVersion = readFileSync(resolve(root, 'skills/boxox-email/SKILL.md'), 'utf8').match(/^  version: (\d+\.\d+\.\d+)$/m)?.[1];
if (!skillVersion) throw new Error('Missing email skill version');
const output = resolve(process.argv[2] ?? `${root}/.wrangler/release/tools-${cliVersion}`);
mkdirSync(output, { recursive: true });
execFileSync('pnpm', ['--filter', '@boxox/cli', 'build'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
for (const path of ['packages/sdk', 'packages/cli']) {
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output, '--json'], { cwd: resolve(root, path), stdio: ['ignore', 'pipe', 'pipe'] });
}
copyFileSync(resolve(root, 'packages/cli/dist/boxox.mjs'), resolve(output, `boxox-cli-${cliVersion}.mjs`));
buildEmailSkill(root, output, skillVersion);
const artifacts = [`boxox-mail-${sdkVersion}.tgz`, `boxox-cli-${cliVersion}.tgz`, `boxox-cli-${cliVersion}.mjs`, `boxox-email-skill-${skillVersion}.zip`].map(name => {
  const bytes = readFileSync(resolve(output, name));
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
execFileSync('python3', ['scripts/check-release-privacy.py', output], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(JSON.stringify({ directory: output, cliVersion, sdkVersion, skillVersion, artifacts }, null, 2) + '\n');
