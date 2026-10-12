import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppError } from '@aegis/core';
import type { ItemNode, RequestDraft } from '@aegis/core';
import { exportPostmanCollection, importDocument, parseImportText, parseOpenApiDocument, serializePostmanJson, WarningCollector } from '@aegis/postman';

const DIR = fileURLToPath(new URL('../fixtures/openapi/', import.meta.url));
const text = (name: string) => readFileSync(`${DIR}${name}`, 'utf8');

function requests(items: ItemNode[]): RequestDraft[] {
  return items.flatMap((i) => (i.kind === 'folder' ? requests(i.items) : [i.request]));
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
function fails(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected a throw');
}

describe('$ref resolution is local-only', () => {
  const r = parseOpenApiDocument(text('external-refs.yaml'), { fileName: 'external-refs.yaml' });
  const warn = r.warnings.filter((w) => w.severity === 'WARNING').map((w) => w.message);

  it('never fetches external references and reports each one once', () => {
    for (const ref of ['./common.yaml#/components/parameters/Page', 'https://schemas.example.com/thing.json', 'file:///etc/passwd']) {
      expect(warn.filter((m) => m.includes(`External $ref "${ref}" is not fetched`)).length, ref).toBe(1);
    }
    expect(warn.some((m) => m.includes('externalValue examples are not fetched'))).toBe(true);
    expect(warn.some((m) => m.includes('"#/components/schemas/DoesNotExist" does not resolve'))).toBe(true);
    expect(warn.some((m) => m.includes('"#/components/schemas/__proto__" does not resolve'))).toBe(true);
  });

  it('leaves the referenced parts empty rather than inventing data', () => {
    const [list, create, secret] = requests(r.bundle.items);
    expect(list!.queryParams).toEqual([]);
    expect(list!.examples[0]!.body).toBe('');
    expect(JSON.parse(create!.body.raw!)).toEqual({ id: 'string' });
    expect(secret!.examples[0]!.body).toBe('');
    expect(JSON.stringify(r.bundle)).not.toContain('passwd');
  });
});

describe('recursive schemas', () => {
  const r = parseOpenApiDocument(text('recursive-refs.json'));
  const [tree, wide, loop] = requests(r.bundle.items);

  it('terminates on self-referencing schemas (no exponential blow-up) and keeps the output small', () => {
    expect(JSON.parse(tree!.body.raw!)).toEqual({ value: 'string', children: [] });
    expect(loop!.examples[0]!.body).toBe(''); // A -> B -> A: nothing to generate
  });

  it('caps generated values per example (8^5 = 32768 leaves would be generated otherwise)', () => {
    const body = JSON.parse(wide!.body.raw!);
    const leaves = JSON.stringify(body).match(/"string"/g)?.length ?? 0;
    expect(leaves).toBeLessThanOrEqual(2000);
    expect(wide!.body.raw!.length).toBeLessThan(200_000);
    expect(r.warnings.some((w) => /limited to 2000 values/.test(w.message))).toBe(true);
  });

  it('honours a custom depth limit', () => {
    const shallow = parseOpenApiDocument(text('recursive-refs.json'), { maxExampleDepth: 1 });
    const body = JSON.parse(requests(shallow.bundle.items)[1]!.body.raw!) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(Object.values(body).every((v) => JSON.stringify(v) === '{}')).toBe(true); // nothing below level 1
    expect(shallow.warnings.some((w) => /stops at 1 levels/.test(w.message))).toBe(true);
  });
});

describe('prototype pollution', () => {
  it('drops __proto__/constructor/prototype keys everywhere (JSON)', () => {
    const doc = JSON.parse(
      '{"openapi":"3.0.0","info":{"title":"p","x-ext":{"__proto__":{"polluted":true}}},"__proto__":{"polluted":true},"paths":{"/a":{"get":{"responses":{"200":{"description":"ok","content":{"application/json":{"schema":{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"},"ok":{"type":"string"}}}}}}}}}},"components":{"schemas":{"__proto__":{"type":"string"}}}}',
    );
    const r = parseOpenApiDocument(doc);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    const keys = ownKeysDeep([r.bundle, r.warnings]);
    expect(keys).not.toContain('__proto__');
    expect(keys).not.toContain('constructor');
    expect(keys).not.toContain('prototype');
    expect(JSON.parse(requests(r.bundle.items)[0]!.examples[0]!.body)).toEqual({ ok: 'string' });
    const exported = serializePostmanJson(exportPostmanCollection(r.bundle));
    expect(exported).not.toContain('polluted');
  });

  it('drops them for YAML input too', () => {
    const yaml = ['openapi: 3.0.0', 'info:', '  title: y', '"__proto__":', '  polluted: true', 'paths:', '  /a:', '    get:', '      responses:', '        "200":', '          description: ok', ''].join('\n');
    const r = parseOpenApiDocument(yaml, { fileName: 'x.yaml' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(ownKeysDeep(r.bundle)).not.toContain('__proto__');
  });
});

describe('YAML parsing limits', () => {
  it('rejects alias bombs (billion laughs) instead of expanding them', () => {
    const lines = ['openapi: 3.0.0', 'info: {title: bomb, version: "1"}', 'paths: {}', 'a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 9; i++) lines.push(`${'a'.repeat(i + 1)}: &${'a'.repeat(i + 1)} [*${'a'.repeat(i)}, *${'a'.repeat(i)}, *${'a'.repeat(i)}, *${'a'.repeat(i)}, *${'a'.repeat(i)}, *${'a'.repeat(i)}, *${'a'.repeat(i)}, *${'a'.repeat(i)}, *${'a'.repeat(i)}, *${'a'.repeat(i)}]`);
    const err = fails(() => parseOpenApiDocument(lines.join('\n'), { fileName: 'bomb.yaml' }));
    expect(err.code).toBe('IMPORT_INVALID');
    expect(err.message).toMatch(/not valid YAML/);
  });

  it('does not execute custom tags and refuses oversized YAML', () => {
    const w = new WarningCollector();
    const parsed = parseImportText('a: !!js/function "function(){return 1}"\nb: !!python/object/apply:os.system ["id"]\n', 'x.yaml', 1024 * 1024, w) as Record<string, unknown>;
    expect(typeof parsed.a).toBe('string'); // unknown tags are kept as plain text, never evaluated
    expect(typeof parsed.b === 'string' || Array.isArray(parsed.b)).toBe(true);
    expect(() => parseImportText('x'.repeat(10), 'x.yaml', 5, w)).toThrow(/larger than/);
  });

  it('rejects YAML nested too deeply', () => {
    const depth = 20_000;
    const doc = `openapi: 3.0.0\ninfo: {title: d}\npaths: {}\ndeep: ${'['.repeat(depth)}${']'.repeat(depth)}\n`;
    expect(fails(() => parseOpenApiDocument(doc, { fileName: 'd.yaml' })).code).toBe('IMPORT_INVALID');
  });
});

describe('importDocument (auto-detect)', () => {
  it('detects and dispatches each family', () => {
    expect(importDocument(text('petstore-3.0.json'), { fileName: 'p.json' }).format).toBe('openapi');
    expect(importDocument(text('petstore-3.1.yaml'), { fileName: 'p.yaml' }).format).toBe('openapi');
    expect(importDocument(text('swagger-2.0.json')).format).toBe('swagger');
    const pm = importDocument(readFileSync(fileURLToPath(new URL('../fixtures/postman/get-simple.json', import.meta.url)), 'utf8'));
    expect(pm.format).toBe('postman-collection');
    expect(pm.collections).toHaveLength(1);
    const env = importDocument(readFileSync(fileURLToPath(new URL('../fixtures/postman/globals-basic.json', import.meta.url)), 'utf8'));
    expect(env.format).toBe('postman-globals');
    expect(env.globals!.length).toBeGreaterThan(0);
  });

  it('refuses files from another family when the user chose a specific kind', () => {
    const err = fails(() => importDocument(text('petstore-3.0.json'), { expect: ['postman-collection', 'postman-v1'] }));
    expect(err.code).toBe('IMPORT_INVALID');
    expect(err.message).toMatch(/OpenAPI 3.x, not Postman Collection v2 \/ Postman Collection v1/);
    expect(err.details.detected).toBe('openapi');
  });

  it('rejects unknown formats and backups with ERROR warnings', () => {
    const err = fails(() => importDocument('{"hello":1}'));
    expect(err.code).toBe('IMPORT_INVALID');
    expect((err.details.warnings as Array<{ message: string }>)[0]!.message).toMatch(/not recognised/);
    expect(fails(() => importDocument('{"format":"aegis-backup","version":1,"workspaces":[]}')).message).toMatch(/backup/);
  });
});
