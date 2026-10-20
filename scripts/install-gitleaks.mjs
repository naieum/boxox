import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Pinned official release, verified against its published SHA-256 checksums.
const version = '8.30.1';
const builds = {
  'darwin-arm64': ['darwin_arm64', 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'],
  'linux-x64': ['linux_x64', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'],
};
const build = builds[`${process.platform}-${process.arch}`];
if (!build) throw new Error('Install Gitleaks 8.30.1 for this platform and set GITLEAKS_BIN to its executable.');
const output = resolve('.wrangler/tools');
mkdirSync(output, { recursive: true, mode: 0o700 });
const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${build[0]}.tar.gz`, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`Gitleaks download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== build[1]) throw new Error('Gitleaks download checksum mismatch');
const archive = resolve(output, 'gitleaks.tar.gz');
try {
  writeFileSync(archive, bytes, { mode: 0o600 });
  execFileSync('tar', ['-xzf', archive, '-C', output, 'gitleaks']);
  chmodSync(resolve(output, 'gitleaks'), 0o700);
} finally { rmSync(archive, { force: true }); }
console.log(`Installed checksum-verified Gitleaks ${version} in .wrangler/tools`);
