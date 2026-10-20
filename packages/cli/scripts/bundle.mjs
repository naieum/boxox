import { build } from 'esbuild';
await build({
  entryPoints: ['src/bin.ts'], outfile: 'dist/boxox.mjs', bundle: true,
  platform: 'node', target: 'node22', format: 'esm',
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: 'import { createRequire as boxoxCreateRequire } from "node:module"; const require = boxoxCreateRequire(import.meta.url);' },
  legalComments: 'eof',
});
