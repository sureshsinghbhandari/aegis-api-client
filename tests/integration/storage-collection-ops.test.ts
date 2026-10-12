import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIND_REPLACE_SCOPES, emptyRequestDraft } from '@aegis/core';
import type { Storage } from '@aegis/storage';
import { createReplacer } from '../../packages/app/src/services/find-replace';
import { createTestApp, type TestApp } from '../helpers/app';
import { createTestStorage } from '../helpers/storage';

const OLD = 'api.old.test';
const NEW = 'api.new.test';

/** A collection with matches on every level, plus secrets that contain the search text. */
function seed(storage: Storage) {
  const repo = storage.repos.collections;
  const ws = storage.repos.workspaces.create('P');
  const col = repo.createCollection(ws.id, {
    name: 'Shop',
    description: `Uses ${OLD}`,
    scripts: [{ type: 'prerequest', language: 'javascript', source: `pm.variables.set("host", "${OLD}")`, enabled: true }],
    auth: { type: 'bearer', params: { token: `${OLD}-collection-token` } },
  });
  storage.repos.vars.collection.replaceAll(col.id, [
    { key: 'base', initialValue: `https://${OLD}`, isSecret: false, enabled: true },
    { key: 'token', initialValue: `${OLD}-secret-var`, isSecret: true, enabled: true },
  ]);
  const folder = repo.createFolder(col.id, null, { name: 'Users', description: `folder ${OLD}`, auth: { type: 'bearer', params: { token: 'folder-token-literal' } } });
  storage.repos.vars.folder.replaceAll(folder.id, [
    { key: 'fv', initialValue: `${OLD}/v1`, isSecret: false, enabled: true },
    { key: 'fsecret', initialValue: `${OLD}-folder-secret`, isSecret: true, enabled: true },
  ]);
  const sub = repo.createFolder(col.id, folder.id, { name: 'Admin' });
  const r1 = repo.createRequest(
    col.id,
    folder.id,
    emptyRequestDraft({
      name: 'List',
      description: `desc ${OLD}`,
      url: `https://${OLD}/users`,
      headers: [{ key: 'Host', value: OLD, enabled: true }],
      queryParams: [{ key: 'q', value: OLD, enabled: true }],
      body: { mode: 'raw', raw: `{"url":"${OLD}"}`, rawLanguage: 'json' },
      auth: { type: 'basic', params: { username: OLD, password: `${OLD}-password` } },
      scripts: [{ type: 'test', language: 'javascript', source: `// ${OLD}`, enabled: true }],
      examples: [{ name: 'ok', status: 'OK', code: 200, headers: [], body: '{}' }],
    }),
  );
  const r2 = repo.createRequest(col.id, sub.id, emptyRequestDraft({ name: 'Deep', url: `https://${OLD}/admin` }));
  const r3 = repo.createRequest(col.id, null, emptyRequestDraft({ name: 'Root', url: 'https://other.test' }));
  return { repo, ws, col, folder, sub, r1, r2, r3 };
}

const allScopes = [...FIND_REPLACE_SCOPES];

describe('duplicateFolder', () => {
  it('deep-copies sub-folders, requests, scripts, variables and examples with secrets re-vaulted under the new owners', () => {
    const storage = createTestStorage();
    const { repo, col, folder, r1 } = seed(storage);
    const copyId = storage.transaction((r) => r.collections.duplicateFolder(folder.id));
    const copy = repo.requireFolder(copyId);
    expect(copy).toMatchObject({ name: 'Users Copy', collectionId: col.id, parentFolderId: null });
    expect(copy.sortOrder).toBeGreaterThan(folder.sortOrder);

    const rows = repo.getTreeRows(col.id);
    const copySub = rows.find((x) => x.kind === 'folder' && x.parentId === copyId);
    expect(copySub?.name).toBe('Admin');
    const copiedList = rows.find((x) => x.kind === 'request' && x.parentId === copyId);
    const copiedDeep = rows.find((x) => x.kind === 'request' && x.parentId === copySub!.id);
    expect(copiedList?.name).toBe('List');
    expect(copiedDeep?.name).toBe('Deep');
    expect(copiedList!.id).not.toBe(r1.id);

    // Content, scripts and examples travel with the copy.
    const list = repo.requireRequest(copiedList!.id, 'resolve');
    expect(list.url).toBe(`https://${OLD}/users`);
    expect(list.scripts).toHaveLength(1);
    expect(list.examples).toHaveLength(1);
    expect(list.headers).toEqual(r1.headers);

    // Secrets: same values, NEW vault keys (owner = the new ids).
    expect(list.auth).toEqual({ type: 'basic', params: { username: OLD, password: `${OLD}-password` } });
    expect(storage.secrets.getSync(`auth:${copiedList!.id}:password`)).toBe(`${OLD}-password`);
    expect(storage.secrets.getSync(`auth:${r1.id}:password`)).toBe(`${OLD}-password`);
    expect(repo.requireFolder(copyId, 'resolve').auth.params.token).toBe('folder-token-literal');
    expect(storage.secrets.getSync(`auth:f:${copyId}:token`)).toBe('folder-token-literal');
    const vars = storage.repos.vars.folder.list(copyId, 'resolve');
    expect(vars.map((v) => [v.key, v.initialValue, v.isSecret])).toEqual([
      ['fv', `${OLD}/v1`, false],
      ['fsecret', `${OLD}-folder-secret`, true],
    ]);
    expect(vars[1]!.id).not.toBe(storage.repos.vars.folder.list(folder.id)[1]!.id);

    // The two folders are independent: deleting the copy leaves the original and its secrets intact.
    repo.deleteFolder(copyId);
    expect(repo.getRequest(copiedList!.id)).toBeNull();
    expect(storage.secrets.getSync(`auth:${copiedList!.id}:password`)).toBeNull();
    expect(repo.requireRequest(r1.id, 'resolve').auth.params.password).toBe(`${OLD}-password`);
    expect(storage.repos.vars.folder.list(folder.id, 'resolve')[1]!.initialValue).toBe(`${OLD}-folder-secret`);
    storage.close();
  });

  it('rolls back a failed duplicate completely (rows and secrets)', () => {
    const storage = createTestStorage();
    const { repo, col, folder } = seed(storage);
    const before = storage.opened.client.native.prepare('select count(*) as n from secrets').get() as { n: number };
    expect(() =>
      storage.transaction((r) => {
        r.collections.duplicateFolder(folder.id);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repo.getTreeRows(col.id).filter((x) => x.name === 'Users Copy')).toHaveLength(0);
    expect((storage.opened.client.native.prepare('select count(*) as n from secrets').get() as { n: number }).n).toBe(before.n);
    storage.close();
  });
});

describe('moveToCollection', () => {
  it('moves a folder subtree and a request into another collection, cascading collectionId and keeping vaulted auth', () => {
    const storage = createTestStorage();
    const { repo, ws, col, folder, sub, r1, r2, r3 } = seed(storage);
    const col2 = repo.createCollection(ws.id, { name: 'Target' });
    const keep = repo.createRequest(col2.id, null, emptyRequestDraft({ name: 'Existing' }));

    storage.transaction((r) => r.collections.moveToCollection('folder', folder.id, col2.id, null, 0));
    expect(repo.requireFolder(folder.id)).toMatchObject({ collectionId: col2.id, parentFolderId: null, sortOrder: 0 });
    expect(repo.requireFolder(sub.id).collectionId).toBe(col2.id);
    expect(repo.requireRequest(r1.id).collectionId).toBe(col2.id);
    expect(repo.requireRequest(r2.id).collectionId).toBe(col2.id);
    expect(repo.requireRequest(r3.id).collectionId).toBe(col.id);
    expect(repo.requireRequest(keep.id).sortOrder).toBe(1);
    expect(repo.getTreeRows(col.id).map((x) => x.id)).toEqual([r3.id]);
    const rows = repo.getTreeRows(col2.id);
    expect(rows.map((x) => x.name).sort()).toEqual(['Admin', 'Deep', 'Existing', 'List', 'Users']);
    expect(rows.find((x) => x.name === 'Admin')?.parentId).toBe(folder.id);
    expect(rows.find((x) => x.name === 'Deep')?.parentId).toBe(sub.id);
    // Nothing was re-vaulted: auth and folder variables are keyed by owner id.
    expect(repo.requireRequest(r1.id, 'resolve').auth.params.password).toBe(`${OLD}-password`);
    expect(repo.requireFolder(folder.id, 'resolve').auth.params.token).toBe('folder-token-literal');
    expect(storage.repos.vars.folder.list(folder.id, 'resolve')[1]!.initialValue).toBe(`${OLD}-folder-secret`);
    // The bundle of the target now contains the subtree (export / duplicate see it).
    expect(JSON.stringify(repo.loadBundle(col2.id, 'refs'))).toContain('"Deep"');

    // A request into a folder of another collection.
    storage.transaction((r) => r.collections.moveToCollection('request', r3.id, col2.id, sub.id, 0));
    expect(repo.requireRequest(r3.id)).toMatchObject({ collectionId: col2.id, folderId: sub.id, sortOrder: 0 });
    expect(repo.requireRequest(r2.id).sortOrder).toBe(1);
    expect(repo.listRequests(col.id)).toHaveLength(0);

    // Same collection falls back to a plain move; bad targets are refused.
    storage.transaction((r) => r.collections.moveToCollection('request', r3.id, col2.id, null, 0));
    expect(repo.requireRequest(r3.id).folderId).toBeNull();
    expect(() => repo.moveToCollection('request', r3.id, col.id, sub.id, 0)).toThrow(/different collection/);
    expect(() => repo.moveToCollection('folder', folder.id, col2.id, sub.id, 0)).toThrow(/itself or its descendants/);
    expect(() => repo.moveToCollection('folder', folder.id, 'nope', null, 0)).toThrow(/not found/i);
    storage.close();
  });
});

describe('findReplace (repository)', () => {
  it('counts per scope without writing on a dry run, then applies everything in one transaction', () => {
    const storage = createTestStorage();
    const { repo, col, folder, r1, r2, r3 } = seed(storage);
    const replacer = createReplacer({ find: OLD, replace: NEW });

    const dry = repo.findReplace(col.id, { scopes: allScopes, replacer, apply: false });
    expect(dry).toMatchObject({ matches: 12, requests: 2, folders: 1, variables: 2, collection: true, collections: 1, applied: false });
    expect(dry.byScope).toEqual({ url: 2, params: 1, headers: 1, body: 1, scripts: 2, descriptions: 3, variables: 2 });
    expect(dry.summary).toMatch(/^12 matches in 2 requests, 1 folder, 2 variables/);
    expect(dry.samples.length).toBeGreaterThan(5);
    expect(dry.samples.find((s) => s.location.includes('"List" › url'))).toMatchObject({ before: `https://${OLD}/users`, after: `https://${NEW}/users` });
    // Nothing changed.
    expect(repo.requireRequest(r1.id).url).toBe(`https://${OLD}/users`);
    expect(repo.requireCollection(col.id).description).toBe(`Uses ${OLD}`);
    expect(storage.repos.vars.collection.list(col.id)[0]!.initialValue).toBe(`https://${OLD}`);

    const applied = storage.transaction((r) => r.collections.findReplace(col.id, { scopes: allScopes, replacer, apply: true }));
    expect(applied).toMatchObject({ matches: 12, requests: 2, applied: true });
    const list = repo.requireRequest(r1.id, 'resolve');
    expect(list.url).toBe(`https://${NEW}/users`);
    expect(list.headers[0]!.value).toBe(NEW);
    expect(list.queryParams[0]!.value).toBe(NEW);
    expect(list.body.raw).toBe(`{"url":"${NEW}"}`);
    expect(list.scripts[0]!.source).toBe(`// ${NEW}`);
    expect(list.description).toBe(`desc ${NEW}`);
    expect(list.examples).toHaveLength(1);
    expect(repo.requireRequest(r2.id).url).toBe(`https://${NEW}/admin`);
    expect(repo.requireRequest(r3.id).url).toBe('https://other.test');
    expect(repo.requireCollection(col.id).description).toBe(`Uses ${NEW}`);
    expect(repo.requireCollection(col.id).scripts[0]!.source).toContain(NEW);
    expect(repo.requireFolder(folder.id).description).toBe(`folder ${NEW}`);
    expect(storage.repos.vars.collection.list(col.id)[0]!.initialValue).toBe(`https://${NEW}`);
    expect(storage.repos.vars.folder.list(folder.id)[0]!.initialValue).toBe(`${NEW}/v1`);
    // A second run finds nothing.
    expect(repo.findReplace(col.id, { scopes: allScopes, replacer, apply: false }).matches).toBe(0);
    storage.close();
  });

  it('never reads or writes secrets: auth credentials, secret variables and secretref values stay as they were', () => {
    const storage = createTestStorage();
    const { repo, col, folder, r1 } = seed(storage);
    const replacer = createReplacer({ find: OLD, replace: NEW });
    const result = storage.transaction((r) => r.collections.findReplace(col.id, { scopes: allScopes, replacer, apply: true }));
    expect(result.variables).toBe(2);
    expect(result.samples.some((s) => s.before.includes('secretref:') || s.after.includes('secretref:'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('-password');

    // Auth: the username is not a secret, but auth is out of scope entirely; the password is untouched.
    expect(repo.requireRequest(r1.id, 'resolve').auth).toEqual({ type: 'basic', params: { username: OLD, password: `${OLD}-password` } });
    expect(repo.requireCollection(col.id, 'resolve').auth.params.token).toBe(`${OLD}-collection-token`);
    expect(storage.repos.vars.collection.list(col.id, 'resolve').find((v) => v.key === 'token')?.initialValue).toBe(`${OLD}-secret-var`);
    expect(storage.repos.vars.folder.list(folder.id, 'resolve').find((v) => v.key === 'fsecret')?.initialValue).toBe(`${OLD}-folder-secret`);
    const native = storage.opened.client.native;
    const dump = JSON.stringify([native.prepare('select * from request_auth').all(), native.prepare('select * from collection_variables').all(), native.prepare('select * from folder_variables').all()]);
    expect(dump).not.toContain(`${NEW}-`);
    expect(dump).not.toContain(`${OLD}-password`);
    storage.close();
  });

  it('respects scopes and rolls back when the transaction fails', () => {
    const storage = createTestStorage();
    const { repo, col, r1 } = seed(storage);
    const replacer = createReplacer({ find: OLD, replace: NEW });
    const urlOnly = repo.findReplace(col.id, { scopes: ['url'], replacer, apply: false });
    expect(urlOnly).toMatchObject({ matches: 2, requests: 2, folders: 0, variables: 0, collection: false });

    expect(() =>
      storage.transaction((r) => {
        r.collections.findReplace(col.id, { scopes: allScopes, replacer, apply: true });
        throw new Error('midway');
      }),
    ).toThrow('midway');
    expect(repo.requireRequest(r1.id).url).toBe(`https://${OLD}/users`);
    expect(repo.requireCollection(col.id).description).toBe(`Uses ${OLD}`);
    expect(storage.repos.vars.collection.list(col.id)[0]!.initialValue).toBe(`https://${OLD}`);
    storage.close();
  });

  it('supports match case, whole word, regular expressions with groups, and literal $ in replacements', () => {
    const storage = createTestStorage();
    const { repo, col, r1 } = seed(storage);
    const run = (opts: Parameters<typeof createReplacer>[0], scopes = allScopes) => repo.findReplace(col.id, { scopes, replacer: createReplacer(opts), apply: false });
    expect(run({ find: OLD.toUpperCase(), replace: 'x' }).matches).toBe(12);
    expect(run({ find: OLD.toUpperCase(), replace: 'x', matchCase: true }).matches).toBe(0);
    expect(run({ find: 'user', replace: 'x', wholeWord: true }, ['url']).matches).toBe(0);
    expect(run({ find: 'user', replace: 'x' }, ['url']).matches).toBe(1);
    expect(run({ find: 'users', replace: 'x', wholeWord: true }, ['url']).matches).toBe(1);

    storage.transaction((r) => r.collections.findReplace(col.id, { scopes: ['url'], replacer: createReplacer({ find: 'api\\.(old)\\.test', replace: 'api.$1.example', useRegex: true }), apply: true }));
    expect(repo.requireRequest(r1.id).url).toBe('https://api.old.example/users');
    storage.transaction((r) => r.collections.findReplace(col.id, { scopes: ['url'], replacer: createReplacer({ find: 'example', replace: 'x$&y' }), apply: true }));
    expect(repo.requireRequest(r1.id).url).toBe('https://api.old.x$&y/users');
    storage.close();
  });
});

describe('collection management channels (service level)', () => {
  let t: TestApp;
  beforeAll(() => {
    t = createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('collections.findReplace previews, applies and audits counts only', async () => {
    const storage = t.app.ctx.storage;
    const { ws, col, r1 } = seed(storage);
    const col2 = storage.repos.collections.createCollection(ws.id, { name: 'Second' });
    storage.repos.collections.createRequest(col2.id, null, emptyRequestDraft({ name: 'S', url: `https://${OLD}/second` }));

    const preview = await t.api.collections.findReplace({ collectionId: col.id, find: OLD, replace: NEW, scopes: allScopes, apply: false });
    expect(preview).toMatchObject({ matches: 12, applied: false, collections: 1 });
    expect(await t.api.audit.list({ action: 'FIND_REPLACE' })).toHaveLength(0);

    const whole = await t.api.collections.findReplace({ workspaceId: ws.id, find: OLD, replace: NEW, scopes: ['url'], apply: false });
    expect(whole).toMatchObject({ matches: 3, requests: 3, collections: 2 });

    const applied = await t.api.collections.findReplace({ collectionId: col.id, find: OLD, replace: NEW, scopes: allScopes, apply: true });
    expect(applied.applied).toBe(true);
    expect((await t.api.requests.get({ id: r1.id })).url).toBe(`https://${NEW}/users`);
    const entries = await t.api.audit.list({ action: 'FIND_REPLACE' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toMatchObject({ target: 'collection', matches: 12, requests: 2, scopes: allScopes, regex: false });
    const details = JSON.stringify(entries[0]!.details);
    expect(details).not.toContain(OLD);
    expect(details).not.toContain(NEW);

    await expect(t.api.collections.findReplace({ collectionId: col.id, find: 'x', replace: '', scopes: [], apply: false })).rejects.toThrow(/scope/);
    await expect(t.api.collections.findReplace({ find: 'x', replace: '', scopes: ['url'], apply: false })).rejects.toThrow(/collection or a workspace/);
    await expect(t.api.collections.findReplace({ collectionId: col.id, find: '(a+)+$', replace: '', scopes: ['url'], useRegex: true, apply: false })).rejects.toThrow(/nests repetition/);
    await expect(t.api.collections.findReplace({ collectionId: col.id, find: 'a*', replace: '', scopes: ['url'], useRegex: true, apply: false })).rejects.toThrow(/empty string/);
  });

  it('folders.duplicate and requests.move across collections', async () => {
    const storage = t.app.ctx.storage;
    const { ws, col, folder, r3 } = seed(storage);
    const copy = await t.api.folders.duplicate({ id: folder.id });
    expect(copy).toMatchObject({ name: 'Users Copy', collectionId: col.id });
    expect((await t.api.collections.tree({ collectionId: col.id })).filter((n) => n.parentId === copy.id)).toHaveLength(2);

    const col2 = await t.api.collections.create({ workspaceId: ws.id, name: 'Elsewhere' });
    await t.api.requests.move({ kind: 'request', id: r3.id, parentFolderId: null, index: 0, collectionId: col2.id });
    expect((await t.api.requests.get({ id: r3.id })).collectionId).toBe(col2.id);
    await t.api.requests.move({ kind: 'folder', id: copy.id, parentFolderId: null, index: 1, collectionId: col2.id });
    const tree = await t.api.collections.tree({ collectionId: col2.id });
    expect(tree.filter((n) => n.parentId === null).map((n) => n.name)).toEqual(['Root', 'Users Copy']);
    expect(tree.find((n) => n.name === 'Deep')?.collectionId).toBe(col2.id);
    // Without collectionId it is the plain in-collection move.
    await t.api.requests.move({ kind: 'request', id: r3.id, parentFolderId: copy.id, index: 0 });
    expect((await t.api.requests.get({ id: r3.id })).folderId).toBe(copy.id);
  });

  it('cookies.add / cookies.update validate, vault the value and refresh the jar', async () => {
    const ws = (await t.api.workspaces.list())[0]!;
    const added = await t.api.cookies.add({ workspaceId: ws.id, domain: 'API.Example.com', name: 'sid', value: 'v4lue-1' });
    expect(added).toMatchObject({ domain: 'api.example.com', path: '/', name: 'sid', value: '', hostOnly: true, secure: false, httpOnly: false, sameSite: null, expiresAt: null });
    expect(await t.api.cookies.reveal({ id: added.id })).toBe('v4lue-1');
    const native = t.app.ctx.storage.opened.client.native;
    expect(JSON.stringify(native.prepare('select * from cookies').all())).not.toContain('v4lue-1');
    expect(JSON.stringify(native.prepare('select key, hex(blob) as b from secrets').all())).not.toContain(Buffer.from('v4lue-1').toString('hex'));
    // The jar sees it immediately.
    expect(await t.app.ctx.cookies.hookFor(ws.id).getCookieHeader('http://api.example.com/x')).toBe('sid=v4lue-1');

    const updated = await t.api.cookies.update({ id: added.id, secure: true, sameSite: 'none', expiresAt: '2099-01-02T03:04:00Z', value: 'v4lue-2' });
    expect(updated).toMatchObject({ secure: true, sameSite: 'None', expiresAt: '2099-01-02T03:04:00.000Z' });
    expect(await t.api.cookies.reveal({ id: added.id })).toBe('v4lue-2');
    expect(await t.app.ctx.cookies.hookFor(ws.id).getCookieHeader('http://api.example.com/x')).toBeUndefined();
    expect(await t.app.ctx.cookies.hookFor(ws.id).getCookieHeader('https://api.example.com/x')).toBe('sid=v4lue-2');
    // Omitting the value keeps it.
    await t.api.cookies.update({ id: added.id, path: '/api' });
    expect(await t.api.cookies.reveal({ id: added.id })).toBe('v4lue-2');

    const bad = async (input: Parameters<typeof t.api.cookies.add>[0], re: RegExp) => expect(t.api.cookies.add(input)).rejects.toThrow(re);
    await bad({ workspaceId: ws.id, domain: '*', name: 'a', value: 'b' }, /domain/);
    await bad({ workspaceId: ws.id, domain: ' ', name: 'a', value: 'b' }, /domain/);
    await bad({ workspaceId: ws.id, domain: 'https://x.test', name: 'a', value: 'b' }, /host name only/);
    await bad({ workspaceId: ws.id, domain: '*.x.test', name: 'a', value: 'b' }, /Wildcards/);
    await bad({ workspaceId: ws.id, domain: 'x.test', name: 'a b', value: 'b' }, /name/);
    await bad({ workspaceId: ws.id, domain: 'x.test', name: 'a', value: 'b;c' }, /value/);
    await bad({ workspaceId: ws.id, domain: 'x.test', name: 'a', value: 'b', path: 'nope' }, /path/);
    await bad({ workspaceId: ws.id, domain: 'x.test', name: 'a', value: 'b', sameSite: 'Weird' }, /SameSite/);
    await bad({ workspaceId: ws.id, domain: 'x.test', name: 'a', value: 'b', sameSite: 'None' }, /Secure/);
    await bad({ workspaceId: ws.id, domain: 'x.test', name: 'a', value: 'b', expiresAt: 'tomorrow' }, /expiry/);
    await bad({ workspaceId: ws.id, domain: 'api.example.com', path: '/api', name: 'sid', value: 'dup' }, /already exists/);
    await expect(t.api.cookies.update({ id: 'missing', secure: true })).rejects.toThrow(/not found/i);
    await t.api.cookies.delete({ id: added.id });
    expect(await t.api.cookies.list({ workspaceId: ws.id })).toHaveLength(0);
  });
});
