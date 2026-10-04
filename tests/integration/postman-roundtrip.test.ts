import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareCollectionBundles,
  detectPostmanFormat,
  exportPostmanCollection,
  parsePostmanCollection,
  serializePostmanJson,
  validatePostmanV21Structure,
} from '@aegis/postman';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/postman', import.meta.url));

type Json = Record<string, any>;

const fixtureNames = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
const collectionFixtures = fixtureNames.filter((f) => detectPostmanFormat(JSON.parse(readFileSync(path.join(FIXTURE_DIR, f), 'utf8'))).startsWith('collection'));
const v21Fixtures = collectionFixtures.filter((f) => detectPostmanFormat(readJson(f)) === 'collection-v2.1');

function readText(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}
function readJson(name: string): Json {
  return JSON.parse(readText(name)) as Json;
}

interface Flat {
  folders: string[];
  requests: Array<{ path: string; method: string; raw: string; headerKeys: string[]; bodyRaw: string | undefined; graphql: unknown; authType: string | undefined; events: string[] }>;
}

function eventTexts(events: Json[] | undefined): string[] {
  return (events ?? [])
    .map((e) => {
      const exec = e.script?.exec;
      return `${e.listen}|${Array.isArray(exec) ? exec.join('\n') : (exec ?? `src:${e.script?.src}`)}`;
    })
    .sort();
}

function flatten(items: Json[], prefix: string, out: Flat): Flat {
  for (const item of items) {
    const here = `${prefix}/${item.name}`;
    if (Array.isArray(item.item)) {
      out.folders.push(`${here}|auth:${item.auth?.type}|events:${eventTexts(item.event).join('~')}`);
      flatten(item.item, here, out);
    } else {
      const r = item.request as Json;
      out.requests.push({
        path: here,
        method: r.method,
        raw: typeof r.url === 'string' ? r.url : r.url.raw,
        headerKeys: (r.header ?? []).map((h: Json) => h.key),
        bodyRaw: r.body?.raw,
        graphql: r.body?.graphql,
        authType: r.auth?.type,
        events: eventTexts(item.event),
      });
    }
  }
  return out;
}

function walk(value: unknown, visit: (s: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, visit));
}

describe('Postman round trip', () => {
  it('finds the fixtures', () => {
    expect(collectionFixtures.length).toBeGreaterThanOrEqual(22);
    expect(v21Fixtures).toContain('kitchen-sink.json');
  });

  describe.each(collectionFixtures)('%s', (name) => {
    const text = readText(name);
    const first = parsePostmanCollection(text);
    const exported = exportPostmanCollection(first.bundle, { includeSecrets: true });
    const exportedText = serializePostmanJson(exported);

    it('exports a structurally valid Postman v2.1 collection', () => {
      expect(validatePostmanV21Structure(exported)).toEqual([]);
      expect(detectPostmanFormat(exported)).toBe('collection-v2.1');
    });

    it('re-imports to a semantically equal bundle', () => {
      const second = parsePostmanCollection(exportedText);
      expect(compareCollectionBundles(first.bundle, second.bundle)).toEqual([]);
      expect(second.stats).toEqual(first.stats);
    });

    it('is deterministic and idempotent', () => {
      expect(serializePostmanJson(exportPostmanCollection(first.bundle, { includeSecrets: true }))).toBe(exportedText);
      const second = parsePostmanCollection(exportedText);
      expect(serializePostmanJson(exportPostmanCollection(second.bundle, { includeSecrets: true }))).toBe(exportedText);
    });

    it('the secret-free export is valid and re-imports equal ignoring secrets', () => {
      const safe = exportPostmanCollection(first.bundle);
      expect(validatePostmanV21Structure(safe)).toEqual([]);
      const again = parsePostmanCollection(serializePostmanJson(safe));
      expect(compareCollectionBundles(first.bundle, again.bundle, { ignoreSecrets: true })).toEqual([]);
    });

    it('never leaks literal credentials unless includeSecrets is set', () => {
      const literals = [...new Set(text.match(/[A-Za-z0-9._]+-literal[A-Za-z0-9._-]*|literal-[A-Za-z0-9._-]+/g) ?? [])];
      const safeText = serializePostmanJson(exportPostmanCollection(first.bundle));
      for (const literal of literals) {
        expect(exportedText, `${literal} should be present with includeSecrets`).toContain(literal);
        expect(safeText, `${literal} leaked into the secret-free export`).not.toContain(literal);
      }
    });
  });

  describe.each(v21Fixtures)('%s (JSON level)', (name) => {
    it('preserves counts, structure, methods, URLs, header keys, bodies, scripts and auth types', () => {
      const original = readJson(name);
      const { bundle } = parsePostmanCollection(JSON.stringify(original));
      const exported = JSON.parse(serializePostmanJson(exportPostmanCollection(bundle, { includeSecrets: true }))) as Json;
      const a = flatten(original.item, '', { folders: [], requests: [] });
      const b = flatten(exported.item, '', { folders: [], requests: [] });
      expect(b.requests.length).toBe(a.requests.length);
      expect(b.folders).toEqual(a.folders);
      expect(b.requests).toEqual(a.requests);
      expect(exported.info.name).toBe(original.info.name);
      expect(exported.info._postman_id).toBe(original.info._postman_id);
      expect(eventTexts(exported.event)).toEqual(eventTexts(original.event));
      expect(exported.auth?.type).toBe(original.auth?.type);
      expect(exported.variable ?? []).toEqual(original.variable ?? []);
    });

    it('preserves every string value of the source that is not intentionally restructured', () => {
      // A coarse "nothing silently lost" check: each source string (other than generated URL parts) still appears in the export.
      const original = readJson(name);
      const exportedText = serializePostmanJson(exportPostmanCollection(parsePostmanCollection(JSON.stringify(original)).bundle, { includeSecrets: true }));
      const missing: string[] = [];
      walk(original, (s) => {
        // Raw header strings ("A: b\nC: d") are intentionally converted to header arrays.
        const isHeaderString = /^[\w-]+: .*\n/.test(s);
        if (s.length > 2 && !isHeaderString && !exportedText.includes(JSON.stringify(s).slice(1, -1))) missing.push(s);
      });
      expect(missing).toEqual([]);
    });
  });
});
