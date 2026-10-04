import { describe, expect, it } from 'vitest';
import { emptyRequestDraft, type CollectionBundle } from '@aegis/core';
import { createTestStorage } from '../helpers/storage';

function sampleBundle(): CollectionBundle {
  return {
    name: 'Sample',
    description: 'd',
    variables: [
      { key: 'baseUrl', initialValue: 'https://api.example.com', isSecret: false, enabled: true },
      { key: 'apiToken', initialValue: 'tok-super-secret-123', isSecret: true, enabled: true },
    ],
    auth: { type: 'bearer', params: { token: 'collection-token-literal' } },
    scripts: [{ type: 'prerequest', language: 'javascript', source: 'pm.variables.set("a",1)', enabled: true }],
    sourceMetadata: { info: { version: '1' } },
    items: [
      {
        kind: 'folder',
        name: 'Users',
        description: '',
        auth: { type: 'inherit', params: {} },
        scripts: [],
        variables: [{ key: 'folderVar', initialValue: 'f', isSecret: false, enabled: true }],
        metadata: {},
        items: [
          {
            kind: 'request',
            request: emptyRequestDraft({
              name: 'List',
              url: '{{baseUrl}}/users',
              headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
              queryParams: [
                { key: 'page', value: '1', enabled: true },
                { key: 'debug', value: 'true', enabled: false },
              ],
              auth: { type: 'basic', params: { username: 'u', password: 'p4ssw0rd-literal' } },
            }),
          },
        ],
      },
      { kind: 'request', request: emptyRequestDraft({ name: 'Root', method: 'POST', url: '{{baseUrl}}/x', body: { mode: 'raw', raw: '{"a":1}', rawLanguage: 'json' } }) },
    ],
  };
}

describe('storage repositories', () => {
  it('inserts a bundle and loads it back identically (secrets resolved)', () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('Personal');
    const bundle = sampleBundle();
    const { collectionId, stats } = storage.repos.collections.insertBundle(ws.id, bundle);
    expect(stats).toMatchObject({ folders: 1, requests: 2, variables: 3, scripts: 1 });

    const loaded = storage.repos.collections.loadBundle(collectionId, 'resolve');
    expect(loaded.items).toHaveLength(2);
    expect(loaded.items[0]).toMatchObject({ kind: 'folder', name: 'Users' });
    expect(loaded.items[1]).toMatchObject({ kind: 'request', request: { name: 'Root', method: 'POST' } });
    expect(loaded.auth).toEqual(bundle.auth);
    expect(loaded.variables.map((v) => [v.key, v.initialValue])).toEqual([
      ['baseUrl', 'https://api.example.com'],
      ['apiToken', 'tok-super-secret-123'],
    ]);
    const list = (loaded.items[0] as { items: Array<{ request: { auth: unknown; queryParams: unknown[] } }> }).items[0]!.request;
    expect(list.auth).toEqual({ type: 'basic', params: { username: 'u', password: 'p4ssw0rd-literal' } });
    expect(list.queryParams).toHaveLength(2);
    storage.close();
  });

  it('never persists secrets as plaintext and masks them for the UI', () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('Personal');
    const { collectionId } = storage.repos.collections.insertBundle(ws.id, sampleBundle());
    const native = storage.opened.client.native;

    const dump = JSON.stringify([
      native.prepare('select * from collections').all(),
      native.prepare('select * from request_auth').all(),
      native.prepare('select * from collection_variables').all(),
    ]);
    for (const secret of ['tok-super-secret-123', 'collection-token-literal', 'p4ssw0rd-literal']) {
      expect(dump).not.toContain(secret);
    }
    const blobs = JSON.stringify(native.prepare('select key, hex(blob) as b from secrets').all());
    expect(blobs).not.toContain(Buffer.from('tok-super-secret-123').toString('hex'));

    // UI view: references only
    const ui = storage.repos.collections.loadBundle(collectionId, 'refs');
    expect(JSON.stringify(ui)).not.toContain('tok-super-secret-123');
    expect(ui.auth.params.token).toMatch(/^secretref:/);
    // export without secrets: blanked
    const blank = storage.repos.collections.loadBundle(collectionId, 'blank');
    expect(blank.auth.params.token).toBe('');
    expect(blank.variables.find((v) => v.key === 'apiToken')?.initialValue).toBe('');
    storage.close();
  });

  it('keeps variable references in auth un-sealed and re-saving a secret ref keeps its value', () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('P');
    const col = storage.repos.collections.createCollection(ws.id, { name: 'C' });
    const req = storage.repos.collections.createRequest(col.id, null, emptyRequestDraft({ name: 'R', auth: { type: 'bearer', params: { token: '{{token}}' } } }));
    expect(req.auth.params.token).toBe('{{token}}');
    const req2 = storage.repos.collections.updateRequest(req.id, { ...req, auth: { type: 'bearer', params: { token: 'literal-1' } } });
    expect(req2.auth.params.token).toMatch(/^secretref:/);
    // UI saves the same reference back unchanged
    const req3 = storage.repos.collections.updateRequest(req.id, { ...req2, name: 'R2' });
    expect(storage.repos.collections.requireRequest(req3.id, 'resolve').auth.params.token).toBe('literal-1');
    storage.repos.collections.deleteRequest(req.id);
    expect(storage.secrets.getSync(`auth:${req.id}:token`)).toBeNull();
    storage.close();
  });

  it('rolls back a failed import transaction including secrets', () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('P');
    expect(() =>
      storage.transaction((repos) => {
        repos.collections.insertBundle(ws.id, sampleBundle());
        throw new Error('fail midway');
      }),
    ).toThrow('fail midway');
    expect(storage.repos.collections.listCollections(ws.id)).toHaveLength(0);
    const native = storage.opened.client.native;
    expect((native.prepare('select count(*) as n from requests').get() as { n: number }).n).toBe(0);
    expect((native.prepare('select count(*) as n from secrets').get() as { n: number }).n).toBe(0);
    storage.close();
  });

  it('supports folders, moves, ordering, duplicate and cascade delete', () => {
    const storage = createTestStorage();
    const { collections: repo } = storage.repos;
    const ws = storage.repos.workspaces.create('P');
    const col = repo.createCollection(ws.id, { name: 'C' });
    const f1 = repo.createFolder(col.id, null, { name: 'A' });
    const f2 = repo.createFolder(col.id, f1.id, { name: 'B' });
    const r1 = repo.createRequest(col.id, f2.id, emptyRequestDraft({ name: 'one' }));
    const r2 = repo.createRequest(col.id, null, emptyRequestDraft({ name: 'two' }));
    expect(repo.getFolderChain(f2.id).map((f) => f.name)).toEqual(['B', 'A']);

    repo.move('request', r2.id, f1.id, 0);
    const rows = repo.getTreeRows(col.id);
    expect(rows.find((r) => r.id === r2.id)?.parentId).toBe(f1.id);
    expect(() => repo.move('folder', f1.id, f2.id, 0)).toThrow(/itself or its descendants/);

    const dupId = repo.duplicateCollection(col.id);
    expect(repo.listRequests(dupId)).toHaveLength(2);
    expect(repo.getCollection(dupId)?.uid).not.toBe(col.uid);

    repo.deleteFolder(f1.id);
    expect(repo.getRequest(r1.id)).toBeNull();
    expect(repo.getRequest(r2.id)).toBeNull();
    storage.close();
  });

  it('handles 2,000 requests quickly and searches them', () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('P');
    const items = Array.from({ length: 20 }, (_, f) => ({
      kind: 'folder' as const,
      name: `Folder ${f}`,
      description: '',
      auth: { type: 'inherit' as const, params: {} },
      scripts: [],
      variables: [],
      metadata: {},
      items: Array.from({ length: 100 }, (_, i) => ({ kind: 'request' as const, request: emptyRequestDraft({ name: `Req ${f}-${i}`, url: `https://x.test/${f}/${i}` }) })),
    }));
    const t0 = Date.now();
    const { collectionId } = storage.transaction((r) => r.collections.insertBundle(ws.id, { ...sampleBundle(), items }));
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(storage.repos.collections.getTreeRows(collectionId)).toHaveLength(2020);
    const hits = storage.repos.collections.search(ws.id, 'Req 7-4');
    expect(hits.some((h) => h.name === 'Req 7-4')).toBe(true);
    // LIKE wildcards in the term are escaped
    expect(storage.repos.collections.search(ws.id, '%')).toHaveLength(0);
    storage.close();
  });

  it('environments: secret variables masked, runtime values, activation', () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('P');
    const env = storage.repos.environments.create(ws.id, { name: 'Dev' }, [
      { key: 'baseUrl', initialValue: 'http://x', isSecret: false, enabled: true },
      { key: 'password', initialValue: 'pw-123', isSecret: true, enabled: true },
    ]);
    const shown = storage.repos.environments.variables(env.id);
    expect(shown[1]!.initialValue).toMatch(/^secretref:/);
    expect(storage.repos.environments.variables(env.id, 'resolve')[1]!.initialValue).toBe('pw-123');
    // saving the masked entries back keeps the secret
    storage.repos.environments.setVariables(env.id, shown);
    expect(storage.repos.environments.variables(env.id, 'resolve')[1]!.initialValue).toBe('pw-123');
    // runtime update from scripts
    storage.repos.vars.environment.setCurrentValues(env.id, { set: { token: 't1', baseUrl: 'http://y' }, unset: [], cleared: false });
    const resolved = storage.repos.environments.variables(env.id, 'resolve');
    expect(resolved.find((v) => v.key === 'baseUrl')?.currentValue).toBe('http://y');
    expect(resolved.find((v) => v.key === 'token')?.currentValue).toBe('t1');
    storage.repos.environments.setActive(ws.id, env.id);
    expect(storage.repos.environments.getActive(ws.id)?.id).toBe(env.id);
    storage.repos.environments.delete(env.id);
    expect(storage.repos.environments.list(ws.id)).toHaveLength(0);
    storage.close();
  });

  it('history: pagination, filters and retention', () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('P');
    const h = storage.repos.history;
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    for (let i = 0; i < 120; i++) {
      h.add({
        workspaceId: ws.id,
        method: i % 2 ? 'GET' : 'POST',
        url: `https://a.test/${i}`,
        statusCode: i % 3 === 0 ? 500 : 200,
        durationMs: i,
        createdAt: i < 10 ? old : new Date().toISOString(),
      });
    }
    const page = h.search({ workspaceId: ws.id, limit: 50 });
    expect(page.items).toHaveLength(50);
    expect(page.total).toBe(120);
    expect(h.search({ workspaceId: ws.id, method: 'post' }).total).toBe(60);
    expect(h.search({ workspaceId: ws.id, status: '5xx' }).total).toBe(40);
    expect(h.search({ workspaceId: ws.id, text: 'a.test/11' }).total).toBeGreaterThan(0);
    expect(h.prune('30d')).toBe(10);
    expect(h.prune('unlimited')).toBe(0);
    expect(h.clear(ws.id)).toBe(110);
    storage.close();
  });
});
