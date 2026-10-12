import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppError } from '@aegis/core';
import type { FolderNode, ItemNode, RequestDraft } from '@aegis/core';
import { exportPostmanCollection, parseOpenApiDocument, parsePostmanCollection, serializePostmanJson, validatePostmanV21Structure, compareCollectionBundles } from '@aegis/postman';

const DIR = fileURLToPath(new URL('../fixtures/openapi/', import.meta.url));
const text = (name: string) => readFileSync(`${DIR}${name}`, 'utf8');

function requests(items: ItemNode[]): RequestDraft[] {
  return items.flatMap((i) => (i.kind === 'folder' ? requests(i.items) : [i.request]));
}
function folder(items: ItemNode[], name: string): FolderNode {
  const f = items.find((i) => i.kind === 'folder' && i.name === name);
  if (!f || f.kind !== 'folder') throw new Error(`no folder ${name}`);
  return f;
}
function byOp(items: ItemNode[], operationId: string): RequestDraft {
  const r = requests(items).find((x) => (x.metadata.openapi as { operationId?: string }).operationId === operationId);
  if (!r) throw new Error(`no operation ${operationId}`);
  return r;
}
function fails(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected a throw');
}

describe('OpenAPI 3.0 (Petstore JSON)', () => {
  const r = parseOpenApiDocument(text('petstore-3.0.json'), { fileName: 'petstore-3.0.json' });
  const { bundle } = r;

  it('maps info, servers and format', () => {
    expect(r.format).toBe('openapi');
    expect(r.version).toBe('3.0.3');
    expect(bundle.name).toBe('Swagger Petstore');
    expect(bundle.description).toContain('A sample Pet Store');
    expect(bundle.description).toContain('API version: 1.0.11');
    const baseUrl = bundle.variables.find((v) => v.key === 'baseUrl')!;
    expect(baseUrl.initialValue).toBe('https://sandbox.petstore.example/api/v3'); // server variables substituted with defaults
    expect((bundle.sourceMetadata.openapi as { servers: string[] }).servers).toEqual(['https://sandbox.petstore.example/api/v3', 'http://localhost:8080/api/v3']);
    expect(r.warnings.some((w) => w.path === 'servers' && /2 servers/.test(w.message))).toBe(true);
  });

  it('creates one folder per used tag, in declared order, and keeps untagged operations at the root', () => {
    const folders = bundle.items.filter((i) => i.kind === 'folder').map((i) => i.name);
    expect(folders).toEqual(['pet', 'store', 'user']); // "unused" tag has no operations
    expect(folder(bundle.items, 'pet').description).toBe('Everything about your Pets');
    const root = bundle.items.filter((i) => i.kind === 'request').map((i) => i.request.name);
    expect(root).toEqual(['Health check (no tag)', 'References another file']);
    expect(r.stats).toMatchObject({ folders: 3, requests: 11, scripts: 0 });
  });

  it('converts path templates, parameters and headers', () => {
    const get = byOp(bundle.items, 'getPetById');
    expect(get.method).toBe('GET');
    expect(get.url).toBe('{{baseUrl}}/pet/:petId');
    expect(get.pathVariables).toEqual([{ key: 'petId', value: '10', enabled: true, description: 'ID of pet' }]);
    expect(get.headers).toEqual([{ key: 'Accept', value: 'application/json', enabled: true }]);

    const find = byOp(bundle.items, 'findPetsByStatus');
    expect(find.queryParams).toEqual([
      { key: 'status', value: 'available', enabled: false, description: 'Status values that need to be considered for filter' },
      { key: 'limit', value: '25', enabled: true },
    ]);
    expect(find.headers.find((h) => h.key === 'X-Trace-Id')).toMatchObject({ enabled: false, value: '00000000-0000-4000-8000-000000000000' });
    expect(r.warnings.some((w) => /"session" in "cookie"/.test(w.message))).toBe(true);
  });

  it('generates JSON bodies from $ref schemas with examples, enums and nested objects', () => {
    const add = byOp(bundle.items, 'addPet');
    expect(add.body.mode).toBe('raw');
    expect(add.body.rawLanguage).toBe('json');
    const json = JSON.parse(add.body.raw!);
    expect(json).toEqual({
      id: 10,
      name: 'doggie',
      category: { id: 1, name: 'Dogs' },
      photoUrls: ['https://example.com'],
      tags: [{ id: 0, name: 'string' }],
      status: 'available',
    });
    expect(add.headers.find((h) => h.key === 'Content-Type')!.value).toBe('application/json');
    expect(r.warnings.some((w) => w.path === 'paths["/pet"].post.requestBody' && /application\/json/.test(w.message))).toBe(true);
    expect(r.warnings.some((w) => /#\/components\/schemas\/Missing/.test(w.message) && /does not resolve/.test(w.message))).toBe(true);
  });

  it('maps form bodies', () => {
    const form = byOp(bundle.items, 'updatePetWithForm');
    expect(form.body.mode).toBe('urlencoded');
    expect(form.body.urlencoded).toEqual([
      { key: 'name', value: 'Rex', enabled: true },
      { key: 'status', value: 'string', enabled: false },
    ]);
    expect(form.description).toContain('DEPRECATED');
    const upload = byOp(bundle.items, 'uploadFile');
    expect(upload.body.mode).toBe('formdata');
    expect(upload.body.formData).toEqual([
      { key: 'file', type: 'file', value: '', enabled: true, contentType: 'image/png' },
      { key: 'caption', type: 'text', value: 'A photo', enabled: true },
    ]);
    expect(upload.queryParams).toEqual([{ key: 'additionalMetadata', value: '', enabled: false, description: 'Additional Metadata' }]); // $ref parameter
  });

  it('turns responses into examples', () => {
    const find = byOp(bundle.items, 'findPetsByStatus');
    expect(find.examples.map((e) => [e.name, e.code, e.status])).toEqual([
      ['200 successful operation', 200, 'OK'],
      ['400 Invalid status value', 400, 'Bad Request'],
    ]);
    expect(JSON.parse(find.examples[0]!.body)).toEqual([{ id: 1, name: 'doggie' }]); // named example wins over schema generation
    expect(find.examples[0]!.headers).toEqual([
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'X-Rate-Limit', value: '100', enabled: true, description: 'calls per hour allowed by the user' },
    ]);
    expect(JSON.parse(byOp(bundle.items, 'getPetById').examples[0]!.body)).toEqual({ id: 10, name: 'doggie', status: 'available' });
    expect(JSON.parse(byOp(bundle.items, 'getInventory').examples[0]!.body)).toEqual({ key: 0 });
    expect(r.stats.examples).toBe(requests(bundle.items).reduce((n, q) => n + q.examples.length, 0));
  });

  it('maps security schemes to collection and request auth with placeholder variables', () => {
    expect(bundle.auth).toEqual({ type: 'apikey', params: { key: 'api_key', value: '{{apiKey}}', in: 'header' } });
    const apiKey = bundle.variables.find((v) => v.key === 'apiKey')!;
    expect(apiKey).toMatchObject({ isSecret: true, initialValue: '' });
    const add = byOp(bundle.items, 'addPet');
    expect(add.auth.type).toBe('oauth2');
    expect(add.auth.params).toMatchObject({ grant_type: 'authorization_code', authUrl: 'https://petstore.example/oauth/authorize', accessTokenUrl: 'https://petstore.example/oauth/token', scope: 'write:pets read:pets', clientId: '{{clientId}}', clientSecret: '{{clientSecret}}' });
    expect(byOp(bundle.items, 'deletePet').auth).toEqual({ type: 'none', params: {} }); // security: []
    expect(byOp(bundle.items, 'getInventory').auth.type).toBe('inherit'); // same as the collection
    expect(byOp(bundle.items, 'loginUser').auth).toEqual({ type: 'basic', params: { username: '{{username}}', password: '{{password}}' } });
    expect(bundle.variables.find((v) => v.key === 'password')!.isSecret).toBe(true);
    expect(bundle.variables.find((v) => v.key === 'username')!.isSecret).toBe(false);
    expect(r.warnings.some((w) => w.path === 'paths["/user/login"].get.security' && /2 alternative/.test(w.message))).toBe(true);
  });

  it('warns about unsupported parts instead of dropping them silently', () => {
    const messages = r.warnings.map((w) => `${w.severity} ${w.path} ${w.message}`);
    expect(messages.some((m) => /WARNING .*callbacks.*Callbacks are not supported/.test(m))).toBe(true);
    expect(messages.some((m) => /WARNING .*External \$ref "https:\/\/example.com\/schemas\/remote.json#\/Thing" is not fetched/.test(m))).toBe(true);
    expect(messages.some((m) => /INFO .*Operation-level server "https:\/\/status.petstore.example"/.test(m))).toBe(true);
    expect(byOp(bundle.items, 'health').url).toBe('https://status.petstore.example/health');
    expect(byOp(bundle.items, 'health').examples[0]!.body).toBe('OK');
    expect((bundle.sourceMetadata.openapi as { extensions: Record<string, unknown> }).extensions).toEqual({ 'x-aegis-fixture': true });
  });

  it('round-trips through the Postman exporter and re-import', () => {
    const exported = exportPostmanCollection(bundle, { includeSecrets: true });
    expect(validatePostmanV21Structure(exported)).toEqual([]);
    const again = parsePostmanCollection(serializePostmanJson(exported));
    expect(again.stats.requests).toBe(r.stats.requests);
    expect(again.stats.folders).toBe(r.stats.folders);
    // OpenAPI metadata (operationId, path, ...) is not part of the Postman format and is expected to be dropped by the exporter.
    expect(compareCollectionBundles(bundle, again.bundle, { ignoreSecrets: true }).filter((d) => !/metadata|sourceMetadata/.test(JSON.stringify(d)))).toEqual([]);
    expect(bundle.variables.filter((v) => v.isSecret).every((v) => v.type === 'secret')).toBe(true);
  });
});

describe('OpenAPI 3.1 (YAML)', () => {
  const r = parseOpenApiDocument(text('petstore-3.1.yaml'), { fileName: 'petstore-3.1.yaml' });

  it('parses YAML and understands 3.1 constructs', () => {
    expect(r.version).toBe('3.1.0');
    expect(r.bundle.name).toBe('Petstore 3.1');
    expect(r.bundle.auth).toEqual({ type: 'bearer', params: { token: '{{bearerToken}}' } });
    const list = byOp(r.bundle.items, 'listPets');
    expect(list.queryParams).toEqual([
      { key: 'limit', value: '20', enabled: true },
      { key: 'tag', value: '', enabled: false }, // placeholder "string" values are not pre-filled
    ]);
    const create = byOp(r.bundle.items, 'createPet');
    expect(JSON.parse(create.body.raw!)).toEqual({ id: 1, name: 'Fluffy', nickname: 'string', tags: ['cute', 'small'] }); // recursive `parent` ends the branch
    const get = byOp(r.bundle.items, 'getPet'); // via a $ref path item
    expect(get.url).toBe('{{baseUrl}}/pets/:petId');
    expect(get.pathVariables[0]!.value).toBe('p-1');
    expect(r.warnings.some((w) => w.path === 'webhooks' && w.severity === 'WARNING')).toBe(true);
    expect(r.warnings.some((w) => w.path === 'openapi' && /3\.1/.test(w.message))).toBe(true);
  });

  it('also accepts YAML without a .yaml file name', () => {
    expect(parseOpenApiDocument(text('petstore-3.1.yaml')).bundle.name).toBe('Petstore 3.1');
  });
});

describe('OpenAPI validation and limits', () => {
  it('rejects non-OpenAPI input with ERROR warnings', () => {
    expect(fails(() => parseOpenApiDocument('{"info":{"title":"x"}}')).code).toBe('IMPORT_INVALID');
    expect(fails(() => parseOpenApiDocument({ openapi: '4.0.0', paths: {} })).message).toMatch(/Unsupported OpenAPI version/);
    expect(fails(() => parseOpenApiDocument({ openapi: '3.0.0' })).message).toMatch(/"paths" object is missing/);
    expect(fails(() => parseOpenApiDocument({ swagger: '2.0', paths: {} })).message).toMatch(/Swagger importer/);
    const err = fails(() => parseOpenApiDocument('not: [yaml'));
    expect(err.code).toBe('IMPORT_INVALID');
    expect((err.details.warnings as Array<{ severity: string }>)[0]!.severity).toBe('ERROR');
  });

  it('enforces the operation count and byte limits', () => {
    expect(fails(() => parseOpenApiDocument(text('petstore-3.0.json'), { maxItems: 3 })).code).toBe('IMPORT_TOO_LARGE');
    expect(fails(() => parseOpenApiDocument(text('petstore-3.0.json'), { maxBytes: 100 })).code).toBe('IMPORT_TOO_LARGE');
  });

  it('is resilient to deeply nested JSON', () => {
    const depth = 5000;
    const doc = `{"openapi":"3.0.0","info":{"title":"d"},"paths":{},"x-deep":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    expect(fails(() => parseOpenApiDocument(doc)).code).toBe('IMPORT_INVALID');
  });
});
