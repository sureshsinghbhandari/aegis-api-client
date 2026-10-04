import { describe, expect, it } from 'vitest';
import { AppError } from '@aegis/core';
import {
  exportPostmanCollection,
  parsePostmanCollection,
  serializePostmanJson,
  WarningCollector,
  MAX_WARNINGS,
} from '@aegis/postman';
import { collectionOf, fixtureText, requestAt, requestItem } from './_postman-fixtures';

function failure(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected the call to throw');
}

function nestedFolders(levels: number): Record<string, unknown> {
  let item: unknown[] = [requestItem({ method: 'GET', url: 'http://x' })];
  for (let i = 0; i < levels; i++) item = [{ name: `L${i}`, item }];
  return collectionOf(item);
}

function ownKeysDeep(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => ownKeysDeep(v, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.push(k);
      ownKeysDeep(v, found);
    }
  }
  return found;
}

describe('imported file paths', () => {
  const r = parsePostmanCollection(fixtureText('invalid/traversal-paths.json'));
  const body = requestAt(r.bundle.items, 0).body;

  it('rejects traversal, absolute, drive-letter, UNC and device-style paths and does not store them', () => {
    expect(body.formData!.map((f) => f.filePath)).toEqual([undefined, undefined, undefined, undefined, 'files/ok.txt', 'files/first.txt']);
    expect(requestAt(r.bundle.items, 1).body).toEqual({ mode: 'binary' });
    const stored = JSON.stringify(r.bundle);
    for (const bad of ['etc/passwd', 'win.ini', 'server', 'etc/shadow', 'boot.ini']) expect(stored).not.toContain(bad);
  });

  it('warns for every rejected path with the reason and the source value', () => {
    const rejected = r.warnings.filter((w) => w.severity === 'WARNING' && /Unsafe file path rejected/.test(w.message));
    expect(rejected.map((w) => w.sourceValue)).toEqual(['../../etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share\\f', '/etc/shadow', '..\\..\\boot.ini']);
    expect(rejected.map((w) => w.path)).toEqual([
      'item[0].request.body.formdata[0].src',
      'item[0].request.body.formdata[1].src',
      'item[0].request.body.formdata[2].src',
      'item[0].request.body.formdata[3].src',
      'item[1].request.body.file.src',
    ]);
    expect(rejected[0]!.message).toContain('traversal');
    expect(rejected[3]!.message).toContain('absolute');
    expect(rejected[2]!.message).toContain('UNC');
    expect(r.warnings.some((w) => w.path === 'item[0].request.body.formdata[5].src' && /Multiple files/.test(w.message))).toBe(true);
  });

  it('never re-exports a rejected path', () => {
    const text = serializePostmanJson(exportPostmanCollection(r.bundle, { includeSecrets: true }));
    expect(text).not.toMatch(/passwd|win\.ini|shadow|boot\.ini|server/);
    expect(text).toContain('files/ok.txt');
  });

  it('also rejects NUL bytes, file: URLs, home and environment-expanded paths', () => {
    const files = ['a\0b', 'file:///etc/hosts', '~/secret', '%USERPROFILE%\\x', '$HOME/x', 'ok/relative.txt'];
    const imp = parsePostmanCollection(
      collectionOf([requestItem({ method: 'POST', url: 'http://x', body: { mode: 'formdata', formdata: files.map((src, i) => ({ key: `k${i}`, type: 'file', src })) } })]),
    );
    expect(requestAt(imp.bundle.items, 0).body.formData!.map((f) => f.filePath)).toEqual([undefined, undefined, undefined, undefined, undefined, 'ok/relative.txt']);
  });
});

describe('prototype pollution', () => {
  it('drops __proto__/constructor/prototype keys everywhere and does not pollute Object.prototype', () => {
    const r = parsePostmanCollection(fixtureText('invalid/proto-pollution.json'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    const keys = ownKeysDeep([r.bundle, r.warnings]);
    expect(keys).not.toContain('__proto__');
    expect(keys).not.toContain('constructor');
    expect(keys).not.toContain('prototype');
    const req = requestAt(r.bundle.items, 0);
    expect(req.metadata.itemExtras).toEqual({ 'x-custom': { harmless: true, list: [{ ok: 1 }] } });
    expect(req.settings).toEqual({ followRedirects: false });
    expect(r.bundle.sourceMetadata.extra).toEqual({ 'x-top-level': { keep: 'me' } });
    expect(r.warnings.filter((w) => /unsafe key/i.test(w.message)).length).toBeGreaterThanOrEqual(6);
  });

  it('stays clean through export and re-import', () => {
    const r = parsePostmanCollection(fixtureText('invalid/proto-pollution.json'));
    const text = serializePostmanJson(exportPostmanCollection(r.bundle));
    expect(text).not.toContain('polluted');
    expect(ownKeysDeep(JSON.parse(text))).not.toContain('__proto__');
    const again = parsePostmanCollection(text);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(again.bundle.sourceMetadata.extra).toEqual({ 'x-top-level': { keep: 'me' } });
  });

  it('is safe against pollution through parsed (non-text) input and environments', () => {
    const doc = JSON.parse('{"info":{"name":"x"},"item":[],"__proto__":{"polluted":true},"x":{"__proto__":{"polluted":true}}}');
    parsePostmanCollection(doc);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('size and shape limits', () => {
  it('rejects oversized text with IMPORT_TOO_LARGE before parsing', () => {
    const text = fixtureText('get-simple.json');
    expect(failure(() => parsePostmanCollection(text, { maxBytes: 100 })).code).toBe('IMPORT_TOO_LARGE');
    expect(() => parsePostmanCollection(text, { maxBytes: text.length })).not.toThrow();
    // not even valid JSON: the size check comes first
    expect(failure(() => parsePostmanCollection('x'.repeat(200), { maxBytes: 100 })).code).toBe('IMPORT_TOO_LARGE');
  });

  it('rejects collections with too many items with IMPORT_TOO_LARGE', () => {
    const items = Array.from({ length: 30 }, (_, i) => requestItem({ method: 'GET', url: `http://x/${i}` }));
    expect(failure(() => parsePostmanCollection(collectionOf(items), { maxItems: 10 })).code).toBe('IMPORT_TOO_LARGE');
    expect(parsePostmanCollection(collectionOf(items), { maxItems: 30 }).stats.requests).toBe(30);
  });

  it('rejects folders nested deeper than maxDepth (default 64)', () => {
    expect(parsePostmanCollection(nestedFolders(63)).stats.folders).toBe(63);
    const err = failure(() => parsePostmanCollection(nestedFolders(70)));
    expect(err.code).toBe('IMPORT_INVALID');
    expect(err.message).toMatch(/nested deeper/);
    expect(failure(() => parsePostmanCollection(nestedFolders(5), { maxDepth: 3 })).code).toBe('IMPORT_INVALID');
    expect(parsePostmanCollection(nestedFolders(2), { maxDepth: 3 }).stats.folders).toBe(2);
  });

  it('survives absurdly deep nesting inside preserved extras and very deep folder trees', () => {
    const depth = 3000;
    const text = `{"info":{"name":"x"},"item":[{"name":"r","request":{"method":"GET","url":"http://x"},"x-deep":${'['.repeat(depth)}${']'.repeat(depth)}}]}`;
    expect(failure(() => parsePostmanCollection(text)).code).toBe('IMPORT_INVALID');
    expect(failure(() => parsePostmanCollection(nestedFolders(20_000))).code).toBe('IMPORT_INVALID');
  });
});

describe('malformed input', () => {
  const codes = (input: string | object) => failure(() => parsePostmanCollection(input)).code;

  it('rejects text that is not JSON', () => {
    const err = failure(() => parsePostmanCollection(fixtureText('invalid/not-json.txt')));
    expect(err.code).toBe('IMPORT_INVALID');
    expect(err.message).toMatch(/not valid JSON/);
    expect((err.details.warnings as Array<{ severity: string }>)[0]!.severity).toBe('ERROR');
    expect(codes('')).toBe('IMPORT_INVALID');
  });

  it('rejects JSON that is not a collection, with ERROR warnings attached', () => {
    for (const input of ['{}', fixtureText('invalid/empty-object.json'), fixtureText('invalid/missing-info.json'), '[]', 'null', '42', '"text"']) {
      const err = failure(() => parsePostmanCollection(input));
      expect(err.code, input).toBe('IMPORT_INVALID');
      const warnings = err.details.warnings as Array<{ severity: string; message: string }>;
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.every((w) => w.severity === 'ERROR')).toBe(true);
    }
    expect(codes({ info: { name: 'x' } })).toBe('IMPORT_INVALID');
    expect(codes({ info: {}, item: [] })).toBe('IMPORT_INVALID');
    expect(codes({ info: { name: 5 }, item: [] })).toBe('IMPORT_INVALID');
    expect(codes({ info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json' }, item: [] })).toBe('IMPORT_INVALID');
  });

  it('points environments at the right importer', () => {
    expect(failure(() => parsePostmanCollection(fixtureText('environment-basic.json'))).message).toMatch(/environment/);
    expect(failure(() => parsePostmanCollection(fixtureText('globals-basic.json'))).message).toMatch(/globals/);
  });
});

describe('WarningCollector', () => {
  it('truncates source values and caps the number of warnings with a final INFO', () => {
    const w = new WarningCollector();
    w.warn('a', 'long', 'x'.repeat(1000));
    expect(w.toArray()[0]!.sourceValue!.length).toBeLessThanOrEqual(301);
    for (let i = 0; i < MAX_WARNINGS + 50; i++) w.warn(`p${i}`, 'noise');
    w.error('e', 'errors are never suppressed');
    const all = w.toArray();
    expect(all.length).toBe(MAX_WARNINGS + 1 + 1);
    expect(all.at(-1)).toEqual({ severity: 'INFO', path: '', message: '51 more warnings suppressed' });
    expect(all.some((x) => x.severity === 'ERROR')).toBe(true);
    expect(w.hasErrors).toBe(true);
  });

  it('keeps import reports bounded for a hostile collection full of unknown fields', () => {
    const items = Array.from({ length: 2500 }, (_, i) => ({ ...requestItem({ method: 'GET', url: 'http://x' }), [`unknown${i}`]: 'y'.repeat(5000) }));
    const r = parsePostmanCollection(collectionOf(items));
    expect(r.warnings.length).toBeLessThanOrEqual(MAX_WARNINGS + 1);
    expect(r.warnings.at(-1)!.message).toMatch(/more warnings suppressed/);
    expect(r.warnings.every((x) => (x.sourceValue ?? '').length <= 301)).toBe(true);
    expect(requestAt(r.bundle.items, 2499).metadata.itemExtras).toEqual({ unknown2499: 'y'.repeat(5000) });
  });
});
