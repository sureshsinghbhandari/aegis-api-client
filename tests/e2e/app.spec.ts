import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end tests: drive the BUILT Electron app (run `npm run build` first; `npm run test:e2e` does).
 * Setup data is created through the app's own IPC bridge (window.api); the request/response flow,
 * shortcuts, dialogs and panels are exercised through the real UI.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const SHOTS = path.join(ROOT, 'test-results', 'e2e-screenshots');

let app: ElectronApplication;
let win: Page;
let server: http.Server;
let base = '';
let userData = '';
let workspaceId = '';
let collectionId = '';
let environmentId = '';

/** Run `body` in the renderer with the (untyped) bridge. */
function inApp<A>(body: (api: any, arg: A) => Promise<any>, arg: A): Promise<any> {
  return win.evaluate(`(async () => (${body.toString()})(window.api, ${JSON.stringify(arg)}))()`);
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Server', 'e2e');
      res.end(JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, token: 'abc-from-server' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userData = mkdtempSync(path.join(os.tmpdir(), 'aegis-e2e-'));
  app = await electron.launch({ args: ['.'], cwd: ROOT, env: { ...process.env, AEGIS_USER_DATA_DIR: userData } });
  win = await app.firstWindow();
  await win.waitForSelector('.app', { timeout: 30_000 });
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(userData, { recursive: true, force: true });
});

test('launches securely: only window.api is exposed, no Node in the renderer', async () => {
  expect(await win.title()).toBe('Aegis API Client');
  const leaked = await win.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return { require: typeof w.require, process: typeof w.process, ipc: typeof w.ipcRenderer, api: typeof w.api };
  });
  expect(leaked).toEqual({ require: 'undefined', process: 'undefined', ipc: 'undefined', api: 'object' });
  const err = await inApp((api) => api.requests.get({ id: 123 }).then(() => 'ok', (e: Error) => e.message), null);
  expect(err).toContain('IPC_INVALID_ARGUMENT'); // arguments are validated in the main process
  await win.screenshot({ path: path.join(SHOTS, '01-launch.png') });
});

test('workspace, collection, folder, environment with a secret token', async () => {
  workspaceId = (await inApp((api) => api.workspaces.list(), null))[0].id;
  collectionId = (await inApp((api, ws) => api.collections.create({ workspaceId: ws, name: 'Users API' }), workspaceId)).id;
  await inApp((api, cid) => api.folders.create({ collectionId: cid, parentFolderId: null, name: 'Users' }), collectionId);
  environmentId = (await inApp((api, ws) => api.environments.create({ workspaceId: ws, name: 'Development' }), workspaceId)).id;
  await inApp(
    async (api, a: { env: string; ws: string; base: string }) => {
      await api.variables.set({
        scope: 'environment',
        ownerId: a.env,
        entries: [
          { key: 'baseUrl', initialValue: a.base, isSecret: false, enabled: true },
          { key: 'token', initialValue: 'e2e-secret-token', isSecret: true, enabled: true },
        ],
      });
      await api.environments.setActive({ workspaceId: a.ws, id: a.env });
    },
    { env: environmentId, ws: workspaceId, base },
  );
  await win.reload();
  await win.waitForSelector('.app');
  await expect(win.locator('.topbar')).toContainText('Development');
  await expect(win.getByText('Users API').first()).toBeVisible();
  await win.screenshot({ path: path.join(SHOTS, '02-workspace.png') });
});

test('send from the UI: resolved variables, status/time/size/headers, save, close, reopen, history', async () => {
  await win.keyboard.press('Control+t'); // new request tab
  const url = win.getByLabel('Request URL');
  await expect(url).toBeVisible();
  await url.fill('{{baseUrl}}/users?page=1');
  await win.getByRole('tab', { name: /^Headers/ }).click();
  await win.getByPlaceholder('Header').first().fill('Authorization');
  await win.getByPlaceholder('Value').first().fill('Bearer {{token}}');

  await win.keyboard.press('Control+Enter');
  await expect(win.locator('.rv-status')).toContainText('200 OK', { timeout: 20_000 });
  await expect(win.locator('.rv-status')).toContainText(/\d+(\.\d+)?\s?(ms|s)/);
  await expect(win.locator('.rv-status')).toContainText(/\d+(\.\d+)?\s?(B|KB|MB)/);
  await win.locator('.rv-status').locator('xpath=ancestor::*[contains(@class,"rv") or self::section][1]').getByRole('tab', { name: /^Headers/ }).click().catch(async () => {
    await win.getByRole('tab', { name: /^Headers/ }).last().click();
  });
  await expect(win.getByText('x-server').first()).toBeVisible();
  await win.getByRole('tab', { name: /^Timeline/ }).click();
  await expect(win.locator('body')).not.toContainText('e2e-secret-token'); // secret masked in every UI surface
  await win.screenshot({ path: path.join(SHOTS, '03-response.png') });

  // history recorded with the redacted URL and status
  const history = await inApp((api, ws) => api.history.search({ workspaceId: ws }), workspaceId);
  expect(history.total).toBeGreaterThanOrEqual(1);
  expect(history.items[0].statusCode).toBe(200);
  expect(history.items[0].url).toBe(`${base}/users?page=1`);

  // save into the collection, close, reopen: variables still stored (unresolved) in the request
  await win.getByLabel('Request name').fill('List users');
  await win.keyboard.press('Control+s');
  await expect(win.getByText('Saved').first()).toBeVisible();
  const tree = await inApp((api, cid) => api.collections.tree({ collectionId: cid }), collectionId);
  expect(tree.some((n: { kind: string; name: string }) => n.kind === 'request' && n.name === 'List users')).toBe(true);
  await win.keyboard.press('Control+w');
  await expect(win.getByLabel('Request URL')).toHaveCount(0);
  await win.keyboard.press('Control+Shift+t');
  await expect(win.getByLabel('Request URL')).toHaveValue('{{baseUrl}}/users?page=1');

  await win.getByRole('tab', { name: 'History' }).click();
  await expect(win.getByText(`${base}/users?page=1`).first()).toBeVisible();
  await win.screenshot({ path: path.join(SHOTS, '04-history.png') });
  await win.getByRole('tab', { name: 'Collections' }).click();
});

test('scripts: tests run, an environment variable is set from the response, results are shown', async () => {
  await win.keyboard.press('Control+t');
  await win.getByLabel('Request URL').fill('{{baseUrl}}/login');
  await win.getByRole('tab', { name: /^Tests/ }).click();
  const editor = win.locator('.monaco-editor').first();
  await editor.waitFor({ timeout: 30_000 });
  await editor.click();
  await win.keyboard.type('pm.test("Status is 200", () => pm.response.to.have.status(200));');
  await win.keyboard.press('Enter');
  await win.keyboard.type('pm.environment.set("userToken", pm.response.json().token);');
  await win.keyboard.press('Control+Enter');
  await expect(win.locator('.rv-status')).toContainText('200 OK', { timeout: 20_000 });
  await win.getByRole('tab', { name: /^Test Results/ }).click();
  await expect(win.getByText('Status is 200').first()).toBeVisible();
  const vars = await inApp((api, env) => api.variables.get({ scope: 'environment', ownerId: env }), environmentId);
  expect(vars.find((v: { key: string }) => v.key === 'userToken')?.currentValue).toBe('abc-from-server');
  await win.screenshot({ path: path.join(SHOTS, '05-tests.png') });
});

test('import a Postman collection through the bridge, then run it with the collection runner', async () => {
  const collection = {
    info: { name: 'Imported API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Ping', event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] } }], request: { method: 'GET', url: { raw: '{{baseUrl}}/ping' } } }],
  };
  const done = await inApp(
    async (api, a: { ws: string; content: string }) => {
      const preview = await api.importExport.previewContent({ kind: 'postman-collection', fileName: 'imported.json', content: a.content });
      return api.importExport.commit({ token: preview.token, workspaceId: a.ws });
    },
    { ws: workspaceId, content: JSON.stringify(collection) },
  );
  expect(done.stats.requests).toBe(1);
  await win.reload();
  await win.waitForSelector('.app');
  await expect(win.getByText('Imported API').first()).toBeVisible();
  const { runId } = await inApp((api, a: { ws: string; cid: string }) => api.runner.start({ workspaceId: a.ws, collectionId: a.cid, iterations: 1, delayMs: 0, stopOnFailure: false }), {
    ws: workspaceId,
    cid: done.collectionId,
  });
  await expect
    .poll(async () => (await inApp((api, id) => api.runner.items({ runId: id }), runId)).length, { timeout: 20_000 })
    .toBe(1);
  const items = await inApp((api, id) => api.runner.items({ runId: id }), runId);
  expect(items[0]).toMatchObject({ name: 'Ping', statusCode: 200, passed: true });
});

test('production environment shows a banner and requires confirmation before sending', async () => {
  await inApp((api, env) => api.environments.update({ id: env, isProduction: true }), environmentId);
  await win.reload();
  await win.waitForSelector('.app');
  await expect(win.locator('.prod-banner')).toContainText('ENVIRONMENT: PRODUCTION');
  await win.keyboard.press('Control+t');
  await win.getByLabel('Request URL').fill('{{baseUrl}}/prod-check');
  await win.keyboard.press('Control+Enter');
  const dialog = win.getByRole('dialog', { name: 'Production environment' });
  await expect(dialog).toBeVisible();
  await win.screenshot({ path: path.join(SHOTS, '06-production-confirm.png') });
  await dialog.getByRole('button', { name: /Send anyway|Yes, continue/ }).click();
  await expect(win.locator('.rv-status')).toContainText('200 OK', { timeout: 20_000 });
  await inApp((api, env) => api.environments.update({ id: env, isProduction: false }), environmentId);
});

test('theme switch and settings dialog', async () => {
  const before = await win.evaluate(() => document.documentElement.dataset.theme);
  await win.getByRole('button', { name: /Switch to (light|dark) theme/ }).click();
  await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).not.toBe(before);
  await win.screenshot({ path: path.join(SHOTS, '07-theme.png') });
  await win.getByRole('button', { name: /Settings/ }).first().click();
  await expect(win.getByRole('dialog', { name: /Settings/ })).toBeVisible();
  await win.screenshot({ path: path.join(SHOTS, '08-settings.png') });
  await win.keyboard.press('Escape');
});
