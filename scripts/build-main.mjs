// Bundles the Electron main process and preload script with esbuild.
// npm dependencies stay external (shipped in node_modules); workspace packages (@aegis/*) are bundled.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  tsconfig: 'tsconfig.json',
};

const external = ['electron', ...deps, ...deps.map((d) => `${d}/*`)];

await build({
  ...common,
  entryPoints: ['apps/desktop/main/main.ts'],
  outfile: 'dist/main/main.cjs',
  external,
});

// The sandboxed preload may only require('electron'); bundle everything else in.
await build({
  ...common,
  entryPoints: ['apps/desktop/preload/preload.ts'],
  outfile: 'dist/main/preload.cjs',
  external: ['electron'],
});

console.log('main + preload built');
