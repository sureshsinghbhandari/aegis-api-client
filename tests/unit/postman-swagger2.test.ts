import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppError } from '@aegis/core';
import type { ItemNode, RequestDraft } from '@aegis/core';
import { exportPostmanCollection, parseSwagger2Document, swagger2ToOpenApi3, validatePostmanV21Structure, WarningCollector } from '@aegis/postman';

const DIR = fileURLToPath(new URL('../fixtures/openapi/', import.meta.url));
const text = (name: string) => readFileSync(`${DIR}${name}`, 'utf8');

function requests(items: ItemNode[]): RequestDraft[] {
  return items.flatMap((i) => (i.kind === 'folder' ? requests(i.items) : [i.request]));
}
function byOp(items: ItemNode[], operationId: string): RequestDraft {
  const r = requests(items).find((x) => (x.metadata.openapi as { operationId?: string }).operationId === operationId);
  if (!r) throw new Error(`no operation ${operationId}`);
  return r;
}

describe('Swagger 2.0', () => {
  const r = parseSwagger2Document(text('swagger-2.0.json'));
  const { bundle } = r;

  it('converts host/basePath/schemes to servers and reports the conversion', () => {
    expect(r.format).toBe('swagger');
    expect(r.version).toBe('2.0');
    expect(bundle.name).toBe('Uber API');
    expect(bundle.variables.find((v) => v.key === 'baseUrl')!.initialValue).toBe('https://api.uber.example/v1');
    expect((bundle.sourceMetadata.openapi as { servers: string[] }).servers).toEqual(['https://api.uber.example/v1', 'http://api.uber.example/v1']);
    expect(r.warnings.some((w) => w.severity === 'INFO' && /converted to the OpenAPI 3 shape/.test(w.message))).toBe(true);
  });

  it('maps global $ref parameters, x-example and produces/consumes', () => {
    const list = byOp(bundle.items, 'listProducts');
    expect(list.queryParams).toEqual([
      { key: 'latitude', value: '0', enabled: true, description: 'Latitude component of location.' },
      { key: 'longitude', value: '13.4', enabled: true, description: 'Longitude component of location.' },
    ]);
    expect(list.examples.map((e) => [e.name, e.code])).toEqual([
      ['200 An array of products', 200],
      ['default Unexpected error', 200],
    ]);
    expect(JSON.parse(list.examples[0]!.body)).toEqual([{ product_id: 'p1', display_name: 'UberX' }]); // response examples by mime type
    expect(list.headers).toEqual([{ key: 'Accept', value: 'application/json', enabled: true }]);
  });

  it('turns body, formData and file parameters into request bodies', () => {
    const update = byOp(bundle.items, 'updateMe');
    expect(update.body.mode).toBe('raw');
    expect(JSON.parse(update.body.raw!)).toEqual({ first_name: 'Ada', last_name: 'string', email: 'user@example.com', picture: { url: 'string' } });
    expect(update.headers.find((h) => h.key === 'Content-Type')!.value).toBe('application/json');

    const avatar = byOp(bundle.items, 'uploadAvatar');
    expect(avatar.body.mode).toBe('formdata');
    expect(avatar.body.formData).toEqual([
      { key: 'avatar', type: 'file', value: '', enabled: true, description: 'The image' },
      { key: 'comment', type: 'text', value: 'new picture', enabled: false },
    ]);

    const login = byOp(bundle.items, 'login');
    expect(login.body.mode).toBe('urlencoded');
    expect(login.body.urlencoded!.map((e) => e.key)).toEqual(['username', 'password']);
    expect(login.body.urlencoded![1]!.value).toBe(''); // format: password is never pre-filled
    expect(login.examples[0]!.headers).toEqual([{ key: 'X-Session', value: '', enabled: true, description: 'session id' }]);
  });

  it('maps securityDefinitions (apiKey in query, basic, oauth2 accessCode)', () => {
    expect(bundle.auth).toEqual({ type: 'apikey', params: { key: 'server_token', value: '{{apiKey}}', in: 'query' } });
    expect(byOp(bundle.items, 'getMe').auth).toMatchObject({ type: 'oauth2', params: { grant_type: 'authorization_code', scope: 'profile', accessTokenUrl: 'https://login.uber.example/oauth/v2/token' } });
    expect(byOp(bundle.items, 'login').auth).toEqual({ type: 'basic', params: { username: '{{username}}', password: '{{password}}' } });
  });

  it('keeps path/header parameters and tags as folders', () => {
    const trip = byOp(bundle.items, 'getTrip');
    expect(trip.url).toBe('{{baseUrl}}/history/:tripId');
    expect(trip.headers).toEqual([
      { key: 'X-Client', value: '', enabled: true },
      { key: 'Accept', value: 'application/json', enabled: true },
    ]);
    expect(bundle.items.filter((i) => i.kind === 'folder').map((i) => i.name)).toEqual(['Products', 'User']);
    expect(r.stats).toMatchObject({ folders: 2, requests: 6 });
  });

  it('exports a structurally valid Postman collection', () => {
    expect(validatePostmanV21Structure(exportPostmanCollection(bundle))).toEqual([]);
  });

  it('rewrites $refs locally and never fetches', () => {
    const w = new WarningCollector();
    const converted = swagger2ToOpenApi3({ swagger: '2.0', info: { title: 'x' }, paths: {}, definitions: { A: { $ref: '#/definitions/B' }, B: { type: 'string' } }, parameters: { p: { name: 'p', in: 'query', type: 'string' } }, responses: { E: { description: 'e', schema: { $ref: 'http://x/y.json' } } } }, w);
    expect(JSON.stringify(converted)).toContain('#/components/schemas/B');
    expect(JSON.stringify(converted)).not.toContain('#/definitions/');
    expect((converted.components as { parameters: Record<string, { in: string }> }).parameters.p!.in).toBe('query');
  });

  it('rejects other documents', () => {
    expect(() => parseSwagger2Document('{"openapi":"3.0.0","paths":{}}')).toThrow(/OpenAPI importer/);
    expect(() => parseSwagger2Document('{"swagger":"1.2"}')).toThrow(AppError);
    expect(() => parseSwagger2Document('[]')).toThrow(/top-level value/);
  });
});
