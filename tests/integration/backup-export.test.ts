import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyRequestDraft } from '@aegis/core';
import { isEncryptedEnvelope } from '@aegis/security';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
let wsId = '';
const SECRET = 'backup-secret-value-42';

beforeAll(async () => {
  t = createTestApp();
  wsId = (await t.api.workspaces.list())[0]!.id;
  const col = await t.api.collections.create({ workspaceId: wsId, name: 'Backed up' });
  const folder = await t.api.folders.create({ collectionId: col.id, parentFolderId: null, name: 'F' });
  await t.api.requests.create({
    collectionId: col.id,
    folderId: folder.id,
    draft: emptyRequestDraft({ name: 'R1', url: '{{baseUrl}}/x', auth: { type: 'bearer', params: { token: SECRET } }, scripts: [{ type: 'test', language: 'javascript', enabled: true, source: 'pm.test("a", () => {})' }] }),
  });
  const env = await t.api.environments.create({ workspaceId: wsId, name: 'Dev' });
  await t.api.variables.set({
    scope: 'environment',
    ownerId: env.id,
    entries: [
      { key: 'baseUrl', initialValue: 'http://x', isSecret: false, enabled: true },
      { key: 'pw', initialValue: SECRET, isSecret: true, enabled: true },
    ],
  });
  await t.api.environments.setActive({ workspaceId: wsId, id: env.id });
  await t.api.variables.set({ scope: 'global', ownerId: wsId, entries: [{ key: 'g', initialValue: 'global-value', isSecret: false, enabled: true }] });
});
afterAll(async () => t.close());

describe('backup & restore', () => {
  it('plain backups contain no secrets and restore into a NEW workspace without touching existing data', async () => {
    const info = (await t.api.importExport.createBackup({ includeHistory: false }))!;
    expect(info.encrypted).toBe(false);
    const text = readFileSync(info.path, 'utf8');
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ format: 'aegis-backup', includesSecrets: false });

    const before = await t.api.collections.list({ workspaceId: wsId });
    const preview = await t.api.importExport.previewContent({ kind: 'backup', fileName: 'b.json', content: text });
    expect(preview.stats.requests).toBe(1);
    const done = await t.api.importExport.commit({ token: preview.token, workspaceId: wsId });
    expect(done.stats.requests).toBe(1);

    const workspaces = await t.api.workspaces.list();
    expect(workspaces.map((w) => w.name)).toContain('Personal (restored)');
    expect(await t.api.collections.list({ workspaceId: wsId })).toHaveLength(before.length); // original untouched
    const restored = workspaces.find((w) => w.name === 'Personal (restored)')!;
    const cols = await t.api.collections.list({ workspaceId: restored.id });
    expect(cols.map((c) => c.name)).toEqual(['Backed up']);
    const tree = await t.api.collections.tree({ collectionId: cols[0]!.id });
    expect(tree.map((n) => n.name).sort()).toEqual(['F', 'R1']);
    const envs = await t.api.environments.list({ workspaceId: restored.id });
    expect(envs[0]).toMatchObject({ name: 'Dev', isActive: true });
    // secrets were intentionally left out of the plain backup
    const restoredVars = await t.api.variables.get({ scope: 'environment', ownerId: envs[0]!.id });
    expect(restoredVars.find((v) => v.key === 'pw')?.initialValue).toBe('');
    expect((await t.api.variables.get({ scope: 'global', ownerId: restored.id }))[0]!.initialValue).toBe('global-value');
  });

  it('passphrase backups are encrypted, include secrets, and need the right passphrase', async () => {
    const info = (await t.api.importExport.createBackup({ includeHistory: true, passphrase: 'correct horse battery' }))!;
    expect(info.encrypted).toBe(true);
    const text = readFileSync(info.path, 'utf8');
    expect(isEncryptedEnvelope(JSON.parse(text))).toBe(true);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('Backed up');

    const preview = await t.api.importExport.previewContent({ kind: 'backup', fileName: 'b.aegisbackup', content: text });
    expect(preview.name).toMatch(/Encrypted backup/);
    await expect(t.api.importExport.commit({ token: preview.token, workspaceId: wsId })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(t.api.importExport.commit({ token: preview.token, workspaceId: wsId, passphrase: 'wrong' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await t.api.importExport.commit({ token: preview.token, workspaceId: wsId, passphrase: 'correct horse battery' });

    const all = await t.api.workspaces.list();
    const restored = all.find((w) => w.name === 'Personal (restored 2)')!;
    const env = (await t.api.environments.list({ workspaceId: restored.id }))[0]!;
    const ref = (await t.api.variables.get({ scope: 'environment', ownerId: env.id })).find((v) => v.key === 'pw')!.initialValue;
    expect(await t.api.variables.revealSecret({ ref })).toBe(SECRET); // secret travelled inside the encrypted backup
    expect((await t.api.importExport.listBackups()).length).toBe(2);
  });

  it('rejects files that are not backups, and restoring is atomic', async () => {
    await expect(t.api.importExport.previewContent({ kind: 'backup', fileName: 'x.json', content: '{"hello":1}' })).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    const before = (await t.api.workspaces.list()).length;
    const bad = JSON.stringify({ format: 'aegis-backup', version: 1, createdAt: 'x', includesHistory: false, includesSecrets: false, settings: {}, workspaces: [{ name: 'Broken', description: '', collections: [{ name: 'c', items: 5 }], environments: [], globals: [] }] });
    const preview = await t.api.importExport.previewContent({ kind: 'backup', fileName: 'x.json', content: bad }).catch((e) => e);
    if ('token' in preview) await expect(t.api.importExport.commit({ token: preview.token, workspaceId: wsId })).rejects.toBeTruthy();
    expect((await t.api.workspaces.list()).length).toBe(before); // nothing half-restored
  });
});

describe('exports', () => {
  it('collection export with secrets is explicit, audited, and contains the secret only then', async () => {
    const col = (await t.api.collections.list({ workspaceId: wsId }))[0]!;
    t.nextSave.path = path.join(t.dir, 'with-secrets.json');
    await t.api.importExport.exportCollection({ collectionId: col.id, includeSecrets: true });
    expect(readFileSync(t.nextSave.path, 'utf8')).toContain(SECRET);
    t.nextSave.path = path.join(t.dir, 'without.json');
    await t.api.importExport.exportCollection({ collectionId: col.id, includeSecrets: false });
    expect(readFileSync(t.nextSave.path, 'utf8')).not.toContain(SECRET);
    const audit = await t.api.audit.list({ action: 'EXPORT_SECRETS' });
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it('environment export keeps secrets out by default', async () => {
    const env = (await t.api.environments.list({ workspaceId: wsId }))[0]!;
    t.nextSave.path = path.join(t.dir, 'env.json');
    await t.api.importExport.exportEnvironment({ environmentId: env.id, includeSecrets: false });
    const json = JSON.parse(readFileSync(t.nextSave.path, 'utf8'));
    expect(json.values.find((v: { key: string }) => v.key === 'pw')).toMatchObject({ value: '', type: 'secret' });
    expect(json.values.find((v: { key: string }) => v.key === 'baseUrl').value).toBe('http://x');
  });

  it('workspace export writes collections, environments and globals', async () => {
    t.nextSave.path = path.join(t.dir, 'workspace.json');
    await t.api.workspaces.export({ id: wsId, includeSecrets: false });
    const json = JSON.parse(readFileSync(t.nextSave.path, 'utf8'));
    expect(json).toMatchObject({ format: 'aegis-workspace' });
    expect(json.collections).toHaveLength(1);
    expect(json.environments).toHaveLength(1);
    expect(JSON.stringify(json)).not.toContain(SECRET);
  });

  it('the last workspace cannot be deleted; deleting one removes its data and secrets', async () => {
    const extra = await t.api.workspaces.create({ name: 'Disposable' });
    const col = await t.api.collections.create({ workspaceId: extra.id, name: 'tmp' });
    const req = await t.api.requests.create({ collectionId: col.id, folderId: null, draft: emptyRequestDraft({ auth: { type: 'bearer', params: { token: 'tmp-secret-token' } } }) });
    expect(t.app.ctx.storage.secrets.getSync(`auth:${req.id}:token`)).toBe('tmp-secret-token');
    await t.api.workspaces.delete({ id: extra.id });
    expect(t.app.ctx.storage.secrets.getSync(`auth:${req.id}:token`)).toBeNull();
    const rest = await t.api.workspaces.list();
    for (const w of rest.slice(1)) await t.api.workspaces.delete({ id: w.id });
    await expect(t.api.workspaces.delete({ id: rest[0]!.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
