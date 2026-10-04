// Development: Vite dev server for the renderer + Electron with the freshly built main process.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PORT = 5173;
const url = `http://localhost:${PORT}`;

spawnSync('node', ['scripts/build-main.mjs'], { cwd: root, stdio: 'inherit' });

const vite = spawn('npx', ['vite', '--config', 'apps/desktop/renderer/vite.config.ts', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const waitForServer = () =>
  new Promise((resolve) => {
    const tick = () =>
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => setTimeout(tick, 300));
    tick();
  });

await waitForServer();
const electronPath = require('electron');
const electron = spawn(electronPath, ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, AEGIS_DEV_URL: url } });
const stop = () => {
  vite.kill();
  process.exit(0);
};
electron.on('exit', stop);
process.on('SIGINT', stop);
