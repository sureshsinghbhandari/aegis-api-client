import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyRequestDraft } from '@aegis/core';
import { createTestApp, type TestApp } from '../helpers/app';

const OPENAPI = path.resolve(__dirname, '../fixtures/openapi');
const POSTMAN = path.resolve(__dirname, '../fixtures/postman');
const SECRET = 'workspace-secret-value-77';

let t: TestApp;
let wsId = '';

beforeAll(async () => {
  t = createTestApp();
  wsId = (await t.api.workspaces.list())[0]!.id;
  const col = await t.api.collections.create({ workspaceId: wsId, name: 'Exported col' });
  const folder = await t.api.folders.create({ collectionId: col.id, parentFolderId: null, name: 'F' });
  await t.api.requests.create({ collectionId: col.id, folderId: folder.id, draft: emptyRequestDraft({ name: 'R1', url: '{{baseUrl}}/x', auth: { type: 'bearer', params: { token: SECRET } } }) });
  await t.api.variables.set({ scope: 'collection', ownerId: col.id, entries: [{ key: 'baseUrl', initialValue: 'http://x', isSecret: false, enabled: true }] });
  const env = await t.api.environments.create({ workspaceId: wsId, name: 'Dev' });
  await t.api.variables.set({ scope: 'environment', ownerId: env.id, entries: [{ key: 'pw', initialValue: SECRET, isSecret: true, enabled: true }, { key: 'host', initialValue: 'h', isSecret: false, enabled: true }] });
  await t.api.variables.set({ scope: 'global', ownerId: wsId, entries: [{ key: 'g', initialValue: 'global-value', isSecret: false, enabled: true }] });
});
afterAll(async () => t.close());

describe('Aegis workspace file round trip (finding #1)', () => {
  it('a workspace export can be previewed and imported again as a new workspace', async () => {
    t.nextSave.path = path.join(t.dir, 'ws.aegis-workspace.json');
    await t.api.workspaces.export({ id: wsId, includeSecrets: false });
    const text = readFileSync(t.nextSave.path, 'utf8');
    expect(text).not.toContain(SECRET);

    for (const kind of ['aegis-workspace', 'auto'] as const) {
      const preview = await t.api.importExport.previewContent({ kind, fileName: 'ws.aegis-workspace.json', content: text });
      expect(preview.kind).toBe('aegis-workspace');
      expect(preview.collections).toBe(1);
      expect(preview.environments).toBe(1);
      expect(preview.stats).toMatchObject({ folders: 1, requests: 1 });
      expect(preview.name).toMatch(/^Personal \(1 collection, 1 environment\)/);
      await t.api.importExport.discard({ token: preview.token });
    }

    const before = (await t.api.workspaces.list()).length;
    const preview = await t.api.importExport.previewContent({ kind: 'auto', fileName: 'ws.aegis-workspace.json', content: text });
    const done = await t.api.importExport.commit({ token: preview.token, workspaceId: wsId });
    expect(done.kind).toBe('aegis-workspace');
    expect(done.collectionId).toBeTruthy();
    const workspaces = await t.api.workspaces.list();
    expect(workspaces.length).toBe(before + 1);
    const restored = workspaces.find((w) => w.name === 'Personal (imported)')!;
    expect(restored).toBeTruthy();
    const cols = await t.api.collections.list({ workspaceId: restored.id });
    expect(cols.map((c) => c.name)).toEqual(['Exported col']);
    expect((await t.api.collections.tree({ collectionId: cols[0]!.id })).map((n) => n.name).sort()).toEqual(['F', 'R1']);
    expect((await t.api.variables.get({ scope: 'collection', ownerId: cols[0]!.id }))[0]).toMatchObject({ key: 'baseUrl', initialValue: 'http://x' });
    const envs = await t.api.environments.list({ workspaceId: restored.id });
    expect(envs.map((e) => e.name)).toEqual(['Dev']);
    const envVars = await t.api.variables.get({ scope: 'environment', ownerId: envs[0]!.id });
    expect(envVars.find((v) => v.key === 'pw')).toMatchObject({ isSecret: true, initialValue: '' }); // secrets were not in the file
    expect((await t.api.variables.get({ scope: 'global', ownerId: restored.id }))[0]).toMatchObject({ key: 'g', initialValue: 'global-value' });
    // the original workspace is untouched
    expect(await t.api.collections.list({ workspaceId: wsId })).toHaveLength(1);
  });

  it('the backup restore refuses a workspace file with a pointer to the right importer', async () => {
    const text = readFileSync(path.join(t.dir, 'ws.aegis-workspace.json'), 'utf8');
    await expect(t.api.importExport.previewContent({ kind: 'backup', fileName: 'ws.json', content: text })).rejects.toMatchObject({ code: 'IMPORT_INVALID', message: expect.stringMatching(/workspace file/) });
    await expect(t.api.importExport.previewContent({ kind: 'auto', fileName: 'b.json', content: '{"format":"aegis-backup","version":1,"workspaces":[]}' })).rejects.toMatchObject({ code: 'IMPORT_INVALID', message: expect.stringMatching(/backup/) });
  });
});

describe('OpenAPI / Swagger through the service', () => {
  it('imports an OpenAPI YAML file into the current workspace with collection auth and variables', async () => {
    const content = readFileSync(path.join(OPENAPI, 'petstore-3.1.yaml'), 'utf8');
    const preview = await t.api.importExport.previewContent({ kind: 'openapi', fileName: 'petstore-3.1.yaml', content });
    expect(preview.kind).toBe('openapi');
    expect(preview.schemaVersion).toBe('3.1.0');
    expect(preview.stats.requests).toBe(3);
    expect(preview.warningCounts.ERROR).toBe(0);
    const done = await t.api.importExport.commit({ token: preview.token, workspaceId: wsId });
    const col = await t.api.collections.get({ id: done.collectionId! });
    expect(col.name).toBe('Petstore 3.1');
    expect(col.auth.type).toBe('bearer');
    const vars = await t.api.variables.get({ scope: 'collection', ownerId: col.id });
    expect(vars.find((v) => v.key === 'baseUrl')!.initialValue).toBe('https://api.petstore.example/v2');
    expect(vars.find((v) => v.key === 'bearerToken')!.isSecret).toBe(true);
    const tree = await t.api.collections.tree({ collectionId: col.id });
    expect(tree.filter((n) => n.kind === 'folder').map((n) => n.name)).toEqual(['pets']);
    const req = await t.api.requests.get({ id: tree.find((n) => n.name === 'Create a pet')!.id });
    expect(req.body.mode).toBe('raw');
    expect(JSON.parse(req.body.raw!)).toMatchObject({ name: 'Fluffy' });
    const audit = await t.api.audit.list({ action: 'IMPORT_COLLECTION' });
    expect(audit.some((a) => a.details.source === 'openapi')).toBe(true);
  });

  it('auto-detects Swagger 2.0 and refuses it under the wrong explicit kind', async () => {
    const content = readFileSync(path.join(OPENAPI, 'swagger-2.0.json'), 'utf8');
    const preview = await t.api.importExport.previewContent({ kind: 'auto', fileName: 'swagger.json', content });
    expect(preview.kind).toBe('swagger');
    expect(preview.schemaVersion).toBe('2.0');
    await t.api.importExport.discard({ token: preview.token });
    await expect(t.api.importExport.previewContent({ kind: 'har', fileName: 'swagger.json', content })).rejects.toMatchObject({ code: 'IMPORT_INVALID', message: expect.stringMatching(/Swagger 2.0, not HAR/) });
    await expect(t.api.importExport.previewContent({ kind: 'postman-collection', fileName: 'swagger.json', content })).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
  });

  it('auto-detect still handles Postman collections, environments and globals', async () => {
    const col = await t.api.importExport.previewContent({ kind: 'auto', fileName: 'k.json', content: readFileSync(path.join(POSTMAN, 'kitchen-sink.json'), 'utf8') });
    expect(col.kind).toBe('postman-collection');
    expect(col.schemaVersion).toBe('2.1.0');
    await t.api.importExport.discard({ token: col.token });
    const env = await t.api.importExport.previewContent({ kind: 'auto', fileName: 'e.json', content: readFileSync(path.join(POSTMAN, 'environment-basic.json'), 'utf8') });
    expect(env.kind).toBe('postman-environment');
    const envDone = await t.api.importExport.commit({ token: env.token, workspaceId: wsId });
    expect(envDone.environmentId).toBeTruthy();
    const globals = await t.api.importExport.previewContent({ kind: 'auto', fileName: 'g.json', content: readFileSync(path.join(POSTMAN, 'globals-basic.json'), 'utf8') });
    expect(globals.kind).toBe('postman-globals');
    await t.api.importExport.commit({ token: globals.token, workspaceId: wsId });
    expect((await t.api.variables.get({ scope: 'global', ownerId: wsId })).some((v) => v.key === 'g')).toBe(true); // merged, not replaced
  });

  it('rejects unknown and oversized content and keeps the failed job for diagnostics', async () => {
    await expect(t.api.importExport.previewContent({ kind: 'auto', fileName: 'x.txt', content: 'hello world' })).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    await expect(t.api.importExport.previewContent({ kind: 'openapi', fileName: 'x.json', content: '{"openapi":"3.0.0"}' })).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    const jobs = t.app.ctx.storage.repos.imports.listJobs();
    expect(jobs.some((j) => j.status === 'failed' && j.sourceType === 'openapi')).toBe(true);
  });

  it('a commit that fails inside the transaction leaves nothing behind', async () => {
    const content = readFileSync(path.join(OPENAPI, 'recursive-refs.json'), 'utf8');
    const preview = await t.api.importExport.previewContent({ kind: 'openapi', fileName: 'r.json', content });
    const before = (await t.api.collections.list({ workspaceId: wsId })).length;
    await expect(t.api.importExport.commit({ token: preview.token, workspaceId: 'does-not-exist' })).rejects.toBeTruthy();
    expect((await t.api.collections.list({ workspaceId: wsId })).length).toBe(before);
    await t.api.importExport.discard({ token: preview.token });
  });
});

describe('backup history limit (finding #11)', () => {
  it('includes the newest N history rows per workspace, documented in the file', async () => {
    const r = t.app.ctx.storage.repos;
    for (let i = 0; i < 12; i++) r.history.add({ workspaceId: wsId, method: 'GET', url: `http://h/${i}`, statusCode: 200, statusText: 'OK', errorCode: null, durationMs: 1, requestSize: 0, responseSize: 0, requestName: `h${i}`, environmentName: null, environmentId: null, requestId: null, createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(), requestSnapshot: null });
    const info = (await t.api.importExport.createBackup({ includeHistory: true, historyLimit: 5 }))!;
    const json = JSON.parse(readFileSync(info.path, 'utf8')) as { historyLimit: number; workspaces: Array<{ name: string; history: Array<{ requestName: string }> }> };
    expect(json.historyLimit).toBe(5);
    const personal = json.workspaces.find((w) => w.name === 'Personal')!;
    expect(personal.history).toHaveLength(5);
    expect(personal.history.map((h) => h.requestName)).toEqual(['h11', 'h10', 'h9', 'h8', 'h7']); // newest first
    const all = (await t.api.importExport.createBackup({ includeHistory: true, historyLimit: 100_000 }))!;
    expect(JSON.parse(readFileSync(all.path, 'utf8')).workspaces.find((w: { name: string }) => w.name === 'Personal').history.length).toBe(12);
    const none = (await t.api.importExport.createBackup({ includeHistory: false }))!;
    expect(JSON.parse(readFileSync(none.path, 'utf8')).historyLimit).toBeUndefined();
  });
});
