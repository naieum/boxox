import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function buildEmailSkill(root, output, version) {
  const temporary = mkdtempSync(join(tmpdir(), 'boxox-email-skill-'));
  try {
    for (const name of ['SKILL.md', 'LICENSE', 'assets', 'references']) {
      cpSync(join(root, 'skills/boxox-email', name), join(temporary, name), { recursive: true });
    }
    const fixedTime = new Date('2026-10-18T00:00:00Z');
    function normalize(path) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) normalize(child);
        utimesSync(child, fixedTime, fixedTime);
      }
      utimesSync(path, fixedTime, fixedTime);
    }
    normalize(temporary);
    mkdirSync(output, { recursive: true });
    rmSync(resolve(output, `boxox-email-skill-${version}.zip`), { force: true });
    execFileSync('zip', ['-X', '-q', '-r', resolve(output, `boxox-email-skill-${version}.zip`), 'SKILL.md', 'LICENSE', 'assets', 'references'], { cwd: temporary });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
