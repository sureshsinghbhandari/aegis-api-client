import { describe, expect, it } from 'vitest';
import {
  applyPathVariables,
  buildRequestUrl,
  composeDisplayUrl,
  extractPathVariableNames,
  parseDisplayUrl,
  parseQueryString,
  serializeQuery,
} from '@aegis/core';

const kv = (key: string, value: string, enabled = true) => ({ key, value, enabled });

describe('URL building', () => {
  it('appends only enabled query params, encodes them, and never double-encodes', () => {
    const url = buildRequestUrl('https://api.test/users', [kv('page', '1'), kv('q', 'a b&c'), kv('debug', 'true', false), kv('pre', '%41')], []);
    expect(url).toBe('https://api.test/users?page=1&q=a%20b%26c&pre=%41');
  });
  it('merges a query already present in the URL', () => {
    expect(buildRequestUrl('https://x.test/a?z=1', [kv('y', '2')], [])).toBe('https://x.test/a?z=1&y=2');
  });
  it('replaces :pathVariables only in the path (not the port) and encodes values', () => {
    expect(applyPathVariables('http://localhost:8080/users/:id/files/:name', [kv('id', '42'), kv('name', 'a/b c')])).toBe('http://localhost:8080/users/42/files/a%2Fb%20c');
    expect(applyPathVariables('http://h/users/:missing', [])).toBe('http://h/users/:missing');
    expect(applyPathVariables('http://h/u/:id', [kv('id', '1', false)])).toBe('http://h/u/:id');
  });
  it('defaults the scheme to http and drops fragments', () => {
    expect(buildRequestUrl('localhost:3000/x#frag', [], [])).toBe('http://localhost:3000/x');
  });
  it('lists path variable names', () => {
    expect(extractPathVariableNames('https://h:8080/a/:x/b/:y/:x')).toEqual(['x', 'y']);
    expect(extractPathVariableNames('https://h:8080')).toEqual([]);
  });
});

describe('URL bar <-> params table sync', () => {
  it('round-trips and keeps disabled params', () => {
    const params = [kv('a', '1'), kv('off', 'x', false)];
    expect(composeDisplayUrl('https://h/p', params)).toBe('https://h/p?a=1');
    const parsed = parseDisplayUrl('https://h/p?a=1&b=two%20words', params);
    expect(parsed.url).toBe('https://h/p');
    expect(parsed.queryParams.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['a', '1', true],
      ['b', 'two words', true],
      ['off', 'x', false],
    ]);
  });
  it('parses/serialises edge cases', () => {
    expect(parseQueryString('a&b=&=c')).toEqual([kv('a', ''), kv('b', ''), kv('', 'c')]);
    expect(serializeQuery([kv('a', ''), kv('', 'x')])).toBe('a');
  });
});
