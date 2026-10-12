import { describe, expect, it } from 'vitest';
import type { VariableEntry } from '@aegis/core';
import { MASK } from '../../apps/desktop/renderer/src/lib/ui-format';
import {
  changedNames,
  displayValue,
  effectiveValue,
  filterRows,
  isSecretEntry,
  jsString,
  mergeVariable,
  readPaneOpen,
  snippetGet,
  snippetSet,
  templateRef,
  toRows,
  VARS_PANE_STORAGE_KEY,
  writePaneOpen,
} from '../../apps/desktop/renderer/src/lib/script-vars';
import { SNIPPETS } from '../../apps/desktop/renderer/src/workspace/scriptSupport';

const entry = (key: string, extra: Partial<VariableEntry> = {}): VariableEntry => ({ key, initialValue: 'init', isSecret: false, enabled: true, ...extra });

describe('script-vars snippets', () => {
  it('generates pm accessors per scope with safely quoted keys', () => {
    expect(snippetGet('environment', 'token')).toBe('pm.environment.get("token")');
    expect(snippetGet('globals', 'a"b')).toBe('pm.globals.get("a\\"b")');
    expect(snippetGet('collection', 'x')).toBe('pm.collectionVariables.get("x")');
    // folder variables are folded into the collection scope by the executor
    expect(snippetGet('folder', 'x')).toBe('pm.collectionVariables.get("x")');
    expect(snippetSet('environment', 'token', 'abc')).toBe('pm.environment.set("token", "abc");\n');
    expect(jsString("it's")).toBe('"it\'s"');
    expect(templateRef('baseUrl')).toBe('{{baseUrl}}');
  });
  it('never writes a secret value into a set snippet', () => {
    const code = snippetSet('environment', 'apiKey', 'secretref:abc', true);
    expect(code).not.toContain('secretref');
    expect(code).toBe('pm.environment.set("apiKey", \'new value\');\n');
  });
});

describe('script-vars masking and rows', () => {
  it('prefers the current value and falls back to the initial value', () => {
    expect(effectiveValue(entry('a'))).toBe('init');
    expect(effectiveValue(entry('a', { currentValue: '' }))).toBe('init');
    expect(effectiveValue(entry('a', { currentValue: 'cur' }))).toBe('cur');
  });
  it('masks secrets and secret references, never showing the ref string', () => {
    expect(isSecretEntry(entry('a'))).toBe(false);
    expect(isSecretEntry(entry('a', { isSecret: true }))).toBe(true);
    expect(isSecretEntry(entry('a', { currentValue: 'secretref:xyz' }))).toBe(true);
    expect(displayValue(entry('a', { isSecret: true, initialValue: 'secretref:xyz' }))).toBe(MASK);
    expect(displayValue(entry('a', { currentValue: 'plain' }))).toBe('plain');
    const rows = toRows('environment', 'env1', 'Environment', [entry('k', { isSecret: true, initialValue: 'secretref:1' }), entry(''), entry('p', { currentValue: 'v', enabled: false })]);
    expect(rows.map((r) => r.key)).toEqual(['k', 'p']);
    expect(rows[0]).toMatchObject({ scope: 'environment', ownerId: 'env1', group: 'Environment', secret: true, display: MASK, raw: 'secretref:1' });
    expect(rows[1]).toMatchObject({ secret: false, display: 'v', enabled: false });
  });
  it('filters by key or group, case-insensitively', () => {
    const rows = [...toRows('globals', 'ws', 'Globals', [entry('baseUrl'), entry('token')]), ...toRows('folder', 'f1', 'Folder "Users"', [entry('page')])];
    expect(filterRows(rows, '').length).toBe(3);
    expect(filterRows(rows, 'BASE').map((r) => r.key)).toEqual(['baseUrl']);
    expect(filterRows(rows, 'users').map((r) => r.key)).toEqual(['page']);
  });
  it('collects names changed by the last run across scopes', () => {
    expect(changedNames(undefined).size).toBe(0);
    const names = changedNames({ environment: { set: ['token'], unset: [] }, globals: { set: [], unset: ['old'] } });
    expect([...names].sort()).toEqual(['old', 'token']);
  });
});

describe('mergeVariable', () => {
  it('appends a new enabled plain variable', () => {
    const res = mergeVariable([entry('a', { id: 'id-a' })], ' b ', 'v');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.action).toBe('added');
    expect(res.entries[0]).toMatchObject({ id: 'id-a', key: 'a' });
    expect(res.entries[1]).toEqual({ key: 'b', initialValue: 'v', currentValue: 'v', isSecret: false, enabled: true });
  });
  it('updates the current value of an existing plain variable, keeping its id', () => {
    const res = mergeVariable([entry('a', { id: 'id-a', currentValue: 'old', description: 'd' })], 'a', 'new');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.action).toBe('updated');
    expect(res.entries).toEqual([{ id: 'id-a', key: 'a', initialValue: 'init', currentValue: 'new', isSecret: false, enabled: true, description: 'd' }]);
  });
  it('refuses to overwrite a secret and rejects invalid names', () => {
    const secret = entry('s', { id: 'id-s', isSecret: true, initialValue: 'secretref:1' });
    const res = mergeVariable([secret], 's', 'x');
    expect(res.ok).toBe(false);
    expect(mergeVariable([], 'bad{x}', 'v').ok).toBe(false);
    expect(mergeVariable([], '   ', 'v').ok).toBe(false);
  });
});

describe('pane state persistence', () => {
  it('reads and writes through a storage-like object and survives failures', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readPaneOpen(storage)).toBe(true);
    writePaneOpen(storage, false);
    expect(store.get(VARS_PANE_STORAGE_KEY)).toBe('0');
    expect(readPaneOpen(storage)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
    };
    expect(readPaneOpen(broken, false)).toBe(false);
    expect(() => writePaneOpen(broken, true)).not.toThrow();
    expect(readPaneOpen(null)).toBe(true);
  });
});

describe('script snippets', () => {
  it('have unique titles and cover the Postman-style variable helpers in both phases', () => {
    const titles = SNIPPETS.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    const has = (t: string) => titles.includes(t);
    for (const t of ['Set environment variable', 'Get environment variable', 'Unset environment variable', 'Get global variable', 'Unset global variable', 'Get collection variable', 'Unset collection variable', 'Set local variable (this run only)', 'Replace variables in string', 'Dynamic variable ($guid / $timestamp)', 'Save token from response', 'Test: JSON schema']) {
      expect(has(t), t).toBe(true);
    }
    const pre = SNIPPETS.filter((s) => s.phases.includes('prerequest'));
    const post = SNIPPETS.filter((s) => s.phases.includes('test'));
    expect(pre.some((s) => s.title === 'Skip this request')).toBe(true);
    expect(post.some((s) => s.title === 'Set next request')).toBe(true);
    expect(SNIPPETS.every((s) => s.code.endsWith('\n'))).toBe(true);
  });
});
