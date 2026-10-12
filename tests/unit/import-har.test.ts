import { describe, expect, it } from 'vitest';
import type { ImportProgress } from '@aegis/core';
import { importDocument, parseHar } from '@aegis/postman';
import { folderAt, requestAt } from './_postman-fixtures';
import { expectRoundTrip, failure, formatFixtureText, literalsOf, ownKeysDeep } from './_format-fixtures';

const text = formatFixtureText('har', 'browser-session.har');
const r = parseHar(text);
const login = folderAt(r.bundle.items, 0);
const account = folderAt(r.bundle.items, 1);

describe('HAR import: structure', () => {
  it('creates one folder per page, one request per entry and keeps page-less entries at the top level', () => {
    expect(r.format).toBe('har-1.2');
    expect(r.bundle.name).toBe('Example Shop - Login');
    expect(r.bundle.description).toMatch(/HAR 1\.2 archive \(10 entries, recorded by WebInspector 537\.36, browser Chrome 120\.0\.6099\.130\)/);
    expect(r.bundle.auth).toEqual({ type: 'none', params: {} });
    expect(r.bundle.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name))).toEqual([
      'folder:Example Shop - Login',
      'folder:Example Shop - Account',
      'GET /api/orders',
      'GET /collect',
      'DELETE /api/orders/1001',
    ]);
    expect(login.items.map((i) => i.kind === 'request' && i.request.name)).toEqual(['GET /login', 'POST /api/auth/login', 'GET /old/report']);
    expect(account.items.map((i) => i.kind === 'request' && i.request.name)).toEqual(['GET /api/me', 'POST /api/profile', 'POST /api/avatar', 'GET /img/logo.png']);
    expect(r.stats).toEqual({ folders: 2, requests: 10, variables: 11, scripts: 0, examples: 9 });
    expect(r.warnings.some((w) => w.severity === 'INFO' && w.path === 'log.entries[7].pageref' && /Unknown page "page_missing"/.test(w.message))).toBe(true);
  });

  it('drops HTTP/2 pseudo-headers and computed headers with a single summary each', () => {
    const first = requestAt(login.items, 0);
    expect(first.method).toBe('GET');
    expect(first.url).toBe('https://shop.example.com/login');
    expect(first.headers.map((h) => h.key)).toEqual(['accept', 'accept-encoding', 'accept-language', 'cookie', 'user-agent']);
    expect(requestAt(login.items, 1).headers.map((h) => h.key)).not.toContain('content-length');
    expect(requestAt(account.items, 1).headers.map((h) => h.key)).not.toContain('host');
    expect(r.warnings.filter((w) => /pseudo-header/.test(w.message))).toHaveLength(1);
    expect(r.warnings.find((w) => /pseudo-header/.test(w.message))!.message).toMatch(/^9 HTTP\/2/);
    expect(r.warnings.find((w) => /Host\/Content-Length/.test(w.message))!.message).toMatch(/^2 /);
    expect(r.warnings.find((w) => /recorded cookie/.test(w.message))!.message).toMatch(/^4 /);
    expect(r.warnings.find((w) => /Timing, cache and size/.test(w.message))!.message).toMatch(/of 10 entries/);
  });

  it('splits the URL into base, query rows and fragment', () => {
    const me = requestAt(account.items, 0);
    expect(me.url).toBe('https://shop.example.com/api/me');
    expect(me.queryParams).toEqual([
      { key: 'include', value: 'orders', enabled: true },
      { key: 'api_key', value: '{{har_api_key}}', enabled: true },
    ]);
    const orders = requestAt(r.bundle.items, 2);
    expect(orders.url).toBe('https://shop.example.com/api/orders');
    expect(orders.queryParams).toEqual([
      { key: 'page', value: '2', enabled: true },
      { key: 'status', value: 'shipped', enabled: true },
    ]);
    expect(orders.metadata).toEqual({ urlHash: '#top' });
    const blocked = requestAt(r.bundle.items, 3);
    expect(blocked.url).toBe('https://analytics.example.com/collect');
    expect(blocked.queryParams.map((q) => q.key)).toEqual(['v', 'tid']);
  });

  it('removes user:password@ from URLs', () => {
    const legacy = requestAt(login.items, 2);
    expect(legacy.url).toBe('https://legacy.example.com/old/report');
    expect(r.warnings.some((w) => w.severity === 'WARNING' && w.path === 'log.entries[8].request.url' && /removed and not imported/.test(w.message))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('legacy-user');
  });
});

describe('HAR import: bodies and examples', () => {
  it('maps JSON postData to a raw JSON body with credential fields placeholdered', () => {
    const post = requestAt(login.items, 1);
    expect(post.method).toBe('POST');
    expect(post.body).toEqual({ mode: 'raw', raw: '{"email":"ada@example.com","password":"{{har_password}}","remember":true}', rawLanguage: 'json' });
    expect(post.examples[0]!.body).toBe('{"token":"{{har_token}}","user":{"id":42,"name":"Ada"}}');
    expect(post.headers.find((h) => h.key === 'content-type')!.value).toBe('application/json');
    // a CSRF token is not a credential header: kept as recorded
    expect(post.headers.find((h) => h.key === 'x-csrf-token')!.value).toBe('c5rf-public-0002');
  });

  it('maps urlencoded and multipart postData, validating file references', () => {
    const profile = requestAt(account.items, 1);
    expect(profile.body).toEqual({
      mode: 'urlencoded',
      urlencoded: [
        { key: 'display_name', value: 'Ada+Lovelace', enabled: true },
        { key: 'password', value: '{{har_password_2}}', enabled: true },
        { key: 'newsletter', value: '1', enabled: true },
      ],
    });
    const avatar = requestAt(account.items, 2);
    expect(avatar.body.mode).toBe('formdata');
    expect(avatar.body.formData).toEqual([
      { key: 'avatar', type: 'file', value: '', filePath: 'avatar.png', contentType: 'image/png', enabled: true },
      { key: 'caption', type: 'text', value: 'Profile photo', enabled: true },
      { key: 'evil', type: 'file', value: '', enabled: true },
      { key: 'access_token', type: 'text', value: '{{har_access_token}}', enabled: true },
    ]);
    const rejected = r.warnings.find((w) => w.path === 'log.entries[4].request.postData.params[2].fileName');
    expect(rejected?.message).toMatch(/traversal/);
    expect(JSON.stringify(r.bundle)).not.toContain('passwd');
  });

  it('turns recorded responses into examples with decoded textual bodies', () => {
    const first = requestAt(login.items, 0).examples;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: '200 OK', status: 'OK', code: 200, language: 'html', metadata: { cookie: [] } });
    expect(first[0]!.body.startsWith('<!doctype html>')).toBe(true);
    expect(first[0]!.headers).toEqual([
      { key: 'content-type', value: 'text/html; charset=utf-8', enabled: true },
      { key: 'set-cookie', value: '{{har_set_cookie}}', enabled: true },
      { key: 'cache-control', value: 'no-store', enabled: true },
    ]);
    const noContent = requestAt(account.items, 1).examples[0]!;
    expect(noContent).toMatchObject({ name: '204 No Content', status: 'No Content', code: 204, body: '' });
    expect(noContent.language).toBeUndefined();
    expect(requestAt(r.bundle.items, 2).examples[0]!.body).toBe('{"items":[]}');
    expect(requestAt(r.bundle.items, 2).examples[0]!.language).toBe('json');
  });

  it('skips binary response bodies and entries without a response', () => {
    const image = requestAt(account.items, 3).examples[0]!;
    expect(image).toMatchObject({ code: 200, body: '' });
    expect(image.language).toBeUndefined();
    expect(r.warnings.some((w) => w.severity === 'INFO' && w.path === 'log.entries[5].response.content.text' && /Binary response body/.test(w.message))).toBe(true);
    expect(requestAt(r.bundle.items, 3).examples).toEqual([]);
    expect(r.warnings.some((w) => w.path === 'log.entries[7].response.status' && /status 0/.test(w.message))).toBe(true);
    expect(requestAt(r.bundle.items, 4).description).toBe('Deletes the order created during the session');
    expect(requestAt(login.items, 2).examples[0]).toMatchObject({ code: 301, status: 'Moved Permanently', body: '' });
  });

  it('respects the example body size limit', () => {
    const small = parseHar(text, { maxExampleBodyBytes: 16 });
    expect(requestAt(folderAt(small.bundle.items, 0).items, 0).examples[0]!.body).toBe('');
    expect(small.warnings.some((w) => w.severity === 'WARNING' && /Response body larger than 0 KiB/.test(w.message))).toBe(true);
    expect(requestAt(small.bundle.items, 4).examples[0]!.body).toBe('{"deleted":true}');
  });
});

describe('HAR import: credentials are never imported literally', () => {
  it('replaces Authorization, Cookie, Set-Cookie, API keys and passwords with empty secret placeholders', () => {
    expect(r.bundle.variables.map((v) => v.key)).toEqual([
      'har_cookie',
      'har_set_cookie',
      'har_cookie_2',
      'har_password',
      'har_set_cookie_2',
      'har_token',
      'har_api_key',
      'har_authorization',
      'har_password_2',
      'har_access_token',
      'har_x_api_key',
    ]);
    for (const v of r.bundle.variables) {
      expect(v).toMatchObject({ initialValue: '', isSecret: true, enabled: true, type: 'secret' });
      expect(v.description).toMatch(/captured in the HAR file; the credential was not imported/);
    }
    expect(r.bundle.variables[3]!.description).toMatch(/"password" JSON body field/);
    expect(r.bundle.variables[8]!.description).toMatch(/"password" form field/);
    expect(requestAt(login.items, 0).headers.find((h) => h.key === 'cookie')!.value).toBe('{{har_cookie}}');
    expect(requestAt(login.items, 1).headers.find((h) => h.key === 'cookie')!.value).toBe('{{har_cookie_2}}');
    // the same bearer token in five entries maps to one variable
    for (const req of [requestAt(account.items, 0), requestAt(account.items, 1), requestAt(account.items, 2), requestAt(r.bundle.items, 2), requestAt(r.bundle.items, 4)]) {
      expect(req.headers.find((h) => h.key === 'authorization')!.value).toBe('{{har_authorization}}');
    }
    expect(requestAt(r.bundle.items, 4).headers.find((h) => h.key === 'x-api-key')!.value).toBe('{{har_x_api_key}}');
  });

  it('keeps no literal credential anywhere in the bundle or the warnings', () => {
    const literals = literalsOf(text);
    expect(literals.length).toBeGreaterThanOrEqual(9);
    const stored = JSON.stringify({ bundle: r.bundle, warnings: r.warnings });
    for (const literal of literals) expect(stored, literal).not.toContain(literal);
    const infos = r.warnings.filter((w) => /replaced with \{\{har_/.test(w.message));
    expect(infos.length).toBeGreaterThanOrEqual(15);
    expect(infos.every((w) => w.severity === 'INFO' && w.sourceValue === undefined)).toBe(true);
  });

  it('scrubs credential keys inside JSON bodies but leaves other text bodies as recorded', () => {
    const scrubbed = parseHar({
      log: {
        version: '1.2',
        entries: [
          { request: { method: 'POST', url: 'https://x/', headers: [], postData: { mimeType: 'application/json', text: '{"a":{"refresh_token":"rt-literal-x","list":[{"client_secret":"cs-literal-y"}]},"keep":"me"}' } }, response: { status: 200, statusText: 'OK', headers: [], content: { mimeType: 'text/plain', text: 'token=plain-literal-z' } } },
          { request: { method: 'POST', url: 'https://x/', headers: [], postData: { mimeType: 'application/json', text: 'not json {' } } },
        ],
      },
    });
    const first = requestAt(scrubbed.bundle.items, 0);
    expect(first.body.raw).toBe('{"a":{"refresh_token":"{{har_refresh_token}}","list":[{"client_secret":"{{har_client_secret}}"}]},"keep":"me"}');
    expect(first.examples[0]!.body).toBe('token=plain-literal-z');
    expect(requestAt(scrubbed.bundle.items, 1).body.raw).toBe('not json {');
    expect(scrubbed.bundle.variables.map((v) => v.key)).toEqual(['har_refresh_token', 'har_client_secret']);
  });
});

describe('HAR import: round trip and integration', () => {
  it('exports to a valid Postman v2.1 collection that re-imports semantically equal', () => {
    expectRoundTrip(r.bundle);
  });

  it('accepts a parsed object, a custom name and reports progress', () => {
    const stages: ImportProgress['stage'][] = [];
    const named = parseHar(JSON.parse(text), { name: 'Session', onProgress: (p) => stages.push(p.stage) });
    expect(named.bundle.name).toBe('Session');
    expect(new Set(stages)).toEqual(new Set(['Parsing', 'Validating', 'Importing', 'Finalizing']));
  });

  it('is registered with importDocument', () => {
    const doc = importDocument(text, { fileName: 'browser-session.har' });
    expect(doc.format).toBe('har');
    expect(doc.name).toBe('browser-session');
    expect(doc.schemaVersion).toBe('1.2');
    expect(doc.collections).toHaveLength(1);
    expect(doc.environments).toEqual([]);
    expect(doc.globals).toBeNull();
    expect(doc.stats.requests).toBe(10);
  });
});

describe('HAR import: hostile input', () => {
  const hostileText = formatFixtureText('har', 'invalid/hostile.har');
  const h = parseHar(hostileText);

  it('never pollutes prototypes and drops unsafe keys', () => {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    const keys = ownKeysDeep([h.bundle, h.warnings]);
    expect(keys).not.toContain('__proto__');
    expect(keys).not.toContain('constructor');
    expect(keys).not.toContain('prototype');
  });

  it('rejects traversal, absolute, UNC, device, file:, home and env-expanded paths and never stores them', () => {
    const upload = requestAt(folderAt(h.bundle.items, 0).items, 0);
    expect(upload.method).toBe('POST');
    expect(upload.body.formData!.map((f) => f.filePath)).toEqual([undefined, undefined, undefined, undefined, 'files/ok.txt', undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(upload.body.formData!.at(-1)).toEqual({ key: 'k', type: 'text', value: 'plain', enabled: true });
    const stored = JSON.stringify(h.bundle);
    for (const bad of ['passwd', 'win.ini', 'server', 'shadow', 'hosts', 'USERPROFILE', 'HOME', 'a\u0000b']) expect(stored).not.toContain(bad);
    const rejected = h.warnings.filter((w) => /Unsafe file path rejected/.test(w.message));
    expect(rejected).toHaveLength(9);
    expect(rejected.map((w) => w.message)).toEqual([
      expect.stringContaining('path traversal'),
      expect.stringContaining('absolute path'),
      expect.stringContaining('UNC path'),
      expect.stringContaining('absolute path'),
      expect.stringContaining('file: URL'),
      expect.stringContaining('home-directory path'),
      expect.stringContaining('environment variable expansion'),
      expect.stringContaining('environment variable expansion'),
      expect.stringContaining('contains NUL byte'),
    ]);
    expect(rejected.every((w) => w.path.startsWith('log.entries[0].request.postData.params['))).toBe(true);
  });

  it('tolerates malformed pages, entries, headers, responses and encodings', () => {
    expect(h.bundle.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name))).toEqual(['folder:Page', 'GET /a', 'GET', 'GET /deep']);
    expect(h.stats).toEqual({ folders: 1, requests: 4, variables: 3, scripts: 0, examples: 3 });
    expect(h.bundle.variables.map((v) => v.key)).toEqual(['har_token', 'har_authorization', 'har_set_cookie']);
    expect(h.warnings.some((w) => w.path === 'log.version' && /1\.1/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'log.pages[1].id' && /Duplicate page/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'log.pages[2]' && /without a string id/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'log.entries[0].request.headers[1]' && /without a name/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'log.entries[1].response.content.encoding' && /rot13/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'log.entries[2].request.url' && /missing/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'log.entries[3].request')).toBe(true);
    expect(h.warnings.some((w) => w.path === 'log.entries[4]')).toBe(true);
    const upload = requestAt(folderAt(h.bundle.items, 0).items, 0);
    expect(upload.examples[0]).toMatchObject({ code: 200, status: 'OK', body: '{}' });
    expect(upload.headers).toEqual([
      { key: 'Authorization', value: '{{har_authorization}}', enabled: true },
      { key: 'X-Nested', value: 'ok', description: 'kept', enabled: true },
    ]);
    expect(requestAt(h.bundle.items, 1).examples[0]!.body).toBe('');
    for (const literal of literalsOf(hostileText)) expect(JSON.stringify(h)).not.toContain(literal);
    expectRoundTrip(h.bundle);
  });

  it('enforces size and item limits before converting', () => {
    expect(failure(() => parseHar(text, { maxBytes: 100 })).code).toBe('IMPORT_TOO_LARGE');
    expect(failure(() => parseHar('x'.repeat(200), { maxBytes: 100 })).code).toBe('IMPORT_TOO_LARGE');
    expect(failure(() => parseHar(text, { maxItems: 3 })).code).toBe('IMPORT_TOO_LARGE');
    expect(parseHar(text, { maxItems: 12 }).stats.requests).toBe(10);
  });

  it('rejects documents that are not HAR with ERROR warnings attached', () => {
    for (const input of ['{}', '[]', 'null', '42', '{"log":{}}', '{"log":{"entries":{}}}', 'not json', '']) {
      const err = failure(() => parseHar(input));
      expect(err.code, input).toBe('IMPORT_INVALID');
      const warnings = err.details.warnings as Array<{ severity: string }>;
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.every((w) => w.severity === 'ERROR')).toBe(true);
    }
    expect(failure(() => parseHar('{"log":{"entries":{}}}')).message).toMatch(/log\.entries/);
  });

  it('ignores absurdly deep unknown data instead of crashing', () => {
    const depth = 3000;
    const deep = `{"log":{"version":"1.2","entries":[{"request":{"method":"GET","url":"https://x/","headers":[],"x":${'['.repeat(depth)}${']'.repeat(depth)}}}]}}`;
    expect(parseHar(deep).stats.requests).toBe(1);
  });
});
