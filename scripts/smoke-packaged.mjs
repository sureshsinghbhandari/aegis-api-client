// Boots the PACKAGED app (release/win-unpacked) and exercises DB, IPC, HTTP and the script sandbox.
import { _electron as electron } from '@playwright/test';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = process.argv[2] ?? 'release/win-unpacked/Aegis API Client.exe';
const server = http.createServer((_q, r) => { r.setHeader('Content-Type', 'application/json'); r.end('{"ok":true,"n":7}'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const dir = mkdtempSync(path.join(os.tmpdir(), 'aegis-pkg-'));
const app = await electron.launch({ executablePath: path.resolve(exe), env: { ...process.env, AEGIS_USER_DATA_DIR: dir } });
const win = await app.firstWindow();
await win.waitForSelector('.app', { timeout: 30000 });
const out = await win.evaluate(async (baseUrl) => {
  const api = window.api;
  const ws = (await api.workspaces.list())[0];
  const draft = { name: 'p', description: '', method: 'GET', url: `${baseUrl}/x`, headers: [], queryParams: [], pathVariables: [], body: { mode: 'none' }, auth: { type: 'inherit', params: {} },
    scripts: [{ type: 'test', language: 'javascript', enabled: true, source: 'pm.test("n is 7", () => pm.expect(pm.response.json().n).to.equal(7));' }], examples: [], settings: {}, metadata: {} };
  const r = await api.execution.send({ executionId: crypto.randomUUID(), workspaceId: ws.id, draft });
  return { status: r.response?.status, tests: r.tests.map((t) => [t.name, t.passed]), error: r.error?.message, secret: (await api.app.info()).secretStorage };
}, base);
console.log(JSON.stringify(out));
await app.close();
server.close();
rmSync(dir, { recursive: true, force: true });
if (out.status !== 200 || !out.tests.every((t) => t[1])) process.exit(1);
