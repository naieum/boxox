import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';
import { freeDeploymentTemplate } from '../deploy-template.mjs';

const fullConfigPath = existsSync('wrangler.paid.jsonc') ? 'wrangler.paid.jsonc' : 'wrangler.jsonc';
const fullText = readFileSync(fullConfigPath, 'utf8');
const { rawConfig } = experimental_readRawConfig({ config: fullConfigPath });

test('Cloudflare sees only Free resources before the installer runs', () => {
  const files = freeDeploymentTemplate(rawConfig, '0'.repeat(40), fullText);
  const free = JSON.parse(files.get('wrangler.jsonc'));
  assert.equal(free.vars.BOXOX_EDITION, 'free');
  for (const field of ['send_email', 'ai', 'vectorize', 'browser', 'analytics_engine_datasets']) assert.equal(free[field], undefined);
  assert.deepEqual(free.d1_databases, rawConfig.d1_databases);
  assert.deepEqual(free.r2_buckets, rawConfig.r2_buckets);
  assert.equal(files.get('wrangler.paid.jsonc'), fullText);
  assert.ok(rawConfig.browser, 'Rendering a template must not change the main configuration');
});

test('publishing preserves the workspace and updates the Free branch without force pushes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boxox-template-repository-'));
  try {
    const remote = join(directory, 'remote.git');
    const checkout = join(directory, 'checkout');
    mkdirSync(checkout);
    const git = (args, cwd = checkout) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', '--bare', remote], directory);
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Template test']);
    git(['config', 'user.email', 'template@example.com']);
    writeFileSync(join(checkout, 'wrangler.jsonc'), fullText);
    writeFileSync(join(checkout, 'workspace-source.txt'), 'Application and sibling packages stay in the template.\n');
    git(['add', '.']);
    git(['commit', '-m', 'Source fixture']);
    git(['remote', 'add', 'origin', remote]);
    git(['push', 'origin', 'main']);
    const source = git(['rev-parse', 'HEAD']);
    const script = fileURLToPath(new URL('../publish-free-template.mjs', import.meta.url));
    const publish = () => {
      const result = spawnSync(process.execPath, [script, '--publish'], { cwd: checkout, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      git(['fetch', 'origin', 'deploy-free']);
      return git(['rev-parse', 'FETCH_HEAD']);
    };
    const first = publish();
    assert.equal(git(['show', `${first}:workspace-source.txt`]), 'Application and sibling packages stay in the template.');
    assert.equal(JSON.parse(git(['show', `${first}:wrangler.jsonc`])).vars.BOXOX_EDITION, 'free');
    assert.equal(JSON.parse(git(['show', `${first}:.boxox-template.json`])).sourceCommit, source);
    assert.equal(git(['show', `${first}:wrangler.paid.jsonc`]), fullText.trim());
    assert.equal(git(['rev-parse', 'HEAD']), source);
    assert.equal(git(['status', '--porcelain']), '');
    writeFileSync(join(checkout, 'workspace-source.txt'), 'Updated application source.\n');
    git(['add', '.']);
    git(['commit', '-m', 'Update source fixture']);
    git(['push', 'origin', 'main']);
    const second = publish();
    assert.notEqual(first, second);
    assert.equal(git(['merge-base', '--is-ancestor', first, second]), '');
    assert.equal(git(['show', `${second}:workspace-source.txt`]), 'Updated application source.');
    assert.equal(publish(), second, 'Publishing the same source twice is a no-op');
    assert.equal(git(['status', '--porcelain']), '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
