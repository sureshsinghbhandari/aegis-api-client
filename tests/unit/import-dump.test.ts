import { describe, expect, it } from 'vitest';
import { importDocument, parsePostmanDump } from '@aegis/postman';
import { folderAt, requestAt } from './_postman-fixtures';
import { expectRoundTrip, failure, formatFixtureText, ownKeysDeep } from './_format-fixtures';

const text = formatFixtureText('dump', 'backup.json');
const r = parsePostmanDump(text);

describe('Postman data dump import', () => {
  it('imports every v2 and v1 collection, environment and the globals', () => {
    expect(r.format).toBe('postman-dump');
    expect(r.collections.map((c) => c.name)).toEqual(['Orders API', 'Legacy Billing']);
    expect(r.environments.map((e) => e.name)).toEqual(['Dev', 'Prod']);
    expect(r.globals?.name).toBe('Globals');
    expect(r.globals?.variables).toEqual([
      { key: 'tenant', initialValue: 'acme', isSecret: false, enabled: true, type: 'default' },
      { key: 'region', initialValue: 'eu', isSecret: false, enabled: false, type: 'default' },
    ]);
    expect(r.environments[1]!.variables[1]).toEqual({ key: 'apiKey', initialValue: 'prod-literal', isSecret: true, enabled: true, type: 'secret' });
    expect(r.stats).toEqual({ folders: 2, requests: 4, variables: 6, scripts: 1, examples: 0 });
  });

  it('dispatches v2 collections to the v2 importer and v1 collections to the v1 importer', () => {
    const orders = r.collections[0]!;
    expect(orders.uid).toBe('6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
    expect(orders.postmanSchemaVersion).toBe('2.1.0');
    expect(requestAt(folderAt(orders.items, 0).items, 1).body.rawLanguage).toBe('json');
    const billing = r.collections[1]!;
    expect(billing.postmanSchemaVersion).toBe('1.0.0');
    expect(billing.items.map((i) => (i.kind === 'folder' ? `folder:${i.name}` : i.request.name))).toEqual(['folder:Payments', 'List invoices']);
    const invoices = requestAt(billing.items, 1);
    expect(invoices.auth).toEqual({ type: 'bearer', params: { token: 'billing-literal' } });
    expect(invoices.queryParams).toEqual([{ key: 'limit', value: '10', enabled: true }]);
    const pay = requestAt(folderAt(billing.items, 0).items, 0);
    expect(pay.pathVariables).toEqual([{ key: 'id', value: 'INV-1', enabled: true }]);
    expect(pay.scripts).toHaveLength(1);
    for (const c of r.collections) expectRoundTrip(c);
  });

  it('skips broken members with prefixed warnings instead of failing the whole dump', () => {
    const lines = r.warnings.map((w) => `${w.severity} ${w.path}: ${w.message}`);
    expect(lines).toContain('WARNING collections[2]: Collection "Broken entry" is neither a v1 nor a v2 collection; skipped');
    expect(lines).toContain('WARNING collections[3]: Collection entry is not an object; skipped');
    expect(lines).toContain('WARNING environments[2]: Environment entry has no "values" array; skipped');
    expect(lines).toContain('INFO headerPresets: 1 header preset(s) are not imported');
    expect(lines).toContain('INFO collections[1]: Postman Collection v1 imported; it is exported as Collection v2.1');
    expect(r.warnings.every((w) => w.path === '' || /^(collections\[\d+\]|environments\[\d+\]|globals|headerPresets|version)/.test(w.path))).toBe(true);
    expect(r.warnings.some((w) => w.severity === 'ERROR')).toBe(false);
  });

  it('is registered with importDocument', () => {
    const doc = importDocument(text, { fileName: 'backup.json' });
    expect(doc.format).toBe('postman-dump');
    expect(doc.name).toBe('Postman data dump (2 collections, 2 environments, globals)');
    expect(doc.collections.map((c) => c.name)).toEqual(['Orders API', 'Legacy Billing']);
    expect(doc.environments).toHaveLength(2);
    expect(doc.globals?.map((v) => v.key)).toEqual(['tenant', 'region']);
    expect(doc.schemaVersion).toBe('1');
    expect(doc.stats).toEqual(r.stats);
  });

  it('accepts globals as an object with values and an empty dump with a warning', () => {
    const objGlobals = parsePostmanDump({ collections: [], globals: { name: 'My globals', values: [{ key: 'a', value: '1' }] } });
    expect(objGlobals.globals?.name).toBe('My globals');
    expect(objGlobals.globals?.variables).toEqual([{ key: 'a', initialValue: '1', isSecret: false, enabled: true }]);
    const empty = parsePostmanDump({ version: '1', collections: [], environments: [], globals: [] });
    expect(empty.collections).toEqual([]);
    expect(empty.globals).toBeUndefined();
    expect(empty.warnings).toEqual([{ severity: 'WARNING', path: '', message: 'The data dump contains no collections, environments or globals' }]);
  });
});

describe('Postman data dump import: hostile input', () => {
  const brokenText = formatFixtureText('dump', 'invalid/all-broken.json');

  it('fails with IMPORT_INVALID (carrying the member errors) when nothing can be imported', () => {
    const err = failure(() => parsePostmanDump(brokenText));
    expect(err.code).toBe('IMPORT_INVALID');
    expect(err.message).toMatch(/No member of the data dump/);
    const warnings = err.details.warnings as Array<{ severity: string; path: string; message: string }>;
    expect(warnings.some((w) => w.severity === 'ERROR' && w.path === 'collections[0].item')).toBe(true);
    expect(warnings.some((w) => w.severity === 'WARNING' && w.path === 'collections[1]')).toBe(true);
    expect(warnings.some((w) => w.severity === 'WARNING' && w.path === 'environments')).toBe(true);
    expect(warnings.some((w) => w.severity === 'WARNING' && w.path === 'globals')).toBe(true);
    expect(warnings.some((w) => w.severity === 'INFO' && w.path === 'version')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(ownKeysDeep(warnings)).not.toContain('__proto__');
  });

  it('propagates size and item limits (including per-member limits)', () => {
    expect(failure(() => parsePostmanDump(text, { maxBytes: 100 })).code).toBe('IMPORT_TOO_LARGE');
    expect(failure(() => parsePostmanDump(text, { maxItems: 2 })).code).toBe('IMPORT_TOO_LARGE');
    expect(parsePostmanDump(text, { maxItems: 7 }).collections).toHaveLength(2);
    // the limit also applies inside each member collection
    const big = { collections: [{ info: { name: 'big' }, item: Array.from({ length: 30 }, (_, i) => ({ name: `r${i}`, request: { method: 'GET', url: `https://x/${i}` } })) }], environments: [] };
    expect(failure(() => parsePostmanDump(big, { maxItems: 10 })).code).toBe('IMPORT_TOO_LARGE');
    expect(parsePostmanDump(big, { maxItems: 30 }).stats.requests).toBe(30);
  });

  it('rejects documents that are not dumps', () => {
    for (const input of ['{}', '[]', 'null', '{"collections":{}}', '{"environments":[]}', 'not json']) {
      const err = failure(() => parsePostmanDump(input));
      expect(err.code, input).toBe('IMPORT_INVALID');
      expect((err.details.warnings as Array<{ severity: string }>).every((w) => w.severity === 'ERROR')).toBe(true);
    }
    expect(failure(() => parsePostmanDump(formatFixtureText('postman', 'get-simple.json'))).message).toMatch(/single Postman collection/);
  });
});
