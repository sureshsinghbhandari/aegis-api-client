import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectPostmanFormat } from '@aegis/postman';
import { fixtureJson } from './_postman-fixtures';

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const V20 = 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json';

describe('detectPostmanFormat', () => {
  it('detects v2.1 collections', () => {
    expect(detectPostmanFormat({ info: { name: 'x', schema: V21 }, item: [] })).toBe('collection-v2.1');
    expect(detectPostmanFormat(fixtureJson('kitchen-sink.json'))).toBe('collection-v2.1');
  });

  it('detects v2.0 collections', () => {
    expect(detectPostmanFormat({ info: { name: 'x', schema: V20 }, item: [] })).toBe('collection-v2.0');
    expect(detectPostmanFormat(fixtureJson('collection-v2.0.json'))).toBe('collection-v2.0');
  });

  it('treats a collection without schema as v2.1', () => {
    expect(detectPostmanFormat({ info: { name: 'x' }, item: [] })).toBe('collection-v2.1');
  });

  it('does not recognise legacy v1 collections or other schema majors', () => {
    expect(detectPostmanFormat({ info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json' }, item: [] })).toBe('unknown');
    expect(detectPostmanFormat({ id: 'abc', name: 'v1', order: [], requests: [] })).toBe('unknown');
  });

  it('detects environments and globals', () => {
    expect(detectPostmanFormat(fixtureJson('environment-basic.json'))).toBe('environment');
    expect(detectPostmanFormat(fixtureJson('globals-basic.json'))).toBe('globals');
    expect(detectPostmanFormat({ name: 'no scope', values: [] })).toBe('environment');
    expect(detectPostmanFormat({ name: 'weird', values: [], _postman_variable_scope: 'workspace' })).toBe('unknown');
  });

  it('returns unknown for everything else', () => {
    for (const v of [null, undefined, 42, 'text', [], {}, { info: {} }, { info: { name: 'x' } }, { info: { name: 'x' }, item: {} }, { values: {} }]) {
      expect(detectPostmanFormat(v)).toBe('unknown');
    }
  });

  it('classifies every fixture as expected', () => {
    const dir = fileURLToPath(new URL('../fixtures/postman/', import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const format = detectPostmanFormat(fixtureJson(file));
      if (file === 'environment-basic.json') expect(format).toBe('environment');
      else if (file === 'globals-basic.json') expect(format).toBe('globals');
      else if (file === 'collection-v2.0.json') expect(format).toBe('collection-v2.0');
      else expect(format, file).toBe('collection-v2.1');
    }
  });
});
