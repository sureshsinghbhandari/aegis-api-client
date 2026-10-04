import type { Collection, TreeNode } from '@aegis/core';
import { describe, expect, it } from 'vitest';
import { buildRows, dropPositionFromOffset, isInSubtree, planCollectionReorder, planNodeMove } from '../../apps/desktop/renderer/src/lib/collectionTree';

const col = (id: string, name = id) => ({ id, name }) as Collection;
const node = (id: string, kind: 'folder' | 'request', parentId: string | null, sortOrder: number, name = id, collectionId = 'c1'): TreeNode => ({ id, kind, collectionId, parentId, name, sortOrder, ...(kind === 'request' ? { method: 'GET' } : {}) });

const nodes: TreeNode[] = [
  node('r2', 'request', null, 2),
  node('f1', 'folder', null, 1),
  node('r1', 'request', 'f1', 1),
  node('f2', 'folder', 'f1', 2),
  node('r3', 'request', 'f2', 1, 'Deep Request'),
  node('r0', 'request', null, 0),
];

describe('buildRows', () => {
  it('lists collections collapsed by default', () => {
    const rows = buildRows({ collections: [col('c1')], trees: { c1: nodes }, expanded: {} });
    expect(rows.map((r) => r.id)).toEqual(['c1']);
  });
  it('flattens expanded folders in sort order with depth', () => {
    const rows = buildRows({ collections: [col('c1')], trees: { c1: nodes }, expanded: { c1: true, f1: true } });
    expect(rows.map((r) => `${r.depth}:${r.id}`)).toEqual(['0:c1', '1:r0', '1:f1', '2:r1', '2:f2', '1:r2']);
  });
  it('shows an unloaded expanded collection without children', () => {
    const rows = buildRows({ collections: [col('c1')], trees: {}, expanded: { c1: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ loaded: false });
  });
  it('filters by name, keeping and expanding ancestors', () => {
    const rows = buildRows({ collections: [col('c1'), col('c2', 'Other')], trees: { c1: nodes }, expanded: {}, filter: 'deep' });
    expect(rows.map((r) => r.id)).toEqual(['c1', 'f1', 'f2', 'r3']);
  });
  it('matches collection names', () => {
    const rows = buildRows({ collections: [col('c1'), col('c2', 'Payments')], trees: {}, expanded: {}, filter: 'pay' });
    expect(rows.map((r) => r.id)).toEqual(['c2']);
  });
  it('survives cyclic parent data', () => {
    const cyc = [node('a', 'folder', 'b', 1), node('b', 'folder', 'a', 1)];
    expect(() => buildRows({ collections: [col('c1')], trees: { c1: cyc }, expanded: { c1: true, a: true, b: true } })).not.toThrow();
  });
});

describe('isInSubtree', () => {
  it('detects descendants and self', () => {
    expect(isInSubtree(nodes, 'f1', 'r3')).toBe(true);
    expect(isInSubtree(nodes, 'f1', 'f1')).toBe(true);
    expect(isInSubtree(nodes, 'f2', 'r1')).toBe(false);
  });
});

describe('planNodeMove', () => {
  const drag = (id: string, kind: 'folder' | 'request') => ({ id, kind, collectionId: 'c1' });
  it('rejects dropping a folder into its own subtree', () => {
    expect(planNodeMove(nodes, drag('f1', 'folder'), { id: 'f2', kind: 'folder', collectionId: 'c1' }, 'inside')).toBeNull();
    expect(planNodeMove(nodes, drag('f1', 'folder'), { id: 'r3', kind: 'request', collectionId: 'c1' }, 'before')).toBeNull();
  });
  it('rejects cross-collection drops, self drops and drops into requests', () => {
    expect(planNodeMove(nodes, drag('r1', 'request'), { id: 'x', kind: 'collection', collectionId: 'c2' }, 'inside')).toBeNull();
    expect(planNodeMove(nodes, drag('r1', 'request'), { id: 'r1', kind: 'request', collectionId: 'c1' }, 'before')).toBeNull();
    expect(planNodeMove(nodes, drag('r1', 'request'), { id: 'r2', kind: 'request', collectionId: 'c1' }, 'inside')).toBeNull();
  });
  it('appends when dropped inside a folder or on the collection', () => {
    expect(planNodeMove(nodes, drag('r2', 'request'), { id: 'f1', kind: 'folder', collectionId: 'c1' }, 'inside')).toEqual({ parentFolderId: 'f1', index: 2 });
    expect(planNodeMove(nodes, drag('r1', 'request'), { id: 'c1', kind: 'collection', collectionId: 'c1' }, 'inside')).toEqual({ parentFolderId: null, index: 3 });
  });
  it('computes the index among siblings after removing the dragged node', () => {
    // root children: r0(0) f1(1) r2(2). Move r0 after r2 -> [f1, r2, r0] => index 2
    expect(planNodeMove(nodes, drag('r0', 'request'), { id: 'r2', kind: 'request', collectionId: 'c1' }, 'after')).toEqual({ parentFolderId: null, index: 2 });
    // move r2 before r0 -> index 0
    expect(planNodeMove(nodes, drag('r2', 'request'), { id: 'r0', kind: 'request', collectionId: 'c1' }, 'before')).toEqual({ parentFolderId: null, index: 0 });
    // into another parent, before r1
    expect(planNodeMove(nodes, drag('r2', 'request'), { id: 'r1', kind: 'request', collectionId: 'c1' }, 'before')).toEqual({ parentFolderId: 'f1', index: 0 });
  });
});

describe('planCollectionReorder / dropPositionFromOffset', () => {
  it('reorders collections', () => {
    expect(planCollectionReorder(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
    expect(planCollectionReorder(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
    expect(planCollectionReorder(['a', 'b', 'c'], 'a', 'b', 'before')).toBeNull();
    expect(planCollectionReorder(['a', 'b'], 'a', 'a', 'after')).toBeNull();
  });
  it('maps offsets to drop positions', () => {
    expect(dropPositionFromOffset(0.1, true)).toBe('before');
    expect(dropPositionFromOffset(0.5, true)).toBe('inside');
    expect(dropPositionFromOffset(0.9, true)).toBe('after');
    expect(dropPositionFromOffset(0.4, false)).toBe('before');
    expect(dropPositionFromOffset(0.6, false)).toBe('after');
  });
});
