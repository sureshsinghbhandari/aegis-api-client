// Bundles the command-line runner (apps/cli) with esbuild to dist/cli/aegis-cli.cjs.
// Same conventions as build-main.mjs: npm dependencies stay external, @aegis/* workspace packages are bundled.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});

await build({
  absWorkingDir: root,
  entryPoints: ['apps/cli/src/main.ts'],
  outfile: 'dist/cli/aegis-cli.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  tsconfig: 'tsconfig.json',
  banner: { js: '#!/usr/bin/env node' },
  define: { __AEGIS_CLI_VERSION__: JSON.stringify(pkg.version) },
  external: ['electron', ...deps, ...deps.map((d) => `${d}/*`)],
});

console.log('cli built -> dist/cli/aegis-cli.cjs');
