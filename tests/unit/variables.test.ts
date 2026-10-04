import { describe, expect, it } from 'vitest';
import { DynamicVariableRegistry, TableDynamicProvider, VARIABLE_PRECEDENCE, VariableResolver, scopeFromEntries, scopeFromRecord } from '@aegis/variables';
import { emptyRequestDraft } from '@aegis/core';

const S = (r: Record<string, string>, secret = false) => scopeFromRecord(r, secret);

describe('variable precedence (single central resolver)', () => {
  it('documents the order: request > local > iteration > environment > folder > collection > global', () => {
    expect([...VARIABLE_PRECEDENCE]).toEqual(['request', 'local', 'iteration', 'environment', 'folder', 'collection', 'global']);
  });

  const all = {
    request: S({ v: 'request' }),
    local: S({ v: 'local' }),
    iteration: S({ v: 'iteration' }),
    environment: S({ v: 'environment' }),
    folders: [S({ v: 'inner' }), S({ v: 'outer' })],
    collection: S({ v: 'collection' }),
    global: S({ v: 'global' }),
  };

  // every adjacent pair: remove higher scopes one by one and the next one wins
  const order: Array<[string, (s: typeof all) => Partial<typeof all>]> = [
    ['request', (s) => s],
    ['local', ({ request: _r, ...s }) => s],
    ['iteration', ({ request: _r, local: _l, ...s }) => s],
    ['environment', ({ request: _r, local: _l, iteration: _i, ...s }) => s],
    ['inner', ({ request: _r, local: _l, iteration: _i, environment: _e, ...s }) => s],
    ['outer', ({ request: _r, local: _l, iteration: _i, environment: _e, folders, ...s }) => ({ ...s, folders: [folders[1]!] })],
    ['collection', ({ request: _r, local: _l, iteration: _i, environment: _e, folders: _f, ...s }) => s],
    ['global', ({ collection: _c, request: _r, local: _l, iteration: _i, environment: _e, folders: _f, ...s }) => s],
  ];
  for (const [expected, pick] of order) {
    it(`resolves from ${expected} when higher-precedence scopes are absent`, () => {
      expect(new VariableResolver(pick(all)).resolveString('{{v}}')).toBe(expected);
    });
  }

  it('reports which scope a variable came from', () => {
    expect(new VariableResolver(all).lookup('v')?.scope).toBe('request');
    expect(new VariableResolver({ environment: S({ a: '1' }), global: S({ a: '2' }) }).lookup('a')).toMatchObject({ scope: 'environment', value: '1' });
    expect(new VariableResolver({}).lookup('nope')).toBeUndefined();
  });
});

describe('interpolation', () => {
  it('leaves unresolved variables untouched and lists them', () => {
    const r = new VariableResolver({ environment: S({ a: '1' }) });
    expect(r.resolveString('{{a}}-{{missing}}-{{ a }}')).toBe('1-{{missing}}-1');
    expect(r.unresolved('{{a}} {{missing}} {{$guid}} {{other}}').sort()).toEqual(['missing', 'other']);
  });

  it('resolves nested variables, and stops on cycles', () => {
    const r = new VariableResolver({ environment: S({ host: 'api.test', url: 'https://{{host}}/v1', a: '{{b}}', b: '{{a}}' }) });
    expect(r.resolveString('{{url}}')).toBe('https://api.test/v1');
    expect(r.resolveString('{{a}}')).toBeTypeOf('string'); // terminates
  });

  it('uses disabled rows never, and current value over initial value', () => {
    const scope = scopeFromEntries([
      { key: 'a', initialValue: 'init', currentValue: 'cur', isSecret: false, enabled: true },
      { key: 'b', initialValue: 'init', isSecret: false, enabled: true },
      { key: 'c', initialValue: 'x', isSecret: false, enabled: false },
      { key: 's', initialValue: 'shh-secret', isSecret: true, enabled: true },
    ]);
    const r = new VariableResolver({ environment: scope });
    expect(r.resolveString('{{a}} {{b}} {{c}}')).toBe('cur init {{c}}');
    expect(r.secretValues()).toEqual(['shh-secret']);
  });

  it('resolves dynamic variables through providers (not hard coded) and unknown ones stay', () => {
    const r = new VariableResolver({}, new DynamicVariableRegistry().register(new TableDynamicProvider({ $answer: () => '42' })));
    expect(r.resolveString('{{$answer}}/{{$nope}}')).toBe('42/{{$nope}}');
    const def = new VariableResolver({});
    expect(def.resolveString('{{$guid}}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(def.resolveString('{{$randomUUID}}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(def.resolveString('{{$timestamp}}'))).toBeGreaterThan(1_600_000_000);
    expect(Number.isInteger(Number(def.resolveString('{{$randomInt}}')))).toBe(true);
  });

  it('resolveRequest interpolates every field without mutating the stored request', () => {
    const draft = emptyRequestDraft({
      url: '{{base}}/u/:id',
      headers: [{ key: 'X-{{h}}', value: 'v{{n}}', enabled: true }],
      queryParams: [{ key: 'q', value: '{{n}}', enabled: true }],
      pathVariables: [{ key: 'id', value: '{{n}}', enabled: true }],
      body: { mode: 'raw', raw: '{"n":"{{n}}"}', urlencoded: [{ key: 'k', value: '{{n}}', enabled: true }], formData: [{ key: 'f', type: 'variable', value: 'n', enabled: true }] },
    });
    const snapshot = JSON.stringify(draft);
    const out = new VariableResolver({ environment: S({ base: 'http://x', h: 'H', n: '7' }) }).resolveRequest(draft);
    expect(out.url).toBe('http://x/u/:id');
    expect(out.headers[0]).toMatchObject({ key: 'X-H', value: 'v7' });
    expect(out.queryParams[0]!.value).toBe('7');
    expect(out.pathVariables[0]!.value).toBe('7');
    expect(out.body.raw).toBe('{"n":"7"}');
    expect(out.body.formData![0]).toMatchObject({ type: 'text', value: '7' });
    expect(JSON.stringify(draft)).toBe(snapshot);
  });
});
