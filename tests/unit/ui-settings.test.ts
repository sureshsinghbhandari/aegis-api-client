import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, DEFAULT_SETTINGS, mergeSettings, type TreeNode } from '@aegis/core';
import { buildPatch, bytesToMb, groupByDomain, looksLikePem, maxScriptTimeout, mbToBytes, parseBoundedInt, policySummary, validateProxyUrl, validateRegexSource } from '../../apps/desktop/renderer/src/lib/settings-helpers';
import { folderOptions } from '../../apps/desktop/renderer/src/lib/tree-helpers';
import { ancestorFolderIds, flattenGroups, groupSearchResults, moveSelection } from '../../apps/desktop/renderer/src/lib/search-helpers';

describe('settings patches', () => {
  it('builds nested patches that mergeSettings applies', () => {
    const patch = buildPatch(['network', 'proxy', 'mode'], 'manual');
    expect(patch).toEqual({ network: { proxy: { mode: 'manual' } } });
    const merged = mergeSettings(DEFAULT_SETTINGS, patch);
    expect(merged.network.proxy.mode).toBe('manual');
    expect(merged.network.timeoutMs).toBe(DEFAULT_SETTINGS.network.timeoutMs);
  });
  it('rejects empty paths', () => {
    expect(() => buildPatch([], 1)).toThrow();
  });
  it('validates regex sources', () => {
    expect(validateRegexSource('token-[a-z]+')).toBeNull();
    expect(validateRegexSource('(unclosed')).toBeTruthy();
    expect(validateRegexSource('   ')).toBeTruthy();
    expect(validateRegexSource('a'.repeat(501))).toMatch(/too long/);
  });
  it('parses bounded integers', () => {
    expect(parseBoundedInt('42', 1, 100)).toBe(42);
    expect(parseBoundedInt('500', 1, 100)).toBe(100);
    expect(parseBoundedInt('-3', 0, 10)).toBe(0);
    expect(parseBoundedInt('1.5', 0, 10)).toBeNull();
    expect(parseBoundedInt('abc', 0, 10)).toBeNull();
  });
  it('converts MB and bytes', () => {
    expect(mbToBytes(100)).toBe(DEFAULT_SETTINGS.network.maxResponseBytes);
    expect(bytesToMb(DEFAULT_SETTINGS.network.maxResponseBytes)).toBe(100);
  });
  it('validates proxy urls', () => {
    expect(validateProxyUrl('')).toBeNull();
    expect(validateProxyUrl('http://proxy.example.com:8080')).toBeNull();
    expect(validateProxyUrl('proxy.example.com:8080')).toBeNull();
    expect(validateProxyUrl('http://user:pw@proxy.example.com')).toMatch(/credentials/);
    expect(validateProxyUrl('ftp://proxy')).toBeTruthy();
  });
  it('detects PEM blocks', () => {
    expect(looksLikePem('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----', 'CERTIFICATE')).toBe(true);
    expect(looksLikePem('hello', 'CERTIFICATE')).toBe(false);
    expect(looksLikePem('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', 'PRIVATE KEY')).toBe(true);
  });
});

describe('policy', () => {
  it('summarizes enforced values', () => {
    const lines = policySummary(DEFAULT_POLICY);
    const tls = lines.find((l) => l.label.startsWith('Disabling TLS'));
    expect(tls).toMatchObject({ value: 'not allowed', enforced: true });
    expect(lines.find((l) => l.label === 'Local-only mode')).toMatchObject({ value: 'user choice', enforced: false });
    expect(policySummary({ ...DEFAULT_POLICY, blockedHosts: ['*.evil.test'] }).find((l) => l.label === 'Blocked hosts')?.value).toBe('*.evil.test');
  });
  it('caps the script timeout from policy', () => {
    expect(maxScriptTimeout({ ...DEFAULT_POLICY, maxScriptTimeoutMs: 10_000 })).toBe(10_000);
    expect(maxScriptTimeout(undefined)).toBe(60_000);
  });
});

describe('cookies grouping', () => {
  it('groups by normalized domain', () => {
    const g = groupByDomain([{ domain: '.Example.com', n: 1 }, { domain: 'api.example.com', n: 2 }, { domain: 'example.com', n: 3 }]);
    expect(g.map((x) => x.domain)).toEqual(['api.example.com', 'example.com']);
    expect(g[1]!.items).toHaveLength(2);
  });
});

describe('tree helpers', () => {
  const node = (id: string, name: string, parentId: string | null, kind: TreeNode['kind'] = 'folder', sortOrder = 0): TreeNode => ({ id, kind, name, parentId, collectionId: 'c', sortOrder });
  const nodes = [node('f2', 'Admin', 'f1'), node('f1', 'Users', null), node('r1', 'Get', 'f2', 'request'), node('f3', 'Orders', null, 'folder', 1)];
  it('flattens folders depth-first with path labels', () => {
    expect(folderOptions(nodes).map((f) => [f.label, f.depth])).toEqual([
      ['Users', 0],
      ['Users / Admin', 1],
      ['Orders', 0],
    ]);
  });
  it('lists ancestors nearest first and tolerates cycles', () => {
    expect(ancestorFolderIds(nodes, 'r1')).toEqual(['f2', 'f1']);
    expect(ancestorFolderIds([node('a', 'a', 'b'), node('b', 'b', 'a')], 'a')).toEqual(['b', 'a']);
  });
});

describe('search helpers', () => {
  const r = (kind: 'request' | 'folder' | 'collection' | 'environment' | 'variable' | 'workspace', name: string) => ({ kind, id: name, name, subtitle: '' });
  it('groups in display order and flattens consistently', () => {
    const groups = groupSearchResults([r('environment', 'e'), r('request', 'r1'), r('collection', 'c'), r('request', 'r2')]);
    expect(groups.map((g) => g.kind)).toEqual(['request', 'collection', 'environment']);
    expect(flattenGroups(groups).map((x) => x.name)).toEqual(['r1', 'r2', 'c', 'e']);
  });
  it('wraps keyboard selection', () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});
