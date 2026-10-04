import { describe, expect, it } from 'vitest';
import type { ImportProgress } from '@aegis/core';
import { extractPathVariableNames } from '@aegis/core';
import { parsePostmanCollection } from '@aegis/postman';
import { collectionOf, fixtureJson, fixtureText, folderAt, requestAt, requestItem } from './_postman-fixtures';

const load = (name: string) => parsePostmanCollection(fixtureText(name));
const loadDoc = (doc: unknown) => parsePostmanCollection(doc as object);

describe('Postman import: methods and bodies', () => {
  it('imports a simple GET', () => {
    const r = load('get-simple.json');
    expect(r.format).toBe('collection-v2.1');
    expect(r.bundle.name).toBe('Get simple');
    expect(r.bundle.postmanSchemaVersion).toBe('2.1.0');
    expect(r.bundle.uid).toBeDefined();
    expect(r.bundle.auth).toEqual({ type: 'none', params: {} });
    const req = requestAt(r.bundle.items, 0);
    expect(req).toMatchObject({ method: 'GET', url: 'https://api.example.com/v1/status', description: 'Returns the service status.' });
    expect(req.auth).toEqual({ type: 'inherit', params: {} });
    expect(req.body).toEqual({ mode: 'none' });
    expect(r.stats).toEqual({ folders: 0, requests: 1, variables: 0, scripts: 0, examples: 0 });
  });

  it('imports a JSON POST with script and collection variable', () => {
    const r = load('post-json.json');
    const req = requestAt(r.bundle.items, 0);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('{{baseUrl}}/customers');
    expect(req.body.mode).toBe('raw');
    expect(req.body.rawLanguage).toBe('json');
    expect(JSON.parse(req.body.raw!)).toMatchObject({ name: 'Ada Lovelace', tags: ['vip', 'beta'] });
    expect(req.headers.map((h) => h.key)).toEqual(['Content-Type', 'Accept']);
    expect(req.scripts).toHaveLength(1);
    expect(req.scripts[0]).toMatchObject({ type: 'test', language: 'javascript', enabled: true });
    expect(req.scripts[0]!.source).toBe('pm.test("status is 201", function () {\n    pm.response.to.have.status(201);\n});');
    expect(r.bundle.variables).toEqual([{ key: 'baseUrl', initialValue: 'https://api.example.com/v1', isSecret: false, enabled: true, type: 'string' }]);
  });

  it('imports PUT with a path variable', () => {
    const req = requestAt(load('put-update.json').bundle.items, 0);
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('{{baseUrl}}/customers/:customerId');
    expect(req.pathVariables).toEqual([{ key: 'customerId', value: '1042', description: 'Customer identifier', enabled: true }]);
    expect(extractPathVariableNames(req.url)).toEqual(['customerId']);
  });

  it('imports PATCH and DELETE', () => {
    const patch = requestAt(load('patch-partial.json').bundle.items, 0);
    expect(patch.method).toBe('PATCH');
    expect(patch.body.rawLanguage).toBe('json');
    const del = load('delete-resource.json');
    const req = requestAt(del.bundle.items, 0);
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('{{baseUrl}}/customers/1042');
    expect(req.queryParams).toEqual([{ key: 'hard', value: 'true', enabled: true }]);
    expect(req.examples).toHaveLength(1);
    expect(req.examples[0]).toMatchObject({ name: 'Deleted', code: 204, status: 'No Content', body: '' });
  });

  it('imports raw bodies of every supported language and keeps unknown ones as text with the original in metadata', () => {
    const doc = collectionOf([
      requestItem({ method: 'POST', url: 'http://x', body: { mode: 'raw', raw: '<a/>', options: { raw: { language: 'xml' } } } }),
      requestItem({ method: 'POST', url: 'http://x', body: { mode: 'raw', raw: 'a: 1', options: { raw: { language: 'yaml' } } } }),
      requestItem({ method: 'POST', url: 'http://x', body: { mode: 'raw', raw: 'plain' } }),
    ]);
    const r = loadDoc(doc);
    expect(requestAt(r.bundle.items, 0).body).toEqual({ mode: 'raw', raw: '<a/>', rawLanguage: 'xml' });
    const yaml = requestAt(r.bundle.items, 1);
    expect(yaml.body.rawLanguage).toBe('text');
    expect(yaml.metadata.bodyOptions).toEqual({ raw: { language: 'yaml' } });
    expect(r.warnings.some((w) => w.severity === 'INFO' && w.path === 'item[1].request.body.options.raw.language')).toBe(true);
    expect(requestAt(r.bundle.items, 2).body).toEqual({ mode: 'raw', raw: 'plain' });
  });

  it('imports form-data with text, file, content type and disabled entries', () => {
    const r = load('formdata.json');
    const body = requestAt(r.bundle.items, 0).body;
    expect(body.mode).toBe('formdata');
    expect(body.formData).toEqual([
      { key: 'caption', type: 'text', value: 'Profile photo', contentType: 'text/plain', description: 'Shown under the picture', enabled: true },
      { key: 'avatar', type: 'file', value: '', filePath: 'files/avatar.png', contentType: 'image/png', enabled: true },
      { key: 'draft', type: 'text', value: 'true', enabled: false },
      { key: 'attachment', type: 'file', value: '', enabled: true },
    ]);
    expect(r.warnings.filter((w) => w.severity !== 'INFO')).toEqual([]);
  });

  it('imports urlencoded and binary bodies', () => {
    const enc = requestAt(load('urlencoded.json').bundle.items, 0).body;
    expect(enc.mode).toBe('urlencoded');
    expect(enc.urlencoded).toEqual([
      { key: 'grant_type', value: 'client_credentials', enabled: true },
      { key: 'scope', value: 'read write', description: 'Space separated', enabled: true },
      { key: 'audience', value: 'https://api.example.com/', enabled: false },
    ]);
    expect(requestAt(load('binary.json').bundle.items, 0).body).toEqual({ mode: 'binary', filePath: 'files/report.pdf' });
  });

  it('keeps unsupported body modes and disabled bodies in metadata', () => {
    const r = loadDoc(
      collectionOf([
        requestItem({ method: 'POST', url: 'http://x', body: { mode: 'hologram', hologram: { a: 1 } } }),
        requestItem({ method: 'POST', url: 'http://x', body: { mode: 'raw', raw: '{}', disabled: true } }),
        requestItem({ method: 'POST', url: 'http://x', body: { mode: 'raw', raw: 'x', xtra: 1 } }),
      ]),
    );
    const unknown = requestAt(r.bundle.items, 0);
    expect(unknown.body.mode).toBe('none');
    expect(unknown.metadata.bodyOriginal).toEqual({ mode: 'hologram', hologram: { a: 1 } });
    expect(requestAt(r.bundle.items, 1).metadata.bodyOriginal).toEqual({ mode: 'raw', raw: '{}', disabled: true });
    expect(requestAt(r.bundle.items, 2).metadata.bodyExtra).toEqual({ xtra: 1 });
    expect(r.warnings.filter((w) => w.severity === 'WARNING').length).toBeGreaterThanOrEqual(3);
  });
});

describe('Postman import: URLs, headers and parameters', () => {
  it('imports headers including disabled ones and descriptions', () => {
    const h = requestAt(load('headers.json').bundle.items, 0).headers;
    expect(h).toHaveLength(5);
    expect(h[1]).toEqual({ key: 'X-Trace-Id', value: '{{traceId}}', description: 'Correlation id', enabled: true });
    expect(h[2]).toEqual({ key: 'X-Debug', value: 'true', enabled: false });
    expect(h[4]).toMatchObject({ key: 'Cache-Control', enabled: false, description: 'Turned off while testing' });
  });

  it('stores URLs without the query and keeps every parameter verbatim, including disabled ones', () => {
    const req = requestAt(load('query-params.json').bundle.items, 0);
    expect(req.url).toBe('https://api.example.com/v1/search');
    expect(req.queryParams).toEqual([
      { key: 'q', value: '{{term}}', description: 'Free text query', enabled: true },
      { key: 'page', value: '2', enabled: true },
      { key: 'sort', value: 'name%20asc', enabled: true },
      { key: 'debug', value: '1', enabled: false },
    ]);
  });

  it('keeps :pathVars and {{vars}} in the URL verbatim', () => {
    const r = load('path-variables.json');
    const a = requestAt(r.bundle.items, 0);
    expect(a.url).toBe('https://api.example.com/v1/users/:userId/orders/{{orderId}}/lines/:lineNo');
    expect(a.pathVariables.map((v) => [v.key, v.value])).toEqual([['userId', '42'], ['lineNo', '3']]);
    expect(extractPathVariableNames(a.url)).toEqual(['userId', 'lineNo']);
    const b = requestAt(r.bundle.items, 1);
    expect(b.url).toBe('{{scheme}}://{{host}}:8443/api/:version/ping');
  });

  it('accepts a URL string with query and fragment, keeping the fragment in metadata', () => {
    const r = loadDoc(collectionOf([requestItem({ method: 'GET', url: 'https://x.test/a?b=1&c=%7B%7Bv%7D%7D&flag#section-2' })]));
    const req = requestAt(r.bundle.items, 0);
    expect(req.url).toBe('https://x.test/a');
    expect(req.queryParams).toEqual([
      { key: 'b', value: '1', enabled: true },
      { key: 'c', value: '%7B%7Bv%7D%7D', enabled: true },
      { key: 'flag', value: '', enabled: true },
    ]);
    expect(req.metadata.urlHash).toBe('#section-2');
  });

  it('rebuilds the URL from parts when raw is missing and keeps unknown url fields', () => {
    const r = loadDoc(
      collectionOf([requestItem({ method: 'GET', url: { protocol: 'https', host: ['api', 'example', 'com'], port: '8443', path: ['v1', 'items', ':id'], query: [{ key: 'a', value: null }], variable: [{ key: 'id', value: '7' }], 'x-url-flag': 1 } })]),
    );
    const req = requestAt(r.bundle.items, 0);
    expect(req.url).toBe('https://api.example.com:8443/v1/items/:id');
    expect(req.queryParams).toEqual([{ key: 'a', value: '', enabled: true }]);
    expect(req.pathVariables).toEqual([{ key: 'id', value: '7', enabled: true }]);
    expect(req.metadata.urlExtras).toEqual({ 'x-url-flag': 1 });
  });

  it('defaults the method to GET and accepts the v2.0 URL-string request shorthand', () => {
    const r = loadDoc(collectionOf([{ name: 'short', request: 'https://x.test/ping' }, requestItem({ url: 'https://x.test/nomethod' })]));
    expect(requestAt(r.bundle.items, 0)).toMatchObject({ method: 'GET', url: 'https://x.test/ping' });
    expect(requestAt(r.bundle.items, 1).method).toBe('GET');
  });
});

describe('Postman import: authentication', () => {
  it('imports basic, bearer and api key auth with Postman parameter names', () => {
    expect(requestAt(load('auth-basic.json').bundle.items, 0).auth).toEqual({ type: 'basic', params: { username: 'svc-reporting', password: 'basic-pass-literal-91' } });
    const bearer = load('auth-bearer.json');
    expect(requestAt(bearer.bundle.items, 0).auth.params).toEqual({ token: 'eyJhbGciOiJIUzI1NiJ9.literal-bearer-token' });
    expect(requestAt(bearer.bundle.items, 1).auth.params).toEqual({ token: '{{accessToken}}' });
    const key = load('auth-apikey.json');
    expect(requestAt(key.bundle.items, 0).auth).toEqual({ type: 'apikey', params: { key: 'X-API-Key', value: 'apikey-header-literal-7731', in: 'header' } });
    expect(requestAt(key.bundle.items, 1).auth.params.in).toBe('query');
  });

  it('imports OAuth 2.0 (PKCE and client credentials), preserving booleans and structured parameters', () => {
    const r = load('auth-oauth2.json');
    const pkce = requestAt(r.bundle.items, 0).auth;
    expect(pkce.type).toBe('oauth2');
    expect(pkce.params).toMatchObject({
      grant_type: 'authorization_code_with_pkce',
      accessTokenUrl: 'https://auth.example.com/oauth/token',
      authUrl: 'https://auth.example.com/oauth/authorize',
      clientId: 'aegis-desktop',
      redirect_uri: 'https://oauth.pstmn.io/v1/callback',
      client_authentication: 'body',
      useBrowser: false,
      refreshRequestParams: '[]',
    });
    expect(JSON.parse(String(pkce.params.tokenRequestParams))).toEqual([{ key: 'audience', value: 'api', enabled: true, send_as: 'request_body' }]);
    const cc = requestAt(r.bundle.items, 1).auth;
    expect(cc.params).toMatchObject({ grant_type: 'client_credentials', clientSecret: 'oauth-client-secret-literal-3318', accessToken: '{{reportsToken}}' });
  });

  it('applies the inheritance rules: collection none, folder/request inherit, noauth => none', () => {
    const r = load('collection-auth-inherit.json');
    expect(r.bundle.auth).toEqual({ type: 'bearer', params: { token: '{{accessToken}}' } });
    expect(requestAt(r.bundle.items, 0).auth.type).toBe('inherit');
    const reports = folderAt(r.bundle.items, 1);
    expect(reports.auth).toEqual({ type: 'bearer', params: { token: '{{reportsToken}}' } });
    expect((reports.items[0] as { request: { auth: { type: string } } }).request.auth.type).toBe('inherit');
    expect(requestAt(r.bundle.items, 1, 1).auth).toEqual({ type: 'basic', params: { username: 'reporter', password: '{{reporterPassword}}' } });
    expect(requestAt(r.bundle.items, 1, 2).auth).toEqual({ type: 'none', params: {} });
    expect(folderAt(r.bundle.items, 1, 3).auth.type).toBe('inherit');
    expect(folderAt(r.bundle.items, 2).auth.type).toBe('none');
    expect(r.stats.scripts).toBe(1);
  });

  it('maps unsupported auth types to custom with providerId and warns', () => {
    const r = load('kitchen-sink.json');
    const digest = requestAt(r.bundle.items, 6, 1).auth;
    expect(digest.type).toBe('custom');
    expect(digest.params).toMatchObject({ providerId: 'digest', username: 'admin', realm: 'metrics', algorithm: 'MD5' });
    expect(requestAt(r.bundle.items, 6, 2).auth.params).toMatchObject({ providerId: 'hawk', authId: 'dh37fgj492je' });
    expect(requestAt(r.bundle.items, 6, 3).auth.params.providerId).toBe('ntlm');
    const warned = r.warnings.filter((w) => w.severity === 'WARNING' && /not natively supported/.test(w.message)).map((w) => w.path);
    expect(warned).toEqual(['item[6].item[1].request.auth', 'item[6].item[2].request.auth', 'item[6].item[3].request.auth']);
    expect(requestAt(r.bundle.items, 6, 4).auth.type).toBe('jwt');
    expect(requestAt(r.bundle.items, 6, 5).auth.type).toBe('oauth1');
    expect(requestAt(r.bundle.items, 3, 5).auth.type).toBe('awsv4');
  });

  it('imports the v2.0 object form of auth parameters', () => {
    const r = load('collection-v2.0.json');
    expect(r.bundle.auth).toEqual({ type: 'bearer', params: { token: '{{legacyToken}}' } });
    expect(requestAt(r.bundle.items, 1).auth).toEqual({ type: 'bearer', params: { token: 'legacy-v2-bearer-literal' } });
    expect(folderAt(r.bundle.items, 2).auth).toEqual({ type: 'basic', params: { username: 'legacy', password: '{{legacyPassword}}' } });
    expect(requestAt(r.bundle.items, 2, 1).auth).toEqual({ type: 'apikey', params: { key: 'X-Key', value: '{{legacyKey}}', in: 'header' } });
  });
});

describe('Postman import: variables, scripts, examples, folders', () => {
  it('imports collection variables including secret and disabled ones', () => {
    const r = load('collection-variables.json');
    const byKey = Object.fromEntries(r.bundle.variables.map((v) => [v.key, v]));
    expect(r.bundle.variables).toHaveLength(6);
    expect(byKey.apiKey).toMatchObject({ isSecret: true, initialValue: 'secret-variable-literal-8842', type: 'secret', enabled: true });
    expect(byKey.legacyFlag).toMatchObject({ enabled: false, initialValue: 'off' });
    expect(byKey.retries).toMatchObject({ type: 'number', initialValue: '3', isSecret: false });
    expect(byKey.baseUrl!.description).toBe('Base URL');
    expect(byKey.noType!.type).toBeUndefined();
    expect(r.stats.variables).toBe(6);
  });

  it('imports collection, folder and request scripts with their enabled flags', () => {
    const r = load('scripts.json');
    expect(r.bundle.scripts.map((s) => s.type)).toEqual(['prerequest', 'test']);
    expect(r.bundle.scripts[0]!.source).toBe('// collection prerequest\npm.globals.set("run", "1");');
    const folder = folderAt(r.bundle.items, 0);
    expect(folder.scripts.map((s) => s.type)).toEqual(['prerequest', 'test']);
    const req = requestAt(r.bundle.items, 0, 0);
    expect(req.scripts).toHaveLength(3);
    expect(req.scripts[0]!.source).toContain('\n\n// blank line above and trailing spaces below   \n');
    expect(req.scripts[2]).toMatchObject({ type: 'test', enabled: false, source: 'pm.test("disabled");' });
    expect(r.stats.scripts).toBe(7);
  });

  it('accepts exec as a plain string (v2.0)', () => {
    const r = load('collection-v2.0.json');
    expect(r.bundle.scripts).toEqual([{ type: 'prerequest', language: 'javascript', source: 'console.log("legacy exec as string");', enabled: true }]);
  });

  it('imports saved responses as examples', () => {
    const r = load('examples.json');
    const examples = requestAt(r.bundle.items, 0).examples;
    expect(examples).toHaveLength(3);
    expect(examples[0]).toMatchObject({ name: 'OK', status: 'OK', code: 200, language: 'json' });
    expect(examples[0]!.headers).toEqual([
      { key: 'Content-Type', value: 'application/json; charset=utf-8', enabled: true },
      { key: 'X-RateLimit-Remaining', value: '59', enabled: true },
    ]);
    expect(examples[0]!.body).toBe('{\n  "id": 1042,\n  "name": "Ada Lovelace"\n}');
    expect(examples[0]!.originalRequest).toMatchObject({ method: 'GET' });
    expect(examples[0]!.metadata).toMatchObject({ id: expect.any(String), responseTime: null });
    expect((examples[0]!.metadata!.cookie as unknown[])).toHaveLength(1);
    expect(examples[1]).toMatchObject({ code: 404, language: 'html' });
    expect(examples[2]!.headers.map((h) => [h.key, h.value])).toEqual([['Content-Type', 'text/plain'], ['Retry-After', '30']]);
    expect(r.stats.examples).toBe(3);
  });

  it('imports deeply nested folders in order', () => {
    const r = load('nested-folders.json');
    expect(r.bundle.items.map((i) => (i.kind === 'folder' ? i.name : i.request.name))).toEqual(['Root request', 'Level 1', 'Sibling']);
    const l1 = folderAt(r.bundle.items, 1);
    expect(l1.description).toBe('# Level one\nMarkdown *description*');
    expect(l1.metadata._descriptionType).toBe('text/markdown');
    expect(l1.items.map((i) => (i.kind === 'folder' ? i.name : i.request.name))).toEqual(['Level 2 A', 'Level 2 B (empty)', 'Level 1 request']);
    const l4 = folderAt(r.bundle.items, 1, 0, 0, 0);
    expect(l4.name).toBe('Level 4');
    expect(l4.description).toBe('Four levels down');
    expect(requestAt(r.bundle.items, 1, 0, 0, 0, 0).url).toBe('https://api.example.com/deep');
    expect(requestAt(r.bundle.items, 1, 0, 0, 1).body).toEqual({ mode: 'raw', raw: 'plain text body', rawLanguage: 'text' });
    expect(folderAt(r.bundle.items, 1, 1).items).toEqual([]);
    expect(r.stats).toMatchObject({ folders: 6, requests: 6 });
  });
});

describe('Postman import: v2.0', () => {
  it('imports a v2.0 collection', () => {
    const r = load('collection-v2.0.json');
    expect(r.format).toBe('collection-v2.0');
    expect(r.bundle.postmanSchemaVersion).toBe('2.0.0');
    expect(requestAt(r.bundle.items, 0)).toMatchObject({ name: 'Plain URL shorthand', method: 'GET', url: 'https://api.example.com/v2/ping' });
    const second = requestAt(r.bundle.items, 1);
    expect(second.headers.map((h) => [h.key, h.value])).toEqual([['Content-Type', 'application/json'], ['X-Legacy', 'yes']]);
    expect(second.url).toBe('https://api.example.com/v2/items');
    expect(second.queryParams.map((q) => q.key)).toEqual(['limit', 'offset']);
    expect(second.description).toBe('v2.0 style request');
    expect(r.warnings.some((w) => w.severity === 'INFO' && /v2\.0/.test(w.message))).toBe(true);
  });

  it('treats a collection without a schema as v2.1 and says so', () => {
    const doc = collectionOf([]);
    delete (doc.info as Record<string, unknown>).schema;
    const r = loadDoc(doc);
    expect(r.format).toBe('collection-v2.1');
    expect(r.warnings).toContainEqual(expect.objectContaining({ severity: 'INFO', path: 'info.schema' }));
  });
});

describe('Postman import: unknown data is preserved and reported', () => {
  it('keeps unknown item, request, folder and top-level fields in metadata and warns', () => {
    const r = load('kitchen-sink.json');
    const notes = requestAt(r.bundle.items, 1, 9);
    expect(notes.metadata.itemExtras).toEqual({ 'x-custom': { owner: 'support-team', tier: 2, tags: ['crm', 'notes'] } });
    expect(notes.metadata.requestExtras).toEqual({ 'x-request-flag': true });
    expect(folderAt(r.bundle.items, 1).metadata.itemExtras).toEqual({ 'x-custom': { reviewed: true } });
    expect(r.bundle.sourceMetadata.extra).toEqual({ 'x-aegis-owner': { team: 'platform', contacts: ['a@example.com'] }, _postman_note: 'preserved top-level extra' });
    expect(r.bundle.sourceMetadata.info).toEqual({ _exporter_id: '29184071', version: { major: 3, minor: 2, patch: 1 } });
    expect(r.bundle.sourceMetadata.protocolProfileBehavior).toEqual({ followRedirects: true, maxRedirects: 10 });
    const paths = r.warnings.filter((w) => w.severity === 'WARNING').map((w) => w.path);
    expect(paths).toContain('item[1].item[9].x-custom');
    expect(paths).toContain('item[1].item[9].request.x-request-flag');
    expect(paths).toContain('x-aegis-owner');
  });

  it('imports GraphQL bodies as raw JSON, warns, and remembers the original', () => {
    const r = load('kitchen-sink.json');
    const gql = requestAt(r.bundle.items, 5, 0);
    expect(gql.body.mode).toBe('raw');
    expect(gql.body.rawLanguage).toBe('json');
    expect(JSON.parse(gql.body.raw!)).toMatchObject({ query: expect.stringContaining('query Customer'), variables: { id: '1042' } });
    expect(gql.metadata.originalBodyMode).toBe('graphql');
    expect(r.warnings.filter((w) => w.severity === 'WARNING' && w.path === 'item[5].item[0].request.body.graphql')).toHaveLength(1);
  });

  it('does not fetch external scripts, keeping the event in metadata with a warning', () => {
    const r = load('kitchen-sink.json');
    const req = requestAt(r.bundle.items, 6, 6);
    expect(req.scripts).toHaveLength(1);
    expect(req.scripts[0]!.type).toBe('test');
    expect(req.metadata.eventExtras).toEqual([expect.objectContaining({ listen: 'prerequest', script: expect.objectContaining({ src: 'https://scripts.example.com/helpers.js' }) })]);
    expect(r.warnings).toContainEqual(expect.objectContaining({ severity: 'WARNING', path: 'item[6].item[6].event[0]', message: expect.stringContaining('External script') }));
  });

  it('keeps unknown event types and non-JavaScript script types', () => {
    const r = loadDoc(
      collectionOf([
        requestItem(
          { method: 'GET', url: 'http://x' },
          { event: [{ listen: 'beforeSend', script: { exec: ['x()'] } }, { listen: 'test', script: { type: 'text/x-lua', exec: ['y()'] } }] },
        ),
      ]),
    );
    const req = requestAt(r.bundle.items, 0);
    expect(req.metadata.eventExtras).toEqual([{ listen: 'beforeSend', script: { exec: ['x()'] } }]);
    expect(req.scripts).toHaveLength(1);
    expect(req.metadata.scriptExtras).toEqual([{ script: { type: 'text/x-lua' } }]);
    expect(r.warnings.filter((w) => w.severity === 'WARNING').map((w) => w.path)).toEqual(expect.arrayContaining(['item[0].event[0]', 'item[0].event[1].script.type']));
  });

  it('keeps protocolProfileBehavior settings and unmapped keys', () => {
    const r = load('kitchen-sink.json');
    expect(requestAt(r.bundle.items, 1, 3).settings).toEqual({ followRedirects: false, maxRedirects: 3 });
    const del = requestAt(r.bundle.items, 1, 5);
    expect(del.settings).toEqual({ verifyTls: false });
    expect(del.metadata.protocolProfileBehavior).toEqual({ disableBodyPruning: true });
  });

  it('keeps description object types and item-level descriptions', () => {
    const r = load('kitchen-sink.json');
    expect(r.bundle.description).toBe('# Customer API\nA realistic collection used as an import/export fixture.');
    expect(r.bundle.sourceMetadata._descriptionType).toBe('text/markdown');
    expect(requestAt(r.bundle.items, 0, 0).metadata._descriptionType).toBe('text/markdown');
    const about = requestAt(r.bundle.items, 6, 7);
    expect(about.description).toBe('Description stored on the item instead of the request.');
    expect(about.metadata._descriptionAt).toBe('item');
  });

  it('keeps the Postman item id and folder variables', () => {
    const r = load('kitchen-sink.json');
    expect(requestAt(r.bundle.items, 0, 4).metadata.postmanId).toBe(fixtureJson('kitchen-sink.json').item[0].item[4].id);
    const verification = folderAt(r.bundle.items, 1, 10, 3);
    expect(verification.variables.map((v) => [v.key, v.isSecret])).toEqual([['verifyRegion', false], ['verifyKey', true]]);
  });

  it('imports the Customer API kitchen sink with realistic statistics and no errors', () => {
    const r = load('kitchen-sink.json');
    expect(r.stats).toEqual({ folders: 9, requests: 47, variables: 9, scripts: 8, examples: 3 });
    expect(r.warnings.filter((w) => w.severity === 'ERROR')).toEqual([]);
    expect(r.bundle.variables.find((v) => v.key === 'clientSecret')).toMatchObject({ isSecret: true });
    expect(r.bundle.variables.find((v) => v.key === 'etag')).toMatchObject({ enabled: false });
  });

  it('skips items that are neither folders nor requests, with a warning', () => {
    const r = loadDoc(collectionOf([{ name: 'empty shell' }, 'garbage', requestItem({ method: 'GET', url: 'http://x' })]));
    expect(r.bundle.items).toHaveLength(1);
    expect(r.warnings.filter((w) => w.severity === 'WARNING').map((w) => w.path)).toEqual(['item[0]', 'item[1]']);
  });
});

describe('Postman import: pipeline', () => {
  it('reports progress through every stage and periodically while importing', () => {
    const items = Array.from({ length: 120 }, (_, i) => requestItem({ method: 'GET', url: `http://x/${i}` }));
    const events: ImportProgress[] = [];
    parsePostmanCollection(JSON.stringify(collectionOf(items)), { onProgress: (p) => events.push({ ...p }) });
    const stages = events.map((e) => e.stage);
    expect(stages[0]).toBe('Parsing');
    expect(stages.at(-1)).toBe('Finalizing');
    expect(['Parsing', 'Validating', 'Importing', 'Finalizing'].every((s) => stages.includes(s as ImportProgress['stage']))).toBe(true);
    const importing = events.filter((e) => e.stage === 'Importing');
    expect(importing.every((e) => e.total === 120)).toBe(true);
    expect(importing.map((e) => e.current)).toEqual(expect.arrayContaining([0, 50, 100, 120]));
    const currents = importing.map((e) => e.current);
    expect([...currents].sort((a, b) => a - b)).toEqual(currents);
    // stages never go backwards
    const order = ['Parsing', 'Validating', 'Importing', 'Finalizing'];
    const idx = stages.map((s) => order.indexOf(s));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('accepts an already parsed object as well as text', () => {
    const doc = fixtureJson('get-simple.json');
    expect(parsePostmanCollection(doc).bundle).toEqual(parsePostmanCollection(JSON.stringify(doc)).bundle);
  });

  it('strips a UTF-8 BOM', () => {
    expect(parsePostmanCollection(`﻿${fixtureText('get-simple.json')}`).bundle.name).toBe('Get simple');
  });

  it('records JSON-path style locations in warnings', () => {
    const r = load('kitchen-sink.json');
    for (const w of r.warnings) expect(w.path).toMatch(/^(item\[\d+\]|info|event\[\d+\]|variable|auth|[\w-]+)/);
    expect(r.warnings.some((w) => /^item\[\d+\]\.item\[\d+\]\.request\./.test(w.path))).toBe(true);
  });
});
