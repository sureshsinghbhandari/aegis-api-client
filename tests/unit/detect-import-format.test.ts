import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeImportFormat, detectImportFormat, isPostmanDump, isPostmanV1Collection } from '@aegis/postman';
import type { ImportFormat } from '@aegis/postman';
import { formatFixtureJson } from './_format-fixtures';

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

describe('detectImportFormat', () => {
  it('classifies the fixtures of every format', () => {
    expect(detectImportFormat(formatFixtureJson('har', 'browser-session.har'))).toBe('har');
    expect(detectImportFormat(formatFixtureJson('har', 'invalid/hostile.har'))).toBe('har');
    expect(detectImportFormat(formatFixtureJson('insomnia', 'workspace-export.json'))).toBe('insomnia');
    expect(detectImportFormat(formatFixtureJson('insomnia', 'invalid/orphans-and-cycles.json'))).toBe('insomnia');
    expect(detectImportFormat(formatFixtureJson('postman-v1', 'customer-api-v1.json'))).toBe('postman-v1');
    expect(detectImportFormat(formatFixtureJson('postman-v1', 'invalid/cycles-and-duplicates.json'))).toBe('postman-v1');
    expect(detectImportFormat(formatFixtureJson('dump', 'backup.json'))).toBe('postman-dump');
    expect(detectImportFormat(formatFixtureJson('dump', 'invalid/all-broken.json'))).toBe('postman-dump');
    expect(detectImportFormat(formatFixtureJson('postman', 'environment-basic.json'))).toBe('postman-environment');
    expect(detectImportFormat(formatFixtureJson('postman', 'globals-basic.json'))).toBe('postman-globals');
    const dir = fileURLToPath(new URL('../fixtures/postman/', import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && !/environment|globals/.test(f))) {
      expect(detectImportFormat(formatFixtureJson('postman', file)), file).toBe('postman-collection');
    }
  });

  it('recognises OpenAPI and Swagger by their version keys only', () => {
    expect(detectImportFormat({ openapi: '3.0.3', info: { title: 'x' }, paths: {} })).toBe('openapi');
    expect(detectImportFormat({ openapi: '3.1.0', info: { title: 'x' }, components: {} })).toBe('openapi');
    expect(detectImportFormat({ swagger: '2.0', info: { title: 'x' }, paths: {} })).toBe('swagger');
    expect(detectImportFormat({ swagger: 2 })).toBe('swagger');
    // a Postman collection that happens to carry an "openapi" key is still a Postman collection
    expect(detectImportFormat({ info: { name: 'x', schema: V21 }, item: [], openapi: '3.0.0', paths: {} })).toBe('postman-collection');
  });

  it('recognises Aegis files by their format marker', () => {
    expect(detectImportFormat({ format: 'aegis-backup', version: 1 })).toBe('aegis-backup');
    expect(detectImportFormat({ format: 'aegis-workspace', version: 1, workspace: {} })).toBe('aegis-workspace');
  });

  it('distinguishes v1 collections from dumps and v2 collections', () => {
    expect(isPostmanV1Collection({ id: 'abc', name: 'v1', order: [], requests: [] })).toBe(true);
    expect(isPostmanV1Collection({ requests: [], folders: [] })).toBe(true);
    expect(isPostmanV1Collection({ requests: [] })).toBe(false);
    expect(isPostmanV1Collection({ info: { name: 'x' }, item: [], requests: [], order: [] })).toBe(false);
    expect(isPostmanV1Collection(null)).toBe(false);
    expect(isPostmanDump({ collections: [], environments: [] })).toBe(true);
    expect(isPostmanDump({ collections: [], globals: [] })).toBe(true);
    expect(isPostmanDump({ collections: [], version: '1' })).toBe(true);
    expect(isPostmanDump({ collections: [] })).toBe(false);
    expect(isPostmanDump({ collections: [], environments: [], requests: [] })).toBe(false);
    expect(isPostmanDump([])).toBe(false);
    expect(detectImportFormat({ collections: [], environments: [], info: { name: 'x' }, item: [] })).toBe('postman-collection');
  });

  it('returns unknown for everything else', () => {
    for (const v of [null, undefined, 42, 'text', [], {}, { info: {} }, { log: {} }, { log: { entries: {} } }, { _type: 'export' }, { resources: [] }, { requests: [] }, { collections: [] }, { values: {} }]) {
      expect(detectImportFormat(v)).toBe('unknown');
    }
  });

  it('has a human-readable name for every format', () => {
    const formats: ImportFormat[] = ['postman-collection', 'postman-environment', 'postman-globals', 'postman-v1', 'postman-dump', 'openapi', 'swagger', 'har', 'insomnia', 'aegis-workspace', 'aegis-backup', 'unknown'];
    const names = formats.map(describeImportFormat);
    expect(new Set(names).size).toBe(formats.length);
    expect(names.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
    expect(describeImportFormat('har')).toBe('HAR 1.2');
    expect(describeImportFormat('insomnia')).toBe('Insomnia v4 export');
    expect(describeImportFormat('postman-v1')).toBe('Postman Collection v1');
    expect(describeImportFormat('postman-dump')).toBe('Postman data dump');
  });
});
