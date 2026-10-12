import type { TreeNode } from '@aegis/core';
import { describe, expect, it } from 'vitest';
import { planNodeMove, requestIdsUnder } from '../../apps/desktop/renderer/src/lib/collectionTree';
import { partitionTabsForReload, previewKey } from '../../apps/desktop/renderer/src/lib/find-replace-helpers';

const node = (id: string, kind: 'folder' | 'request', parentId: string | null, sortOrder: number, collectionId = 'c2'): TreeNode => ({ id, kind, collectionId, parentId, name: id, sortOrder, ...(kind === 'request' ? { method: 'GET' } : {}) });

/** Tree of the TARGET collection c2. */
const target: TreeNode[] = [node('tf1', 'folder', null, 0), node('tr1', 'request', 'tf1', 0), node('tr2', 'request', null, 1), node('tf2', 'folder', 'tf1', 1)];
const source: TreeNode[] = [node('sf', 'folder', null, 0, 'c1'), node('sr1', 'request', 'sf', 0, 'c1'), node('sf2', 'folder', 'sf', 1, 'c1'), node('sr2', 'request', 'sf2', 0, 'c1'), node('sr3', 'request', null, 1, 'c1')];
const drag = (id: string, kind: 'folder' | 'request') => ({ id, kind, collectionId: 'c1' });

describe('planNodeMove across collections', () => {
  it('drops onto another collection root at the end and reports the target collection', () => {
    expect(planNodeMove(target, drag('sr1', 'request'), { id: 'c2', kind: 'collection', collectionId: 'c2' }, 'inside')).toEqual({ parentFolderId: null, index: 2, collectionId: 'c2' });
    expect(planNodeMove([], drag('sf', 'folder'), { id: 'c2', kind: 'collection', collectionId: 'c2' }, 'inside')).toEqual({ parentFolderId: null, index: 0, collectionId: 'c2' });
  });
  it('drops inside, before and after nodes of another collection', () => {
    expect(planNodeMove(target, drag('sf', 'folder'), { id: 'tf1', kind: 'folder', collectionId: 'c2' }, 'inside')).toEqual({ parentFolderId: 'tf1', index: 2, collectionId: 'c2' });
    expect(planNodeMove(target, drag('sr1', 'request'), { id: 'tr1', kind: 'request', collectionId: 'c2' }, 'before')).toEqual({ parentFolderId: 'tf1', index: 0, collectionId: 'c2' });
    expect(planNodeMove(target, drag('sr1', 'request'), { id: 'tr2', kind: 'request', collectionId: 'c2' }, 'after')).toEqual({ parentFolderId: null, index: 2, collectionId: 'c2' });
  });
  it('still rejects drops into requests, before/after a collection row and when the wrong tree is supplied', () => {
    expect(planNodeMove(target, drag('sr1', 'request'), { id: 'tr1', kind: 'request', collectionId: 'c2' }, 'inside')).toBeNull();
    expect(planNodeMove(target, drag('sr1', 'request'), { id: 'c2', kind: 'collection', collectionId: 'c2' }, 'before')).toBeNull();
    // `source` is the tree of c1, not of the target c2: refuse rather than compute a wrong index.
    expect(planNodeMove(source, drag('sr1', 'request'), { id: 'c2', kind: 'collection', collectionId: 'c2' }, 'inside')).toBeNull();
  });
  it('does not add collectionId for same-collection moves', () => {
    const plan = planNodeMove(source, drag('sr3', 'request'), { id: 'sf', kind: 'folder', collectionId: 'c1' }, 'inside');
    expect(plan).toEqual({ parentFolderId: 'sf', index: 2 });
    expect(plan && 'collectionId' in plan).toBe(false);
    expect(planNodeMove(source, drag('sf', 'folder'), { id: 'sf2', kind: 'folder', collectionId: 'c1' }, 'inside')).toBeNull();
  });
});

describe('requestIdsUnder', () => {
  it('collects requests at every depth and tolerates cycles', () => {
    expect(requestIdsUnder(source, 'sf').sort()).toEqual(['sr1', 'sr2']);
    expect(requestIdsUnder(source, 'sf2')).toEqual(['sr2']);
    expect(requestIdsUnder(source, 'missing')).toEqual([]);
    const cyc = [node('a', 'folder', 'b', 0), node('b', 'folder', 'a', 0), node('r', 'request', 'b', 0)];
    expect(requestIdsUnder(cyc, 'a')).toEqual(['r']);
  });
});

describe('find & replace helpers', () => {
  it('previewKey changes with every input that affects the result and ignores scope order', () => {
    const base = { collectionId: 'c', find: 'a', replace: 'b', scopes: ['url', 'body'] as const };
    const k = previewKey({ ...base, scopes: [...base.scopes] });
    expect(previewKey({ ...base, scopes: ['body', 'url'] })).toBe(k);
    expect(previewKey({ ...base, scopes: ['url'] })).not.toBe(k);
    expect(previewKey({ ...base, scopes: [...base.scopes], matchCase: true })).not.toBe(k);
    expect(previewKey({ ...base, scopes: [...base.scopes], replace: 'c' })).not.toBe(k);
    expect(previewKey({ workspaceId: 'w', find: 'a', replace: 'b', scopes: ['url', 'body'] })).not.toBe(k);
  });
  it('reloads clean saved tabs of affected collections and keeps dirty ones', () => {
    const tabs = [
      { tabId: 't1', requestId: 'r1', collectionId: 'c1', dirty: false },
      { tabId: 't2', requestId: 'r2', collectionId: 'c1', dirty: true },
      { tabId: 't3', requestId: 'r3', collectionId: 'c2', dirty: false },
      { tabId: 't4', requestId: null, collectionId: 'c1', dirty: true },
    ];
    expect(partitionTabsForReload(tabs, new Set(['c1']))).toEqual({ reload: ['t1'], keep: ['t2'] });
    expect(partitionTabsForReload(tabs, null)).toEqual({ reload: ['t1', 't3'], keep: ['t2'] });
    expect(partitionTabsForReload(tabs, new Set(['c9']))).toEqual({ reload: [], keep: [] });
  });
});
