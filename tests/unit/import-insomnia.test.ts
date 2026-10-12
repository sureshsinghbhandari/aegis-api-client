import { describe, expect, it } from 'vitest';
import { WarningCollector, convertInsomniaTemplate, importDocument, parseInsomnia } from '@aegis/postman';
import { folderAt, requestAt } from './_postman-fixtures';
import { expectRoundTrip, failure, formatFixtureText, ownKeysDeep } from './_format-fixtures';

const text = formatFixtureText('insomnia', 'workspace-export.json');
const r = parseInsomnia(text);
const api = r.collections[0]!;
const auth = folderAt(api.items, 0);
const users = folderAt(api.items, 1);
const admin = folderAt(users.items, 3);

function groupChain(depth: number): object {
  const resources: object[] = [{ _id: 'wrk', _type: 'workspace', name: 'W' }];
  let parent = 'wrk';
  for (let i = 0; i < depth; i++) {
    resources.push({ _id: `g${i}`, _type: 'request_group', parentId: parent, name: `G${i}` });
    parent = `g${i}`;
  }
  resources.push({ _id: 'leaf', _type: 'request', parentId: parent, name: 'leaf', method: 'GET', url: 'https://x/' });
  return { _type: 'export', __export_format: 4, resources };
}

describe('Insomnia import: workspace tree', () => {
  it('maps the workspace to a collection and sorts siblings by metaSortKey', () => {
    expect(r.format).toBe('insomnia-v4');
    expect(r.collections).toHaveLength(1);
    expect(api.name).toBe('Customer API');
    expect(api.description).toBe('Insomnia workspace used as an import fixture.');
    expect(api.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name))).toEqual([
      'folder:Auth',
      'folder:Users',
      'GraphQL users',
      'Upload raw report',
      'Fetch S3 report',
      'Status (auth disabled)',
    ]);
    expect(users.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name))).toEqual(['List users', 'Create user', 'Upload avatar', 'folder:Admin']);
    expect(admin.description).toBe('Needs the admin scope');
    expect(r.stats).toEqual({ folders: 3, requests: 9, variables: 12, scripts: 4, examples: 0 });
  });

  it('turns the base environment into collection variables and request_group environments into folder variables', () => {
    expect(api.variables).toEqual([
      { key: 'base_url', initialValue: 'https://api.example.com/v1', isSecret: false, enabled: true },
      { key: 'access_token', initialValue: 'basetoken-literal-01', isSecret: true, enabled: true, type: 'secret' },
      { key: 'tags', initialValue: '["a","b"]', isSecret: false, enabled: true },
      { key: 'api.version', initialValue: 'v1', isSecret: false, enabled: true },
      { key: 'api.timeout', initialValue: '30', isSecret: false, enabled: true },
    ]);
    expect(auth.variables).toEqual([{ key: 'grant', initialValue: 'client_credentials', isSecret: false, enabled: true }]);
    expect(r.warnings.some((w) => w.severity === 'INFO' && w.path === 'resources[1].data.tags' && /JSON text/.test(w.message))).toBe(true);
  });

  it('exports sub-environments as environment bundles', () => {
    expect(r.environments.map((e) => e.name)).toEqual(['Production', 'Staging']);
    expect(r.environments[0]!.variables).toEqual([
      { key: 'base_url', initialValue: 'https://api.example.com/v1', isSecret: false, enabled: true },
      { key: 'client_secret', initialValue: 'prod-secret-literal-02', isSecret: true, enabled: true, type: 'secret' },
      { key: 'email', initialValue: 'ops@example.com', isSecret: false, enabled: true },
    ]);
    expect(r.environments[1]!.variables.map((v) => [v.key, v.initialValue])).toEqual([
      ['base_url', 'https://staging.example.com/v1'],
      ['email', 'qa@example.com'],
      ['nested.feature.flag', 'true'],
    ]);
    expect(r.warnings.some((w) => w.path === 'resources[3].isPrivate' && w.severity === 'INFO')).toBe(true);
  });

  it('reports unsupported resource types and the cookie jar', () => {
    const messages = r.warnings.filter((w) => w.severity === 'WARNING').map((w) => w.message);
    expect(messages.some((m) => /Embedded OpenAPI document not imported/.test(m))).toBe(true);
    expect(messages.some((m) => /unit test suite not imported/.test(m))).toBe(true);
    expect(messages.some((m) => /WebSocket requests are not supported/.test(m))).toBe(true);
    expect(r.warnings.some((w) => w.severity === 'INFO' && /1 cookie\(s\) of the Insomnia cookie jar/.test(w.message))).toBe(true);
  });
});

describe('Insomnia import: requests', () => {
  it('converts templates, URL queries, parameters, headers and settings', () => {
    const list = requestAt(users.items, 0);
    expect(list.method).toBe('GET');
    expect(list.url).toBe('{{base_url}}/users');
    expect(list.queryParams).toEqual([
      { key: 'page', value: '1', enabled: true },
      { key: 'limit', value: '20', enabled: true },
      { key: 'sort', value: 'name', description: 'Sort field', enabled: false },
    ]);
    expect(list.headers).toEqual([
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Trace', value: "{{ _.trace_id | default('none') }}", enabled: true },
    ]);
    expect(list.settings).toEqual({ followRedirects: false });
    expect(list.auth).toEqual({ type: 'inherit', params: {} });
    expect(r.warnings.some((w) => w.path === 'resources[9].headers[1].value' && /template filter/.test(w.message))).toBe(true);
    expect(r.warnings.some((w) => w.severity === 'INFO' && w.path === 'resources[9].settingSendCookies')).toBe(true);
  });

  it('maps bodies: urlencoded, JSON text (adds Content-Type), multipart with validated files, GraphQL and binary', () => {
    const token = requestAt(auth.items, 0);
    expect(token.body).toEqual({
      mode: 'urlencoded',
      urlencoded: [
        { key: 'grant_type', value: '{{grant}}', enabled: true },
        { key: 'scope', value: 'read write', enabled: true },
        { key: 'audience', value: 'https://api.example.com/', enabled: false },
      ],
    });
    const create = requestAt(users.items, 1);
    expect(create.url).toBe('{{base_url}}/users');
    expect(create.body).toEqual({ mode: 'raw', raw: '{\n  "name": "Ada",\n  "email": "{{email}}"\n}', rawLanguage: 'json' });
    expect(create.headers).toEqual([{ key: 'Content-Type', value: 'application/json', enabled: true }]);
    const upload = requestAt(users.items, 2);
    expect(upload.body.formData).toEqual([
      { key: 'file', type: 'file', value: '', enabled: true },
      { key: 'caption', type: 'text', value: 'Hi there', description: 'Shown under the picture', enabled: true },
      { key: 'rel', type: 'file', value: '', filePath: 'files/avatar.png', enabled: true },
    ]);
    expect(r.warnings.some((w) => w.path === 'resources[12].body.params[0].fileName' && /absolute path/.test(w.message))).toBe(true);
    const graphql = requestAt(api.items, 2);
    expect(graphql.body).toEqual({ mode: 'raw', raw: '{"query":"query Users($first: Int) { users(first: $first) { id name } }","variables":{"first":5}}', rawLanguage: 'json' });
    expect(graphql.metadata).toEqual({ originalBodyMode: 'graphql', graphqlBody: { query: 'query Users($first: Int) { users(first: $first) { id name } }', variables: '{"first":5}', operationName: 'Users' } });
    expect(graphql.headers).toEqual([{ key: 'Content-Type', value: 'application/json', enabled: true }]);
    const binary = requestAt(api.items, 3);
    expect(binary.body).toEqual({ mode: 'binary' });
    expect(binary.headers).toEqual([{ key: 'Content-Type', value: 'application/octet-stream', enabled: true }]);
    expect(JSON.stringify(api)).not.toContain('/tmp/report.bin');
  });

  it('maps authentication types', () => {
    expect(requestAt(auth.items, 0).auth).toEqual({ type: 'basic', params: { username: 'client-id', password: 'client-secret-literal-04' } });
    expect(users.auth).toEqual({ type: 'bearer', params: { token: '{{access_token}}' } });
    expect(requestAt(users.items, 1).auth).toEqual({ type: 'apikey', params: { key: 'X-Api-Key', value: 'apikey-literal-05', in: 'header' } });
    expect(requestAt(admin.items, 0).auth).toEqual({
      type: 'oauth2',
      params: {
        accessTokenUrl: '{{base_url}}/oauth/token',
        clientId: 'admin-client',
        clientSecret: 'admin-secret-literal-06',
        scope: 'admin',
        audience: 'https://api.example.com/',
        grant_type: 'client_credentials',
        client_authentication: 'body',
      },
    });
    expect(requestAt(api.items, 3).auth).toEqual({ type: 'custom', params: { providerId: 'digest', username: 'digest-user', password: 'digest-literal-07' } });
    expect(requestAt(api.items, 4).auth).toEqual({ type: 'awsv4', params: { accessKey: 'AKIAEXAMPLE', secretKey: 'aws-secret-literal-08', sessionToken: '', region: 'eu-west-1', service: 's3' } });
    expect(requestAt(api.items, 5).auth).toEqual({ type: 'inherit', params: {} });
    expect(r.warnings.some((w) => w.path === 'resources[16].authentication' && /Disabled basic authentication was not imported/.test(w.message))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('disabled-literal-09');
  });

  it('keeps Nunjucks tags verbatim with a warning', () => {
    const del = requestAt(admin.items, 0);
    expect(del.url).toBe("{{base_url}}/users/{% response 'body', 'req_create000000000000000000000001', 'b64::JC5pZA==', 'never', 60 %}");
    expect(r.warnings.some((w) => w.severity === 'WARNING' && w.path === 'resources[11].url' && /template tag/.test(w.message))).toBe(true);
  });

  it('imports scripts unchanged and flags the insomnia.* API', () => {
    expect(requestAt(auth.items, 0).scripts).toEqual([{ type: 'test', language: 'javascript', source: "const body = insomnia.response.json();\ninsomnia.environment.set('access_token', body.access_token);", enabled: true }]);
    expect(users.scripts).toEqual([{ type: 'prerequest', language: 'javascript', source: "insomnia.request.addHeader({ key: 'X-Folder', value: 'users' });", enabled: true }]);
    expect(requestAt(users.items, 1).scripts.map((s) => s.type)).toEqual(['prerequest', 'test']);
    expect(r.warnings.filter((w) => /insomnia\.\* API/.test(w.message))).toHaveLength(4);
  });

  it('round-trips through the Postman v2.1 exporter', () => {
    expectRoundTrip(api);
  });

  it('is registered with importDocument', () => {
    const doc = importDocument(text, { fileName: 'workspace-export.json' });
    expect(doc.format).toBe('insomnia');
    expect(doc.name).toBe('Insomnia export (1 collection, 2 environments)');
    expect(doc.collections.map((c) => c.name)).toEqual(['Customer API']);
    expect(doc.environments.map((e) => e.name)).toEqual(['Production', 'Staging']);
    expect(doc.globals).toBeNull();
    expect(doc.schemaVersion).toBe('4');
  });
});

describe('convertInsomniaTemplate', () => {
  it('rewrites variable references and reports tags and filters', () => {
    const w = new WarningCollector();
    expect(convertInsomniaTemplate(w, '{{ _.base_url }}/x/{{base }}/{{  _.a.b-c  }}', 'p')).toBe('{{base_url}}/x/{{base}}/{{a.b-c}}');
    expect(convertInsomniaTemplate(w, 'plain', 'p')).toBe('plain');
    expect(w.toArray()).toEqual([]);
    expect(convertInsomniaTemplate(w, "{% uuid 'v4' %}", 'p')).toBe("{% uuid 'v4' %}");
    expect(convertInsomniaTemplate(w, '{{ _.x | upper }}', 'p')).toBe('{{ _.x | upper }}');
    expect(w.toArray().map((x) => x.message)).toEqual([expect.stringMatching(/template tag/), expect.stringMatching(/template filter/)]);
  });
});

describe('Insomnia import: hostile input', () => {
  const hostileText = formatFixtureText('insomnia', 'invalid/orphans-and-cycles.json');
  const h = parseInsomnia(hostileText);
  const root = h.collections[0]!;
  const names = root.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name));

  it('never pollutes prototypes', () => {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    const keys = ownKeysDeep([h.collections, h.environments, h.warnings]);
    expect(keys).not.toContain('__proto__');
    expect(keys).not.toContain('constructor');
    expect(keys).not.toContain('prototype');
    expect(h.warnings.some((w) => w.path === 'resources[8].data.__proto__' && /unsafe key/.test(w.message))).toBe(true);
  });

  it('places orphans and cycles at the top level without looping', () => {
    expect(names).toEqual([
      'First',
      'No id',
      'Hostile files',
      'Hostile binary',
      'netrc',
      'ntlm',
      'oauth password + pkce',
      'oauth code + pkce',
      'oauth unknown grant',
      'bad graphql',
      'bearer prefix',
      'Orphan request',
      'folder:Cycle A',
    ]);
    const cycleA = folderAt(root.items, 12);
    expect(cycleA.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name))).toEqual(['In cycle', 'folder:Cycle B']);
    expect(folderAt(cycleA.items, 1).items).toEqual([]);
    expect(h.warnings.some((w) => w.path === 'resources[1].parentId' && /Parent "fld_missing" not found/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'resources[6]._id' && /Duplicate resource id/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'resources[7]._id' && /no _id/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'resources[19]' && /Unknown Insomnia resource type "space_laser"/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'resources[18]' && /not an object/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === '__export_format' && /format 3/.test(w.message))).toBe(true);
    expect(h.stats.requests).toBe(13);
    expect(h.stats.folders).toBe(2);
  });

  it('imports orphan environments stand-alone with flattened keys', () => {
    expect(h.environments).toHaveLength(1);
    expect(h.environments[0]!.name).toBe('Orphan env');
    expect(h.environments[0]!.variables.map((v) => [v.key, v.initialValue])).toEqual([
      ['k', 'v'],
      ['list', '[1,2]'],
      ['deep.deeper.deepest', 'x'],
    ]);
    expect(h.warnings.some((w) => w.path === 'resources[8].parentId' && /stand-alone/.test(w.message))).toBe(true);
  });

  it('rejects unsafe file references, strips URL credentials and maps edge-case auth', () => {
    expect(requestAt(root.items, 2).body.formData!.map((f) => f.filePath)).toEqual([undefined, undefined, 'files/ok.txt']);
    expect(requestAt(root.items, 3).body).toEqual({ mode: 'binary' });
    const stored = JSON.stringify({ collections: h.collections, environments: h.environments });
    for (const bad of ['passwd', 'server', 'boot.ini']) expect(stored).not.toContain(bad);
    expect(requestAt(root.items, 1).url).toBe('https://example.com/noid');
    expect(JSON.stringify(h)).not.toContain('user:pw-literal');
    expect(requestAt(root.items, 1).auth).toEqual({ type: 'none', params: {} });
    expect(JSON.stringify(h.collections)).not.toContain('weird-literal');
    expect(h.warnings.some((w) => w.path === 'resources[7].authentication' && /"weird" is not supported/.test(w.message))).toBe(true);
    expect(requestAt(root.items, 4).auth).toEqual({ type: 'none', params: {} });
    expect(requestAt(root.items, 5).auth).toEqual({ type: 'custom', params: { providerId: 'ntlm', username: 'dom\\user', password: 'ntlm-literal' } });
    expect(requestAt(root.items, 6).auth.params.grant_type).toBe('password_credentials');
    expect(requestAt(root.items, 7).auth.params).toMatchObject({ grant_type: 'authorization_code_with_pkce', client_authentication: 'header', authUrl: 'https://example.com/auth', redirect_uri: 'http://localhost/cb' });
    expect(requestAt(root.items, 8).auth.params.grant_type).toBe('authorization_code');
    expect(h.warnings.some((w) => w.path === 'resources[15].authentication.grantType' && /"device"/.test(w.message))).toBe(true);
    expect(requestAt(root.items, 9).body).toEqual({ mode: 'raw', raw: 'not json' });
    expect(h.warnings.some((w) => w.path === 'resources[17].authentication.prefix' && /"Token"/.test(w.message))).toBe(true);
    expectRoundTrip(root);
  });

  it('enforces size, item and depth limits', () => {
    expect(failure(() => parseInsomnia(text, { maxBytes: 100 })).code).toBe('IMPORT_TOO_LARGE');
    expect(failure(() => parseInsomnia(text, { maxItems: 5 })).code).toBe('IMPORT_TOO_LARGE');
    expect(parseInsomnia(groupChain(63)).stats.folders).toBe(63);
    const err = failure(() => parseInsomnia(groupChain(70)));
    expect(err.code).toBe('IMPORT_INVALID');
    expect(err.message).toMatch(/nested deeper/);
    expect(failure(() => parseInsomnia(groupChain(5), { maxDepth: 3 })).code).toBe('IMPORT_INVALID');
    expect(parseInsomnia(groupChain(2), { maxDepth: 3 }).stats.folders).toBe(2);
    // the tree walk is iterative: a very long parent chain fails on the depth limit, not on the call stack
    expect(failure(() => parseInsomnia(groupChain(5000))).code).toBe('IMPORT_INVALID');
    expect(parseInsomnia(groupChain(5000), { maxDepth: 10_000 }).stats).toEqual({ folders: 5000, requests: 1, variables: 0, scripts: 0, examples: 0 });
  });

  it('rejects documents that are not Insomnia exports', () => {
    for (const input of ['{}', '[]', 'null', '{"_type":"export"}', '{"_type":"nope","resources":[]}', '{"resources":[]}', 'not json']) {
      const err = failure(() => parseInsomnia(input));
      expect(err.code, input).toBe('IMPORT_INVALID');
      expect((err.details.warnings as Array<{ severity: string }>).every((w) => w.severity === 'ERROR')).toBe(true);
    }
    expect(failure(() => parseInsomnia({ _type: 'export', __export_format: 4, resources: [] })).message).toMatch(/no workspace, request or environment/);
    expect(failure(() => parseInsomnia({ _type: 'export', __export_format: 4, resources: [{ _id: 'j', _type: 'cookie_jar', cookies: [] }] })).code).toBe('IMPORT_INVALID');
  });

  it('creates a collection for requests without any workspace', () => {
    const noWs = parseInsomnia({ _type: 'export', __export_format: 4, resources: [{ _id: 'r', _type: 'request', parentId: 'wrk_gone', name: 'Lonely', method: 'GET', url: 'https://x/' }] });
    expect(noWs.collections.map((c) => c.name)).toEqual(['Insomnia import']);
    expect(noWs.collections[0]!.items).toHaveLength(1);
  });
});
