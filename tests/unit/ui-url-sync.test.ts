import { composeDisplayUrl } from '@aegis/core';
import { describe, expect, it } from 'vitest';
import { applyUrlEdit, findVariableReferences, syncPathVariables } from '../../apps/desktop/renderer/src/lib/urlSync';

const kv = (key: string, value = '', enabled = true) => ({ key, value, enabled });

describe('applyUrlEdit', () => {
  it('splits the query into params and keeps disabled ones', () => {
    const patch = applyUrlEdit('https://x.test/a?p=1&q=two', { queryParams: [kv('old', 'z', false)], pathVariables: [] });
    expect(patch.url).toBe('https://x.test/a');
    expect(patch.queryParams).toEqual([kv('p', '1'), kv('q', 'two'), kv('old', 'z', false)]);
  });
  it('round-trips through composeDisplayUrl', () => {
    const patch = applyUrlEdit('{{base}}/users?limit=10&sort=name', { queryParams: [], pathVariables: [] });
    expect(composeDisplayUrl(patch.url, patch.queryParams)).toBe('{{base}}/users?limit=10&sort=name');
  });
  it('adds path variables for :segments and keeps their values', () => {
    const patch = applyUrlEdit('https://x.test/users/:id/posts/:postId', { queryParams: [], pathVariables: [kv('id', '42')] });
    expect(patch.pathVariables).toEqual([kv('id', '42'), kv('postId', '')]);
  });
});

describe('syncPathVariables', () => {
  it('drops removed variables only when empty', () => {
    const out = syncPathVariables('https://x.test/a/:keep', [kv('keep', '1'), kv('gone', ''), kv('goneWithValue', 'x')]);
    expect(out).toEqual([kv('keep', '1'), kv('goneWithValue', 'x')]);
  });
  it('ignores port numbers and query strings', () => {
    expect(syncPathVariables('http://localhost:8080/a?x=:y', [])).toEqual([]);
  });
});

describe('findVariableReferences', () => {
  it('lists unique names', () => {
    expect(findVariableReferences('{{a}}/x/{{ b }}/{{a}}')).toEqual(['a', 'b']);
    expect(findVariableReferences('no vars')).toEqual([]);
  });
});
