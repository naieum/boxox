import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Direct-download packages only. npm pack creates local archives and runs no registry publish operation.
const root = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] ?? `${root}/.wrangler/release/tools-0.2.0`);
mkdirSync(output, { recursive: true });
for (const path of ['packages/sdk/package.json', 'packages/cli/package.json']) {
  if (JSON.parse(readFileSync(resolve(root, path), 'utf8')).version !== '0.2.0') throw new Error(`Unexpected tool version: ${path}`);
}
execFileSync('pnpm', ['--filter', '@boxox/cli', 'build'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
for (const path of ['packages/sdk', 'packages/cli']) {
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output, '--json'], { cwd: resolve(root, path), stdio: ['ignore', 'pipe', 'pipe'] });
}
copyFileSync(resolve(root, 'packages/cli/dist/boxox.mjs'), resolve(output, 'boxox-cli-0.2.0.mjs'));
const artifacts = ['boxox-mail-0.2.0.tgz', 'boxox-cli-0.2.0.tgz', 'boxox-cli-0.2.0.mjs'].map(name => {
  const bytes = readFileSync(resolve(output, name));
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
execFileSync('python3', ['scripts/check-release-privacy.py', output], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(JSON.stringify({ directory: output, artifacts }, null, 2) + '\n');
