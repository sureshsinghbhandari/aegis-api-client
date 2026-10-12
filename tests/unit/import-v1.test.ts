import { describe, expect, it } from 'vitest';
import { importDocument, parsePostmanV1 } from '@aegis/postman';
import { folderAt, requestAt } from './_postman-fixtures';
import { expectRoundTrip, failure, formatFixtureJson, formatFixtureText, ownKeysDeep } from './_format-fixtures';

const text = formatFixtureText('postman-v1', 'customer-api-v1.json');
const r = parsePostmanV1(text);
const authFolder = folderAt(r.bundle.items, 0);
const customers = folderAt(r.bundle.items, 1);

function folderChain(depth: number): object {
  const folders: object[] = [];
  for (let i = 0; i < depth; i++) folders.push({ id: `f${i}`, name: `F${i}`, order: i === depth - 1 ? ['r'] : [], folders_order: i === depth - 1 ? [] : [`f${i + 1}`] });
  return { name: 'chain', order: [], folders_order: ['f0'], folders, requests: [{ id: 'r', name: 'leaf', url: 'https://x/', method: 'GET' }] };
}

describe('Postman v1 import: structure', () => {
  it('places folders by folders_order, requests by order and appends leftovers', () => {
    expect(r.format).toBe('collection-v1');
    expect(r.bundle.name).toBe('Customer API (v1)');
    expect(r.bundle.uid).toBe('2b6f1d3c-9a4e-4f0b-8c7d-1e2f3a4b5c6d');
    expect(r.bundle.description).toBe('Legacy Postman Collection v1 export used as an import fixture.');
    expect(r.bundle.postmanSchemaVersion).toBe('1.0.0');
    expect(r.bundle.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name))).toEqual([
      'folder:Authentication',
      'folder:Customers',
      'Service status',
      'folder:Unreferenced',
      'GraphQL me',
    ]);
    expect(authFolder.items.map((i) => i.kind === 'request' && i.request.name)).toEqual(['Login (basic)', 'Refresh token']);
    expect(customers.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name))).toEqual(['folder:Admin', 'List customers', 'Create customer (form)', 'Orphan in Customers']);
    expect(folderAt(customers.items, 0).items.map((i) => i.kind === 'request' && i.request.name)).toEqual(['Delete customer']);
    expect(r.stats).toEqual({ folders: 4, requests: 8, variables: 3, scripts: 4, examples: 1 });
    expect(r.warnings.some((w) => w.severity === 'INFO' && w.path === 'folders[3]' && /not referenced by any folders_order; appended at the top level/.test(w.message))).toBe(true);
    expect(r.warnings.some((w) => w.severity === 'INFO' && w.path === 'requests[7]' && /appended to "Customers"/.test(w.message))).toBe(true);
    expect(r.warnings.some((w) => w.severity === 'INFO' && w.path === 'requests[6]' && /appended at the top level/.test(w.message))).toBe(true);
  });

  it('imports collection and folder level auth, scripts and variables', () => {
    expect(r.bundle.auth).toEqual({ type: 'apikey', params: { key: 'X-Api-Key', value: 'apikey-literal', in: 'header' } });
    expect(r.bundle.scripts).toEqual([{ type: 'prerequest', language: 'javascript', source: "console.log('collection pre-request');", enabled: true }]);
    expect(r.bundle.variables).toEqual([
      { key: 'baseUrl', initialValue: 'https://api.example.com/v1', isSecret: false, enabled: true, type: 'string' },
      { key: 'accessToken', initialValue: '', isSecret: true, enabled: true, type: 'secret' },
    ]);
    expect(authFolder.auth).toEqual({ type: 'none', params: {} });
    expect(customers.auth).toEqual({ type: 'bearer', params: { token: '{{accessToken}}' } });
    expect(customers.scripts).toHaveLength(1);
    expect(customers.variables).toEqual([{ key: 'pageSize', initialValue: '20', isSecret: false, enabled: true, type: 'string' }]);
    expect(customers.metadata.postmanId).toBe('fld_customers');
    expect(folderAt(customers.items, 0).description).toBe('Admin only');
  });
});

describe('Postman v1 import: requests', () => {
  it('reads header strings, headerData, queryParams, path variables and URL fragments', () => {
    const status = requestAt(r.bundle.items, 2);
    expect(status.headers).toEqual([
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Debug', value: '1', enabled: true },
    ]);
    expect(status.body).toEqual({ mode: 'none' });
    expect(status.auth).toEqual({ type: 'inherit', params: {} });
    expect(status.description).toBe('Returns the **service status**.');
    expect(status.metadata).toEqual({ postmanId: 'req_status', _descriptionType: 'text/markdown' });
    const login = requestAt(authFolder.items, 0);
    expect(login.url).toBe('{{baseUrl}}/auth/login');
    expect(login.queryParams).toEqual([{ key: 'remember', value: 'true', description: 'Keep the session', enabled: true }]);
    expect(login.headers).toEqual([
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'X-Old-Client', value: 'legacy', description: 'Removed in v2', enabled: false },
    ]);
    const list = requestAt(customers.items, 1);
    expect(list.url).toBe('{{baseUrl}}/customers');
    expect(list.queryParams).toEqual([
      { key: 'page', value: '1', enabled: true },
      { key: 'size', value: '{{pageSize}}', enabled: true },
    ]);
    expect(list.metadata).toEqual({ postmanId: 'req_list', urlHash: '#top', _descriptionType: 'text/html' });
    const del = requestAt(folderAt(customers.items, 0).items, 0);
    expect(del.url).toBe('{{baseUrl}}/customers/:customerId');
    expect(del.pathVariables).toEqual([{ key: 'customerId', value: '1042', description: 'Customer identifier', enabled: true }]);
  });

  it('maps dataMode raw / urlencoded / params / graphql bodies', () => {
    expect(requestAt(authFolder.items, 0).body).toEqual({ mode: 'raw', raw: '{\n  "remember": true\n}', rawLanguage: 'json' });
    expect(requestAt(authFolder.items, 1).body).toEqual({
      mode: 'urlencoded',
      urlencoded: [
        { key: 'grant_type', value: 'refresh_token', enabled: true },
        { key: 'refresh_token', value: '{{refreshToken}}', description: 'From the login response', enabled: true },
      ],
    });
    const create = requestAt(customers.items, 2);
    expect(create.body.mode).toBe('formdata');
    expect(create.body.formData).toEqual([
      { key: 'name', type: 'text', value: 'Ada Lovelace', enabled: true },
      { key: 'avatar', type: 'file', value: '', filePath: 'files/avatar.png', enabled: true },
      { key: 'evil', type: 'file', value: '', enabled: true },
      { key: 'draft', type: 'text', value: 'true', enabled: false },
    ]);
    expect(r.warnings.some((w) => w.path === 'requests[4].data[2].value' && /traversal/.test(w.message))).toBe(true);
    expect(create.settings).toEqual({ followRedirects: false });
    const graphql = requestAt(r.bundle.items, 4);
    expect(graphql.body).toEqual({ mode: 'raw', raw: '{"query":"{ me { id name } }","variables":{}}', rawLanguage: 'json' });
    expect(graphql.metadata).toMatchObject({ originalBodyMode: 'graphql', graphqlBody: { query: '{ me { id name } }', variables: '{}' } });
  });

  it('maps legacy auth helpers and v2-style auth blocks', () => {
    expect(requestAt(authFolder.items, 0).auth).toEqual({ type: 'basic', params: { username: 'api-user', password: 'hunter2-literal' } });
    expect(requestAt(authFolder.items, 1).auth).toEqual({ type: 'bearer', params: { token: '{{accessToken}}' } });
    expect(requestAt(customers.items, 2).auth).toEqual({ type: 'awsv4', params: { accessKey: 'AKIAEXAMPLE', secretKey: 'aws-literal', region: 'eu-west-1', service: 'execute-api', sessionToken: '' } });
    const hawk = requestAt(folderAt(customers.items, 0).items, 0).auth;
    expect(hawk.type).toBe('custom');
    expect(hawk.params).toMatchObject({ providerId: 'hawk', authId: 'dh37fgj492je', authKey: 'hawk-literal', algorithm: 'sha256' });
    expect(r.warnings.some((w) => w.path === 'requests[5].currentHelper' && /not natively supported/.test(w.message))).toBe(true);
  });

  it('prefers events over the legacy script strings and imports responses as examples', () => {
    const login = requestAt(authFolder.items, 0);
    expect(login.scripts).toEqual([{ type: 'test', language: 'javascript', source: "pm.collectionVariables.set('accessToken', pm.response.json().token);", enabled: true }]);
    const status = requestAt(r.bundle.items, 2);
    expect(status.scripts).toEqual([{ type: 'test', language: 'javascript', source: "pm.test('ok', function () { pm.response.to.have.status(200); });", enabled: true }]);
    expect(status.examples).toEqual([
      {
        name: 'Healthy',
        status: 'OK',
        code: 200,
        headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
        body: '{"status":"ok"}',
        language: 'json',
        metadata: { cookie: [], id: 'res_status_ok' },
      },
    ]);
  });

  it('round-trips through the Postman v2.1 exporter and is registered with importDocument', () => {
    expectRoundTrip(r.bundle);
    const doc = importDocument(text);
    expect(doc.format).toBe('postman-v1');
    expect(doc.name).toBe('Customer API (v1)');
    expect(doc.schemaVersion).toBe('1.0.0');
    expect(doc.stats).toEqual(r.stats);
    expect(parsePostmanV1(formatFixtureJson('postman-v1', 'customer-api-v1.json')).stats).toEqual(r.stats);
  });
});

describe('Postman v1 import: hostile input', () => {
  const hostileText = formatFixtureText('postman-v1', 'invalid/cycles-and-duplicates.json');
  const h = parsePostmanV1(hostileText);

  it('never pollutes prototypes and drops unsafe keys', () => {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    const keys = ownKeysDeep([h.bundle, h.warnings]);
    expect(keys).not.toContain('__proto__');
    expect(keys).not.toContain('constructor');
    expect(keys).not.toContain('prototype');
    expect(folderAt(h.bundle.items, 0).metadata.protocolProfileBehavior).toEqual({ followRedirects: false });
    expect(requestAt(h.bundle.items, 1).pathVariables).toEqual([{ key: 'id', value: '1', enabled: true }]);
  });

  it('survives order cycles, duplicate and unknown ids', () => {
    expect(h.bundle.name).toBe('Imported collection');
    expect(h.bundle.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name))).toEqual(['folder:A', 'A request', 'folder:No id', 'Binary with traversal', 'No id, no order']);
    expect(requestAt(h.bundle.items, 3).body).toEqual({ mode: 'binary' });
    const a = folderAt(h.bundle.items, 0);
    expect(a.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name))).toEqual(['folder:B', 'B request']);
    expect(folderAt(a.items, 0).items).toEqual([]);
    const messages = h.warnings.map((w) => `${w.path}: ${w.message}`);
    expect(messages).toContain('folders[1].folders_order: Folder "fld_a" is referenced more than once; later references are ignored');
    expect(messages).toContain('folders_order: folders_order references unknown folder id "fld_missing"');
    expect(messages).toContain('order: Request "req_a" is referenced more than once; later references are ignored');
    expect(messages).toContain('order: Order references unknown request id "req_missing"');
    expect(messages).toContain('folders[2].id: Duplicate id "fld_a"; this entry is skipped');
    expect(messages.some((m) => /^folders\[3\]\.id: Entry has no id/.test(m))).toBe(true);
    expect(messages.some((m) => /^name: Collection has no name/.test(m))).toBe(true);
    expect(h.stats).toEqual({ folders: 3, requests: 4, variables: 0, scripts: 0, examples: 1 });
  });

  it('rejects unsafe file paths, strips URL credentials and tolerates malformed fields', () => {
    const a = requestAt(h.bundle.items, 1);
    expect(a.url).toBe('https://example.com/a');
    expect(a.queryParams).toEqual([{ key: 'x', value: '1', enabled: true }]);
    expect(a.headers).toEqual([]);
    expect(a.body).toEqual({ mode: 'none' });
    expect(a.auth).toEqual({ type: 'oauth2', params: { accessToken: 'at-literal', addTokenTo: 'header', tokenType: 'Bearer' } });
    expect(a.examples).toEqual([{ name: 'r', status: '', code: 0, headers: [], body: 'x', metadata: { cookie: [] } }]);
    const b = requestAt(folderAt(h.bundle.items, 0).items, 1);
    expect(b.body.formData!.map((f) => f.filePath)).toEqual([undefined, undefined, 'files/ok.txt', undefined]);
    expect(b.auth).toEqual({ type: 'inherit', params: {} });
    expect(h.warnings.some((w) => w.path === 'requests[1].currentHelper' && /no helperAttributes/.test(w.message))).toBe(true);
    const noId = requestAt(h.bundle.items, 4);
    expect(noId.body).toEqual({ mode: 'raw', raw: 'ab' });
    const stored = JSON.stringify(h.bundle);
    for (const bad of ['passwd', 'win.ini', 'boot.ini']) expect(stored).not.toContain(bad);
    expect(JSON.stringify(h)).not.toContain('p-literal');
    expect(h.warnings.filter((w) => /Unsafe file path rejected/.test(w.message))).toHaveLength(3);
    expect(h.warnings.some((w) => w.path === 'requests[0].dataMode' && /hologram/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.path === 'requests[0].headers' && /not a string/.test(w.message))).toBe(true);
    expect(h.warnings.some((w) => w.severity === 'INFO' && w.path === 'requests[0].x-unknown' && /not imported/.test(w.message))).toBe(true);
    expectRoundTrip(h.bundle);
  });

  it('enforces size, item and depth limits', () => {
    expect(failure(() => parsePostmanV1(text, { maxBytes: 100 })).code).toBe('IMPORT_TOO_LARGE');
    expect(failure(() => parsePostmanV1(text, { maxItems: 5 })).code).toBe('IMPORT_TOO_LARGE');
    expect(parsePostmanV1(folderChain(63)).stats.folders).toBe(63);
    const err = failure(() => parsePostmanV1(folderChain(70)));
    expect(err.code).toBe('IMPORT_INVALID');
    expect(err.message).toMatch(/nested deeper/);
    expect(failure(() => parsePostmanV1(folderChain(5), { maxDepth: 3 })).code).toBe('IMPORT_INVALID');
    expect(parsePostmanV1(folderChain(2), { maxDepth: 3 }).stats.folders).toBe(2);
  });

  it('rejects documents that are not v1 collections', () => {
    for (const input of ['{}', '[]', 'null', '{"name":"x"}', '{"requests":"x"}', '{"requests":[],"folders":"x"}', 'not json']) {
      const err = failure(() => parsePostmanV1(input));
      expect(err.code, input).toBe('IMPORT_INVALID');
      expect((err.details.warnings as Array<{ severity: string }>).every((w) => w.severity === 'ERROR')).toBe(true);
    }
    expect(failure(() => parsePostmanV1(formatFixtureText('postman', 'get-simple.json'))).message).toMatch(/Collection v2/);
  });
});
