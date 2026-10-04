import { describe, expect, it } from 'vitest';
import { MASK, formatCount, isSecretRef, pluralize, relativeTime, truncate } from '../../apps/desktop/renderer/src/lib/ui-format';
import { entriesSignature, invalidKeys, prepareEntries } from '../../apps/desktop/renderer/src/lib/variables-helpers';
import { visibleRange } from '../../apps/desktop/renderer/src/components/VirtualList';

const NOW = Date.parse('2026-05-10T12:00:00.000Z');

describe('relativeTime', () => {
  it('formats recent and old timestamps', () => {
    expect(relativeTime('2026-05-10T11:59:50.000Z', NOW)).toBe('just now');
    expect(relativeTime('2026-05-10T11:55:00.000Z', NOW)).toBe('5 min ago');
    expect(relativeTime('2026-05-10T09:00:00.000Z', NOW)).toBe('3 h ago');
    expect(relativeTime('2026-05-08T12:00:00.000Z', NOW)).toBe('2 d ago');
    expect(relativeTime('2025-01-02T12:00:00.000Z', NOW)).toBe('2025-01-02');
  });
  it('handles invalid input and future timestamps', () => {
    expect(relativeTime('nope', NOW)).toBe('');
    expect(relativeTime('2026-05-10T13:00:00.000Z', NOW)).toBe('just now');
  });
});

describe('text helpers', () => {
  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
  it('formats counts and plurals', () => {
    expect(formatCount(1250)).toBe('1,250');
    expect(pluralize(1, 'request')).toBe('1 request');
    expect(pluralize(5000, 'request')).toBe('5,000 requests');
  });
  it('recognizes secret references and never exposes them as plain values', () => {
    expect(isSecretRef('secretref:abc')).toBe(true);
    expect(isSecretRef('hunter2')).toBe(false);
    expect(isSecretRef(undefined)).toBe(false);
    expect(MASK).not.toMatch(/secretref/);
  });
});

describe('variables helpers', () => {
  const row = (key: string, extra: Partial<Parameters<typeof prepareEntries>[0][number]> = {}) => ({ key, initialValue: 'v', isSecret: false, enabled: true, ...extra });

  it('drops empty keys, trims and reports duplicates among enabled rows', () => {
    const res = prepareEntries([row(' a '), row(''), row('a'), row('b', { enabled: false }), row('b', { enabled: false })]);
    expect(res.entries.map((e) => e.key)).toEqual(['a', 'a', 'b', 'b']);
    expect(res.dropped).toBe(1);
    expect(res.duplicates).toEqual(['a']);
  });
  it('keeps secret references untouched', () => {
    const res = prepareEntries([row('token', { isSecret: true, initialValue: 'secretref:xyz' })]);
    expect(res.entries[0]?.initialValue).toBe('secretref:xyz');
  });
  it('flags names that cannot be used in {{ }}', () => {
    expect(invalidKeys([row('ok'), row('bad{x}')])).toEqual(['bad{x}']);
  });
  it('signature detects edits', () => {
    const a = [row('a')];
    expect(entriesSignature(a)).toBe(entriesSignature([row('a')]));
    expect(entriesSignature(a)).not.toBe(entriesSignature([row('a', { initialValue: 'changed' })]));
  });
});

describe('visibleRange', () => {
  it('windows rows with overscan', () => {
    expect(visibleRange(1000, 50, 0, 500, 2)).toEqual({ start: 0, end: 12 });
    expect(visibleRange(1000, 50, 5000, 500, 2)).toEqual({ start: 98, end: 112 });
    expect(visibleRange(10, 50, 0, 500, 5)).toEqual({ start: 0, end: 10 });
  });
});
