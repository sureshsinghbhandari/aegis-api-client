import { describe, expect, it } from 'vitest';
import type { VariableEntry } from '@aegis/core';
import { COMMON_DYNAMIC_VARIABLES, VARIABLE_PRECEDENCE } from '@aegis/variables';
import {
  applyCompletion,
  buildVariableIndex,
  completionContext,
  describeHint,
  DYNAMIC_VARIABLE_NAMES,
  filterCompletions,
  findVariableTokens,
  HINT_PRECEDENCE,
  isUnresolved,
  lookupHint,
  MASK,
  unresolvedIn,
} from '../../apps/desktop/renderer/src/lib/variable-hints';

const v = (key: string, initialValue: string, extra: Partial<VariableEntry> = {}): VariableEntry => ({ key, initialValue, isSecret: false, enabled: true, ...extra });

const index = buildVariableIndex({
  environment: { owner: 'Staging', entries: [v('baseUrl', 'https://staging.test'), v('token', 'secretref:var:1', { isSecret: true }), v('off', 'x', { enabled: false })] },
  folders: [
    { owner: 'Inner', entries: [v('folderVar', 'inner')] },
    { owner: 'Outer', entries: [v('folderVar', 'outer'), v('outerOnly', 'o')] },
  ],
  collection: { owner: 'API', entries: [v('baseUrl', 'https://collection.test'), v('collVar', 'c', { currentValue: 'current' })] },
  global: { entries: [v('globalVar', 'g'), v('baseUrl', 'https://global.test')] },
});

describe('variable hints: precedence and lookup', () => {
  it('mirrors the resolver precedence for the static scopes', () => {
    const staticScopes = VARIABLE_PRECEDENCE.filter((s) => s !== 'request' && s !== 'local' && s !== 'iteration');
    expect([...HINT_PRECEDENCE]).toEqual(staticScopes);
    expect(DYNAMIC_VARIABLE_NAMES).toEqual(Object.keys(COMMON_DYNAMIC_VARIABLES));
  });

  it('environment wins over folder, collection and globals; shadowed definitions are reported', () => {
    const hit = lookupHint(index, 'baseUrl')!;
    expect(hit).toMatchObject({ scope: 'environment', owner: 'Staging', value: 'https://staging.test', secret: false });
    expect(hit.shadowed.map((s) => s.scope)).toEqual(['collection', 'global']);
    expect(lookupHint(index, 'folderVar')).toMatchObject({ scope: 'folder', owner: 'Inner', value: 'inner' });
    expect(lookupHint(index, 'outerOnly')).toMatchObject({ scope: 'folder', owner: 'Outer' });
    expect(lookupHint(index, 'globalVar')).toMatchObject({ scope: 'global', value: 'g' });
  });

  it('uses the current value, skips disabled rows and flags secrets', () => {
    expect(lookupHint(index, 'collVar')!.value).toBe('current');
    expect(lookupHint(index, 'off')).toBeUndefined();
    expect(lookupHint(index, 'token')).toMatchObject({ secret: true });
    expect(describeHint(index, 'token').detail).toContain(MASK);
    expect(describeHint(index, 'token').detail).not.toContain('secretref');
  });

  it('treats $dynamic names as resolved and everything unknown as unresolved', () => {
    expect(isUnresolved(index, '$guid')).toBe(false);
    expect(lookupHint(index, '$timestamp')!.scope).toBe('dynamic');
    expect(isUnresolved(index, 'nope')).toBe(true);
    expect(describeHint(index, 'nope')).toMatchObject({ unresolved: true });
    expect(unresolvedIn(index, '{{baseUrl}}/{{nope}}/{{ nope }}/{{$guid}}/{{other}}')).toEqual(['nope', 'other']);
  });
});

describe('variable hints: tokens and completion', () => {
  it('finds tokens with offsets (trimmed names, no nested braces)', () => {
    expect(findVariableTokens('a{{x}}b{{ y }}{{}}{{{z}}}')).toEqual([
      { name: 'x', start: 1, end: 6 },
      { name: 'y', start: 7, end: 14 },
      { name: 'z', start: 19, end: 24 }, // same as the resolver: the innermost `{{z}}` is a reference
    ]);
    expect(findVariableTokens('plain')).toEqual([]);
  });

  it('detects an unfinished {{prefix at the caret', () => {
    expect(completionContext('http://{{ba', 11)).toEqual({ start: 7, prefix: 'ba' });
    expect(completionContext('http://{{', 9)).toEqual({ start: 7, prefix: '' });
    expect(completionContext('http://{{base}}/x', 17)).toBeNull();
    expect(completionContext('{{a}} and {{b', 5)).toBeNull();
    expect(completionContext('{{a}} and {{b', 13)).toEqual({ start: 10, prefix: 'b' });
  });

  it('ranks prefix matches before substring matches and appends dynamic variables', () => {
    const names = filterCompletions(index, 'base').map((c) => c.name);
    expect(names[0]).toBe('baseUrl');
    // substring matches keep precedence order (folder before collection before globals)
    expect(filterCompletions(index, 'var').map((c) => c.name)).toEqual(['folderVar', 'collVar', 'globalVar']);
    const all = filterCompletions(index, '');
    expect(all.map((c) => c.name)).toContain('$guid');
    expect(all.find((c) => c.name === 'token')).toMatchObject({ secret: true, scope: 'environment', owner: 'Staging' });
    expect(filterCompletions(index, 'zzz')).toEqual([]);
    expect(filterCompletions(index, '', 3)).toHaveLength(3);
  });

  it('inserts {{name}} at the caret and reuses an existing closing }}', () => {
    expect(applyCompletion('http://{{ba/x', 11, 'baseUrl')).toEqual({ text: 'http://{{baseUrl}}/x', caret: 18 });
    expect(applyCompletion('{{ba}}', 4, 'baseUrl')).toEqual({ text: '{{baseUrl}}', caret: 11 });
    expect(applyCompletion('no context', 3, 'x')).toEqual({ text: 'no context', caret: 3 });
  });
});
