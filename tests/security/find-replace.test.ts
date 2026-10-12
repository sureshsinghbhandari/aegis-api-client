import { describe, expect, it } from 'vitest';
import { FIND_REPLACE_SCOPES, emptyRequestDraft } from '@aegis/core';
import { MAX_PATTERN_LENGTH, compileFindPattern, createReplacer, hasNestedQuantifier } from '../../packages/app/src/services/find-replace';
import { createTestStorage } from '../helpers/storage';

describe('find & replace: regular expression safety', () => {
  it('detects nested unbounded repetition (classic ReDoS shapes) and nothing else', () => {
    for (const bad of ['(a+)+', '(a*)*', '((ab)+)*', '(x{2,})+', '(\\d+)*$', '^(a|b+)+$', '(a+){2}', '(?:a+)+']) expect(hasNestedQuantifier(bad), bad).toBe(true);
    for (const ok of ['(a|b)+c', '(a+)?', '[(+]+', '\\(a+\\)+', 'a+b*', '(ab)+', '(a{0,1})+', 'https?://[^/]+', '(a+)(b+)', '(a?)*']) expect(hasNestedQuantifier(ok), ok).toBe(false);
  });

  it('rejects empty, oversized, invalid, nested and empty-matching patterns before anything runs', () => {
    expect(() => compileFindPattern({ find: '' })).toThrow(/Enter text/);
    expect(() => compileFindPattern({ find: 'a'.repeat(MAX_PATTERN_LENGTH + 1) })).toThrow(/too long/);
    expect(() => compileFindPattern({ find: '(a+)+$', useRegex: true })).toThrow(/nests repetition/);
    expect(() => compileFindPattern({ find: '(', useRegex: true })).toThrow(/not valid/);
    expect(() => compileFindPattern({ find: 'a*', useRegex: true })).toThrow(/empty string/);
    expect(() => compileFindPattern({ find: '^', useRegex: true })).toThrow(/empty string/);
    expect(() => compileFindPattern({ find: '(foo|bar)+', useRegex: true })).not.toThrow();
    // Literal mode escapes everything: no pattern typed as text can become a regular expression.
    const re = compileFindPattern({ find: '(a+)+$' });
    expect(re.test('x(a+)+$y')).toBe(true);
    expect(re.test('aaaa')).toBe(false);
  });

  it('enforces a time budget and the transaction rolls everything back when it is exceeded', () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('P');
    const col = storage.repos.collections.createCollection(ws.id, { name: 'C' });
    const req = storage.repos.collections.createRequest(col.id, null, emptyRequestDraft({ name: 'R', url: 'https://a.test/a' }));
    const exhausted = createReplacer({ find: 'a', replace: 'b', budgetMs: -1 });
    expect(() => exhausted.count('aaa')).toThrow(/took too long/);
    expect(() => storage.transaction((r) => r.collections.findReplace(col.id, { scopes: [...FIND_REPLACE_SCOPES], replacer: exhausted, apply: true }))).toThrow(/took too long/);
    expect(storage.repos.collections.requireRequest(req.id).url).toBe('https://a.test/a');
    storage.close();
  });
});

describe('find & replace never touches secrets', () => {
  it('leaves vaulted credentials, secret variables and secretref values alone even when they contain the search text', () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('P');
    const col = storage.repos.collections.createCollection(ws.id, { name: 'C', auth: { type: 'bearer', params: { token: 'hunter2-collection' } } });
    storage.repos.vars.collection.replaceAll(col.id, [
      { key: 'plain', initialValue: 'hunter2-plain', isSecret: false, enabled: true },
      { key: 'secret', initialValue: 'hunter2-secret', isSecret: true, enabled: true },
    ]);
    const folder = storage.repos.collections.createFolder(col.id, null, { name: 'F', auth: { type: 'apikey', params: { key: 'X-Key', value: 'hunter2-folder' } } });
    const req = storage.repos.collections.createRequest(
      col.id,
      folder.id,
      emptyRequestDraft({
        name: 'R',
        url: 'https://hunter2.test',
        headers: [{ key: 'X-Token', value: 'hunter2-header', enabled: true }],
        auth: { type: 'oauth2', params: { clientId: 'hunter2-client-id', clientSecret: 'hunter2-client-secret', accessToken: 'hunter2-access' } },
      }),
    );
    // A header whose VALUE is a secret reference (e.g. pasted from a secret variable) is skipped too.
    const ref = storage.repos.vars.collection.list(col.id)[1]!.initialValue;
    expect(ref).toMatch(/^secretref:/);
    storage.repos.collections.updateRequest(req.id, { ...storage.repos.collections.requireRequest(req.id), headers: [{ key: 'X-Token', value: 'hunter2-header', enabled: true }, { key: 'X-Ref', value: ref, enabled: true }] });

    const replacer = createReplacer({ find: 'hunter2', replace: 'REPLACED' });
    const result = storage.transaction((r) => r.collections.findReplace(col.id, { scopes: [...FIND_REPLACE_SCOPES], replacer, apply: true }));
    // Only url, one header and one plain variable matched.
    expect(result).toMatchObject({ matches: 3, requests: 1, variables: 1, folders: 0, collection: false });
    expect(result.byScope).toMatchObject({ url: 1, headers: 1, variables: 1 });
    expect(JSON.stringify(result.samples)).not.toContain('secretref:');
    expect(JSON.stringify(result)).not.toMatch(/hunter2-(secret|collection|folder|client|access)/);

    const after = storage.repos.collections.requireRequest(req.id, 'resolve');
    expect(after.url).toBe('https://REPLACED.test');
    expect(after.headers[0]!.value).toBe('REPLACED-header');
    expect(after.headers[1]!.value).toBe(ref);
    expect(after.auth.params).toEqual({ clientId: 'hunter2-client-id', clientSecret: 'hunter2-client-secret', accessToken: 'hunter2-access' });
    expect(storage.repos.collections.requireCollection(col.id, 'resolve').auth.params.token).toBe('hunter2-collection');
    expect(storage.repos.collections.requireFolder(folder.id, 'resolve').auth.params.value).toBe('hunter2-folder');
    const vars = storage.repos.vars.collection.list(col.id, 'resolve');
    expect(vars.map((v) => v.initialValue)).toEqual(['REPLACED-plain', 'hunter2-secret']);
    // Plain tables never saw a secret, before or after.
    const native = storage.opened.client.native;
    const dump = JSON.stringify([native.prepare('select * from request_auth').all(), native.prepare('select * from collection_variables').all(), native.prepare('select * from request_headers').all(), native.prepare('select * from folders').all()]);
    expect(dump).not.toMatch(/hunter2-(secret|collection|folder|client-secret|access)/);
    expect(dump).not.toContain('REPLACED-secret');
    storage.close();
  });
});
