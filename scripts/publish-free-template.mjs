import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimental_readRawConfig } from 'wrangler';
import { freeDeploymentTemplate } from './deploy-template.mjs';

const git = (args, options = {}) => execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
if (process.argv.slice(2).join(' ') !== '--publish') throw new Error('Use node scripts/publish-free-template.mjs --publish from reviewed main');
if (git(['branch', '--show-current']) !== 'main' || git(['status', '--porcelain'])) {
  throw new Error('Publish the Free template only from a clean main checkout');
}
const source = git(['rev-parse', 'HEAD']);
if (source !== git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0]) {
  throw new Error('Local main must match published main');
}
const branch = 'deploy-free';
const previous = git(['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s/)[0];
if (previous) {
  git(['fetch', '--no-tags', 'origin', branch]);
  const metadata = JSON.parse(git(['show', `${previous}:.boxox-template.json`]));
  if (metadata.schema !== 1 || metadata.profile !== 'free') throw new Error('Refusing to replace a branch not marked as the generated Free template');
  if (metadata.sourceCommit === source) { console.log(`Free template already uses ${source}`); process.exit(0); }
}
const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
const files = freeDeploymentTemplate(rawConfig, source, readFileSync('wrangler.jsonc', 'utf8'));
const directory = mkdtempSync(join(tmpdir(), 'boxox-free-template-'));
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(directory, 'index') };
  git(['read-tree', source], { env });
  for (const [path, content] of files) {
    const object = git(['hash-object', '-w', '--stdin'], { input: content });
    git(['update-index', '--add', '--cacheinfo', `100644,${object},${path}`], { env });
  }
  const tree = git(['write-tree'], { env });
  const parents = ['-p', source, ...(previous ? ['-p', previous] : [])];
  const commit = git(['commit-tree', tree, ...parents, '-m', `Build Free deployment template from ${source.slice(0, 12)}`]);
  // Include the previous template as a parent so updates never need force pushes.
  const push = spawnSync('git', ['push', 'origin', `${commit}:refs/heads/${branch}`], { stdio: 'inherit' });
  if (push.status !== 0) throw new Error('Free template push failed; no force push attempted');
  console.log(`Published Free template ${commit} from ${source}`);
} finally { rmSync(directory, { recursive: true, force: true }); }
