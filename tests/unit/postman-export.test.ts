import { describe, expect, it } from 'vitest';
import type { CollectionBundle, RequestDraft } from '@aegis/core';
import { emptyRequestDraft } from '@aegis/core';
import {
  compareCollectionBundles,
  exportPostmanCollection,
  parsePostmanCollection,
  serializePostmanJson,
  validatePostmanV21Structure,
} from '@aegis/postman';
import { collectionOf, fixtureText, requestAt, requestItem } from './_postman-fixtures';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function bundleOf(requests: Array<Partial<RequestDraft>>, extra: Partial<CollectionBundle> = {}): CollectionBundle {
  return {
    name: 'Built by hand',
    description: '',
    variables: [],
    auth: { type: 'none', params: {} },
    scripts: [],
    sourceMetadata: {},
    items: requests.map((r) => ({ kind: 'request' as const, request: emptyRequestDraft(r) })),
    ...extra,
  };
}

const exportAny = (bundle: CollectionBundle, options?: { includeSecrets?: boolean }): any => exportPostmanCollection(bundle, options);
const exportItem = (doc: any, i = 0) => doc.item[i];

describe('exportPostmanCollection: document shape', () => {
  it('writes the v2.1 info block with a deterministic id when the bundle has no uid', () => {
    const a = exportAny(bundleOf([]));
    const b = exportAny(bundleOf([]));
    expect(a.info.schema).toBe(SCHEMA);
    expect(a.info.name).toBe('Built by hand');
    expect(a.info._postman_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.info._postman_id).toBe(b.info._postman_id);
    expect(exportAny(bundleOf([], { name: 'Other' })).info._postman_id).not.toBe(a.info._postman_id);
    expect(exportAny(bundleOf([], { uid: 'abc-123' })).info._postman_id).toBe('abc-123');
  });

  it('serialises with 2-space indent, a trailing newline and no timestamps', () => {
    const text = serializePostmanJson(exportAny(parsePostmanCollection(fixtureText('kitchen-sink.json')).bundle));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.startsWith('{\n  "info": {')).toBe(true);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(JSON.parse(text).info.schema).toBe(SCHEMA);
  });

  it('exports identical text every time', () => {
    const bundle = parsePostmanCollection(fixtureText('kitchen-sink.json')).bundle;
    expect(serializePostmanJson(exportAny(bundle))).toBe(serializePostmanJson(exportAny(bundle)));
  });

  it('does not mutate the bundle', () => {
    const bundle = parsePostmanCollection(fixtureText('kitchen-sink.json')).bundle;
    const before = JSON.stringify(bundle);
    exportAny(bundle);
    exportAny(bundle, { includeSecrets: true });
    expect(JSON.stringify(bundle)).toBe(before);
  });
});

describe('exportPostmanCollection: requests', () => {
  it('composes the url object (protocol, host, port, path, query, variables, hash)', () => {
    const doc = exportAny(
      bundleOf([
        {
          url: 'https://api.example.com:8443/v1/users/:userId/{{section}}',
          queryParams: [
            { key: 'a', value: '1', enabled: true },
            { key: 'off', value: 'x', enabled: false, description: 'disabled one' },
            { key: 'b', value: '{{b}}', enabled: true },
          ],
          pathVariables: [{ key: 'userId', value: '9', enabled: true, description: 'id' }],
          metadata: { urlHash: '#frag' },
        },
      ]),
    );
    const url = exportItem(doc).request.url;
    expect(url).toEqual({
      raw: 'https://api.example.com:8443/v1/users/:userId/{{section}}?a=1&b={{b}}#frag',
      protocol: 'https',
      host: ['api', 'example', 'com'],
      port: '8443',
      path: ['v1', 'users', ':userId', '{{section}}'],
      query: [{ key: 'a', value: '1' }, { key: 'off', value: 'x', description: 'disabled one', disabled: true }, { key: 'b', value: '{{b}}' }],
      variable: [{ key: 'userId', value: '9', description: 'id' }],
      hash: 'frag',
    });
  });

  it('keeps a variable host as a single element and omits empty parts', () => {
    const doc = exportAny(bundleOf([{ url: '{{baseUrl}}/ping' }, { url: '' }]));
    expect(exportItem(doc, 0).request.url).toEqual({ raw: '{{baseUrl}}/ping', host: ['{{baseUrl}}'], path: ['ping'] });
    expect(exportItem(doc, 1).request.url).toEqual({ raw: '' });
  });

  it('exports method, headers (with disabled flag) and always an array of headers', () => {
    const doc = exportAny(
      bundleOf([{ method: 'PATCH', headers: [{ key: 'A', value: '1', enabled: true }, { key: 'B', value: '2', enabled: false, description: 'why' }] }, {}]),
    );
    expect(exportItem(doc).request.method).toBe('PATCH');
    expect(exportItem(doc).request.header).toEqual([
      { key: 'A', value: '1', type: 'text' },
      { key: 'B', value: '2', type: 'text', description: 'why', disabled: true },
    ]);
    expect(exportItem(doc, 1).request.header).toEqual([]);
    expect(exportItem(doc, 1).response).toEqual([]);
  });

  it('exports every body mode', () => {
    const doc = exportAny(
      bundleOf([
        { body: { mode: 'raw', raw: '{"a":1}', rawLanguage: 'json' } },
        { body: { mode: 'raw', raw: 'x' } },
        { body: { mode: 'urlencoded', urlencoded: [{ key: 'k', value: 'v', enabled: false }] } },
        {
          body: {
            mode: 'formdata',
            formData: [
              { key: 't', type: 'text', value: 'v', enabled: true, contentType: 'text/plain' },
              { key: 'f', type: 'file', value: '', filePath: 'files/a.png', enabled: true },
              { key: 'nofile', type: 'file', value: '', enabled: false },
              { key: 'ref', type: 'variable', value: 'myVar', enabled: true },
            ],
          },
        },
        { body: { mode: 'binary', filePath: 'files/b.bin' } },
        { body: { mode: 'none' } },
      ]),
    );
    expect(exportItem(doc, 0).request.body).toEqual({ mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } });
    expect(exportItem(doc, 1).request.body).toEqual({ mode: 'raw', raw: 'x' });
    expect(exportItem(doc, 2).request.body).toEqual({ mode: 'urlencoded', urlencoded: [{ key: 'k', value: 'v', type: 'text', disabled: true }] });
    expect(exportItem(doc, 3).request.body.formdata).toEqual([
      { key: 't', value: 'v', type: 'text', contentType: 'text/plain' },
      { key: 'f', type: 'file', src: 'files/a.png' },
      { key: 'nofile', type: 'file', src: null, disabled: true },
      { key: 'ref', value: '{{myVar}}', type: 'text' },
    ]);
    expect(exportItem(doc, 4).request.body).toEqual({ mode: 'file', file: { src: 'files/b.bin' } });
    expect(exportItem(doc, 5).request).not.toHaveProperty('body');
  });

  it('restores GraphQL bodies, regenerating them when the raw body was edited', () => {
    const imported = parsePostmanCollection(fixtureText('kitchen-sink.json')).bundle;
    const original = JSON.parse(fixtureText('kitchen-sink.json')).item[5].item[0].request.body;
    const same = exportAny(imported);
    expect(same.item[5]!.item[0].request.body).toEqual(original);
    const gql = requestAt(imported.items.slice(5, 6), 0, 0);
    gql.body.raw = JSON.stringify({ query: '{ ping }', variables: { x: 1 } });
    const edited = exportAny(imported);
    expect(edited.item[5]!.item[0].request.body.graphql).toEqual({ query: '{ ping }', variables: '{\n  "x": 1\n}' });
  });

  it('keeps the original language of unknown raw body languages unless the user changed it', () => {
    const r = parsePostmanCollection(collectionOf([requestItem({ method: 'POST', url: 'http://x', body: { mode: 'raw', raw: 'a: 1', options: { raw: { language: 'yaml' } } } })]));
    expect(exportAny(r.bundle).item[0]!.request.body.options).toEqual({ raw: { language: 'yaml' } });
    requestAt(r.bundle.items, 0).body.rawLanguage = 'json';
    expect(exportAny(r.bundle).item[0]!.request.body.options).toEqual({ raw: { language: 'json' } });
  });

  it('restores disabled/unsupported bodies, descriptions, settings and examples', () => {
    const source = collectionOf([
      requestItem(
        {
          method: 'POST',
          url: 'http://x',
          body: { mode: 'raw', raw: '{}', disabled: true },
          description: { content: 'md **text**', type: 'text/markdown' },
        },
        {
          protocolProfileBehavior: { followRedirects: false, disableBodyPruning: true, strictSSL: false },
          response: [{ id: 'r1', name: 'ex', originalRequest: { method: 'POST', url: 'http://x' }, status: 'OK', code: 200, _postman_previewlanguage: 'json', header: [{ key: 'A', value: 'b' }], cookie: [], body: '{}', responseTime: 12 }],
        },
      ),
    ]);
    const out = exportAny(parsePostmanCollection(source).bundle).item[0]!;
    expect(out.request.body).toEqual({ mode: 'raw', raw: '{}', disabled: true });
    expect(out.request.description).toEqual({ content: 'md **text**', type: 'text/markdown' });
    expect(out.protocolProfileBehavior).toEqual({ followRedirects: false, strictSSL: false, disableBodyPruning: true });
    expect(out.response).toEqual([
      { id: 'r1', name: 'ex', originalRequest: { method: 'POST', url: 'http://x' }, status: 'OK', code: 200, _postman_previewlanguage: 'json', header: [{ key: 'A', value: 'b' }], cookie: [], body: '{}', responseTime: 12 },
    ]);
  });

  it('exports an unsafe (rejected) file reference as src: null', () => {
    const r = parsePostmanCollection(collectionOf([requestItem({ method: 'POST', url: 'http://x', body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file', src: '/etc/passwd' }] } })]));
    expect(exportAny(r.bundle).item[0]!.request.body.formdata).toEqual([{ key: 'f', type: 'file', src: null }]);
  });
});

describe('exportPostmanCollection: auth', () => {
  const authBundle = () =>
    bundleOf(
      [
        { name: 'inherit' },
        { name: 'none', auth: { type: 'none', params: {} } },
        { name: 'basic', auth: { type: 'basic', params: { username: 'u', password: 'hunter2' } } },
        { name: 'bearer ref', auth: { type: 'bearer', params: { token: '{{token}}' } } },
        { name: 'apikey', auth: { type: 'apikey', params: { key: 'X-Key', value: 'k-123', in: 'header' } } },
        { name: 'digest', auth: { type: 'custom', params: { providerId: 'digest', username: 'u', password: 'pw', realm: 'r' } } },
        { name: 'oauth2', auth: { type: 'oauth2', params: { grant_type: 'client_credentials', clientId: 'id', clientSecret: 'cs', accessToken: 'at', useBrowser: true } } },
      ],
      { auth: { type: 'bearer', params: { token: 'collection-token' } } },
    );

  it('omits auth for inherit, uses noauth for none and keeps value types', () => {
    const doc = exportAny(authBundle(), { includeSecrets: true });
    expect(exportItem(doc, 0).request).not.toHaveProperty('auth');
    expect(exportItem(doc, 1).request.auth).toEqual({ type: 'noauth' });
    expect(exportItem(doc, 2).request.auth).toEqual({
      type: 'basic',
      basic: [{ key: 'username', value: 'u', type: 'string' }, { key: 'password', value: 'hunter2', type: 'string' }],
    });
    expect(exportItem(doc, 6).request.auth.oauth2.find((e: any) => e.key === 'useBrowser')).toEqual({ key: 'useBrowser', value: true, type: 'boolean' });
    expect(doc.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: 'collection-token', type: 'string' }] });
  });

  it('omits collection-level none but writes folder-level none as noauth', () => {
    const bundle = bundleOf([], { items: [{ kind: 'folder', name: 'F', description: '', auth: { type: 'none', params: {} }, scripts: [], variables: [], metadata: {}, items: [] }] });
    const doc = exportAny(bundle);
    expect(doc).not.toHaveProperty('auth');
    expect(doc.item[0]!.auth).toEqual({ type: 'noauth' });
  });

  it('blanks credentials by default but keeps {{variable}} references', () => {
    const doc = exportAny(authBundle());
    const text = JSON.stringify(doc);
    for (const secret of ['hunter2', 'k-123', 'collection-token', '"pw"', '"cs"', '"at"']) expect(text).not.toContain(secret);
    expect(exportItem(doc, 2).request.auth.basic).toEqual([{ key: 'username', value: 'u', type: 'string' }, { key: 'password', value: '', type: 'string' }]);
    expect(exportItem(doc, 3).request.auth.bearer[0].value).toBe('{{token}}');
    expect(exportItem(doc, 4).request.auth.apikey.map((e: any) => e.value)).toEqual(['X-Key', '', 'header']);
    expect(exportItem(doc, 6).request.auth.oauth2.map((e: any) => [e.key, e.value])).toEqual([
      ['grant_type', 'client_credentials'], ['clientId', 'id'], ['clientSecret', ''], ['accessToken', ''], ['useBrowser', true],
    ]);
    expect(doc.auth.bearer[0].value).toBe('');
  });

  it('restores custom providers to their Postman type and blanks sensitive custom params', () => {
    const safe = exportAny(authBundle());
    expect(exportItem(safe, 5).request.auth).toEqual({
      type: 'digest',
      digest: [{ key: 'username', value: 'u', type: 'string' }, { key: 'password', value: '', type: 'string' }, { key: 'realm', value: 'r', type: 'string' }],
    });
    const full = exportAny(authBundle(), { includeSecrets: true });
    expect(exportItem(full, 5).request.auth.digest.find((e: any) => e.key === 'password').value).toBe('pw');
    expect(exportItem(full, 5).request.auth.digest.some((e: any) => e.key === 'providerId')).toBe(false);
  });

  it('blanks credentials inside saved-response request snapshots too', () => {
    const r = parsePostmanCollection(fixtureText('kitchen-sink.json'));
    const safe = JSON.stringify(exportAny(r.bundle));
    const full = JSON.stringify(exportAny(r.bundle, { includeSecrets: true }));
    expect(full).toContain('example-bearer-literal-6201');
    expect(safe).not.toContain('example-bearer-literal-6201');
  });
});

describe('exportPostmanCollection: variables and scripts', () => {
  it('blanks secret variables unless includeSecrets', () => {
    const bundle = bundleOf([], {
      variables: [
        { key: 'plain', initialValue: 'v', isSecret: false, enabled: true, description: 'd', type: 'string' },
        { key: 'sec', initialValue: 's3cr3t', isSecret: true, enabled: true },
        { key: 'off', initialValue: '1', isSecret: false, enabled: false },
      ],
    });
    expect(exportAny(bundle).variable).toEqual([
      { key: 'plain', value: 'v', type: 'string', description: 'd' },
      { key: 'sec', value: '', type: 'secret' },
      { key: 'off', value: '1', disabled: true },
    ]);
    expect(exportAny(bundle, { includeSecrets: true }).variable![1]).toEqual({ key: 'sec', value: 's3cr3t', type: 'secret' });
  });

  it('exports scripts as exec line arrays with listen type and disabled flag', () => {
    const doc = exportAny(
      bundleOf([{ scripts: [{ type: 'prerequest', language: 'javascript', source: 'a();\n\nb();', enabled: true }, { type: 'test', language: 'javascript', source: 'c();', enabled: false }] }]),
    );
    expect(exportItem(doc).event).toEqual([
      { listen: 'prerequest', script: { type: 'text/javascript', exec: ['a();', '', 'b();'] } },
      { listen: 'test', script: { type: 'text/javascript', exec: ['c();'] }, disabled: true },
    ]);
  });

  it('re-emits events that could not be mapped', () => {
    const source = collectionOf([requestItem({ method: 'GET', url: 'http://x' }, { event: [{ listen: 'beforeSend', script: { exec: ['x()'] } }, { listen: 'test', script: { id: 's1', type: 'text/javascript', exec: ['y()'] }, id: 'e1' }] })]);
    const out = exportAny(parsePostmanCollection(source).bundle).item[0]!;
    expect(out.event).toEqual([
      { id: 'e1', listen: 'test', script: { id: 's1', type: 'text/javascript', exec: ['y()'] } },
      { listen: 'beforeSend', script: { exec: ['x()'] } },
    ]);
    expect(validatePostmanV21Structure(exportAny(parsePostmanCollection(source).bundle))).toEqual(['item[0].event[1].listen: must be "prerequest" or "test"']);
  });
});

describe('validatePostmanV21Structure', () => {
  const valid = () => exportAny(parsePostmanCollection(fixtureText('kitchen-sink.json')).bundle, { includeSecrets: true });

  it('accepts exported documents', () => {
    expect(validatePostmanV21Structure(valid())).toEqual([]);
  });

  it('reports structural problems', () => {
    expect(validatePostmanV21Structure(null)).toEqual(['document: must be a JSON object']);
    expect(validatePostmanV21Structure({})).toEqual(expect.arrayContaining(['info: is required and must be an object', 'item: must be an array']));
    expect(validatePostmanV21Structure({ info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' }, item: [] })[0]).toMatch(/v2\.1\.0/);

    const doc = valid() as any;
    doc.item[0].item[0].request.method = '';
    doc.item[0].item[1].request.auth = { type: 'quantum', quantum: [] };
    doc.item[0].item[2].request.header = [{ key: 5, value: 'x' }];
    doc.item[0].item[3].event = [{ listen: 'sometimes', script: {} }];
    doc.item[0].item[4].request.body = { mode: 'raw' };
    doc.item[1].item[0].request.url = 42;
    doc.item[1].item[1].request.auth = { type: 'bearer', bearer: { token: 'object form' } };
    const problems = validatePostmanV21Structure(doc);
    expect(problems).toEqual(
      expect.arrayContaining([
        'item[0].item[0].request.method: must be a non-empty string',
        'item[0].item[1].request.auth.type: unknown auth type "quantum"',
        'item[0].item[2].request.header[0].key: must be a string',
        'item[0].item[3].event[0].listen: must be "prerequest" or "test"',
        'item[0].item[4].request.body.raw: must be a string',
        'item[1].item[0].request.url: must be a string or an object',
        'item[1].item[1].request.auth.bearer: must be an array of {key, value, type} in v2.1',
      ]),
    );
    expect(problems.some((p) => p.startsWith('item[0].item[3].event[0].script'))).toBe(true);
  });

  it('rejects items that are neither folders nor requests', () => {
    expect(validatePostmanV21Structure({ info: { name: 'x', schema: SCHEMA }, item: [{ name: 'broken' }, 7] })).toEqual([
      'item[0]: must have either "item" (folder) or "request"',
      'item[1]: must be an object',
    ]);
  });
});

describe('compareCollectionBundles', () => {
  const base = () => parsePostmanCollection(fixtureText('kitchen-sink.json')).bundle;

  it('returns no differences for equal bundles and ignores object key order', () => {
    const a = base();
    const b = base();
    const meta = requestAt(b.items, 1, 9).metadata;
    const reordered = Object.fromEntries(Object.entries(meta).reverse());
    requestAt(b.items, 1, 9).metadata = reordered;
    expect(compareCollectionBundles(a, b)).toEqual([]);
  });

  it('reports differences in names, structure, methods, urls, params, headers, bodies, auth, scripts, examples and variables', () => {
    const a = base();
    const b = base();
    b.name = 'Renamed';
    requestAt(b.items, 1, 0).method = 'POST';
    requestAt(b.items, 1, 0).url += '/x';
    requestAt(b.items, 1, 0).queryParams[4]!.enabled = true;
    requestAt(b.items, 1, 0).headers[1]!.enabled = true;
    requestAt(b.items, 1, 2).body.raw = '{}';
    requestAt(b.items, 0, 0).auth.params.password = 'other';
    requestAt(b.items, 1, 2).scripts[0]!.source += ' ';
    requestAt(b.items, 1, 1).examples[0]!.body = 'changed';
    b.variables[0]!.initialValue = 'changed';
    b.items.pop();
    const diffs = compareCollectionBundles(a, b).join('\n');
    for (const needle of ['name:', '.method:', '.url:', 'queryParams[4].enabled', 'headers[1].enabled', '.body.raw', 'auth.params.password', 'scripts[0].source', 'examples[0].body', 'variables[0].initialValue', 'items: length 8 !== 7']) {
      expect(diffs, needle).toContain(needle);
    }
  });

  it('ignores secrets only when asked to', () => {
    const a = base();
    const b = base();
    requestAt(b.items, 0, 0).auth.params.password = '';
    b.variables.find((v) => v.key === 'clientSecret')!.initialValue = '';
    expect(compareCollectionBundles(a, b)).not.toEqual([]);
    expect(compareCollectionBundles(a, b, { ignoreSecrets: true })).toEqual([]);
  });

  it('notices whitespace changes in scripts but not in JSON formatting', () => {
    const doc = JSON.parse(fixtureText('scripts.json'));
    const a = parsePostmanCollection(JSON.stringify(doc, null, 4)).bundle;
    const b = parsePostmanCollection(JSON.stringify(doc)).bundle;
    expect(compareCollectionBundles(a, b)).toEqual([]);
    doc.item[0].item[0].event[0].script.exec[0] += ' ';
    expect(compareCollectionBundles(a, parsePostmanCollection(doc).bundle)).not.toEqual([]);
  });
});
