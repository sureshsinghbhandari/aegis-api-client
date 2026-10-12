/**
 * Pure helpers for the collections sidebar: flattening trees into visible rows,
 * filtering, ancestry checks and computing drag & drop moves. No React.
 */
import type { Collection, TreeNode } from '@aegis/core';

export interface CollectionRow {
  type: 'collection';
  id: string;
  collectionId: string;
  name: string;
  depth: 0;
  expanded: boolean;
  loaded: boolean;
  hasChildren: boolean;
}

export interface NodeRow {
  type: 'folder' | 'request';
  id: string;
  collectionId: string;
  parentId: string | null;
  name: string;
  method?: string;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
}

export type SidebarRow = CollectionRow | NodeRow;

export function compareNodes(a: TreeNode, b: TreeNode): number {
  return a.sortOrder - b.sortOrder || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || a.name.localeCompare(b.name);
}

/** parentId -> sorted children. */
export function childrenByParent(nodes: readonly TreeNode[]): Map<string | null, TreeNode[]> {
  const map = new Map<string | null, TreeNode[]>();
  for (const n of nodes) {
    const list = map.get(n.parentId);
    if (list) list.push(n);
    else map.set(n.parentId, [n]);
  }
  for (const list of map.values()) list.sort(compareNodes);
  return map;
}

export interface BuildInput {
  collections: readonly Collection[];
  trees: Readonly<Record<string, TreeNode[] | undefined>>;
  expanded: Readonly<Record<string, boolean | undefined>>;
  filter?: string;
}

/**
 * Flatten the sidebar into visible rows. With a non-empty filter only matching nodes (and their
 * ancestors) are shown and matching branches are expanded automatically.
 */
export function buildRows({ collections, trees, expanded, filter = '' }: BuildInput): SidebarRow[] {
  const q = filter.trim().toLowerCase();
  const rows: SidebarRow[] = [];
  for (const c of collections) {
    const nodes = trees[c.id];
    const loaded = nodes !== undefined;
    const nameMatches = q !== '' && c.name.toLowerCase().includes(q);
    const kids = nodes ? childrenByParent(nodes) : new Map<string | null, TreeNode[]>();

    // For filtering: ids of nodes to keep.
    let keep: Set<string> | null = null;
    if (q !== '' && nodes) {
      keep = new Set<string>();
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const n of nodes) {
        if (!n.name.toLowerCase().includes(q)) continue;
        let cur: TreeNode | undefined = n;
        const guard = new Set<string>();
        while (cur && !guard.has(cur.id)) {
          guard.add(cur.id);
          keep.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }
    }
    if (q !== '' && !nameMatches && (!keep || keep.size === 0)) continue;

    const filtered = q !== '' && keep !== null && keep.size > 0 && !nameMatches;
    const collectionOpen = filtered ? true : !!expanded[c.id];
    rows.push({
      type: 'collection',
      id: c.id,
      collectionId: c.id,
      name: c.name,
      depth: 0,
      expanded: collectionOpen,
      loaded,
      hasChildren: !loaded || (kids.get(null)?.length ?? 0) > 0,
    });
    if (!collectionOpen || !nodes) continue;

    const visited = new Set<string>();
    const walk = (parentId: string | null, depth: number) => {
      for (const n of kids.get(parentId) ?? []) {
        if (visited.has(n.id)) continue;
        visited.add(n.id);
        if (filtered && keep && !keep.has(n.id)) continue;
        const children = kids.get(n.id) ?? [];
        const open = n.kind === 'folder' && (filtered ? true : !!expanded[n.id]);
        const row: NodeRow = {
          type: n.kind,
          id: n.id,
          collectionId: c.id,
          parentId: n.parentId,
          name: n.name,
          depth,
          expanded: open,
          hasChildren: n.kind === 'folder' && children.length > 0,
          ...(n.method ? { method: n.method } : {}),
        };
        rows.push(row);
        if (open) walk(n.id, depth + 1);
      }
    };
    walk(null, 1);
  }
  return rows;
}

/** True when `id` is `ancestorId` itself or lives somewhere below it. */
export function isInSubtree(nodes: readonly TreeNode[], ancestorId: string, id: string): boolean {
  if (ancestorId === id) return true;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const guard = new Set<string>();
  let cur = byId.get(id);
  while (cur && cur.parentId && !guard.has(cur.id)) {
    guard.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

export type DropPosition = 'before' | 'after' | 'inside';

export interface MovePlan {
  parentFolderId: string | null;
  /** Index among the target parent's children once the dragged item has been removed from it. */
  index: number;
  /** Present only when the node moves into ANOTHER collection (pass it as `requests.move.collectionId`). */
  collectionId?: string;
}

/**
 * Where does a dragged node land when dropped on `target`?
 * `nodes` is the tree of the TARGET collection (for a same-collection move that is also the dragged
 * node's tree). `target` may be a node of that collection or the collection itself (kind 'collection').
 * Cross-collection drops are allowed and return `collectionId`; the dragged node is simply absent from
 * `nodes` then. Returns null for invalid drops (into own subtree, onto itself, into a request, or when
 * `nodes` does not belong to the target collection).
 */
export function planNodeMove(
  nodes: readonly TreeNode[],
  dragged: { id: string; kind: 'folder' | 'request'; collectionId: string },
  target: { id: string; kind: 'collection' | 'folder' | 'request'; collectionId: string },
  position: DropPosition,
): MovePlan | null {
  const cross = dragged.collectionId !== target.collectionId;
  if (cross && nodes.some((n) => n.collectionId !== target.collectionId)) return null;
  if (target.id === dragged.id) return null;
  const kids = childrenByParent(nodes);
  const without = (parent: string | null) => (kids.get(parent) ?? []).filter((n) => n.id !== dragged.id);
  const extra = cross ? { collectionId: target.collectionId } : {};

  if (target.kind === 'collection') {
    if (position === 'before' || position === 'after') return null;
    return { parentFolderId: null, index: without(null).length, ...extra };
  }
  if (!cross && dragged.kind === 'folder' && isInSubtree(nodes, dragged.id, target.id)) return null;

  if (position === 'inside') {
    if (target.kind !== 'folder') return null;
    return { parentFolderId: target.id, index: without(target.id).length, ...extra };
  }
  const targetNode = nodes.find((n) => n.id === target.id);
  if (!targetNode) return null;
  const siblings = without(targetNode.parentId);
  const at = siblings.findIndex((n) => n.id === target.id);
  if (at === -1) return null;
  return { parentFolderId: targetNode.parentId, index: position === 'before' ? at : at + 1, ...extra };
}

/** Ids of every request below `folderId` (any depth). */
export function requestIdsUnder(nodes: readonly TreeNode[], folderId: string): string[] {
  const kids = childrenByParent(nodes);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (parent: string) => {
    for (const n of kids.get(parent) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (n.kind === 'request') out.push(n.id);
      else walk(n.id);
    }
  };
  walk(folderId);
  return out;
}

/** New collection order after dragging `draggedId` before/after `targetId`. Null if nothing changes. */
export function planCollectionReorder(orderedIds: readonly string[], draggedId: string, targetId: string, position: 'before' | 'after'): string[] | null {
  if (draggedId === targetId) return null;
  const rest = orderedIds.filter((id) => id !== draggedId);
  const at = rest.indexOf(targetId);
  if (at === -1) return null;
  rest.splice(position === 'before' ? at : at + 1, 0, draggedId);
  return rest.join('|') === orderedIds.join('|') ? null : rest;
}

/** Decide before/inside/after from the vertical position inside a row. */
export function dropPositionFromOffset(fraction: number, canContain: boolean): DropPosition {
  if (canContain) return fraction < 0.25 ? 'before' : fraction > 0.75 ? 'after' : 'inside';
  return fraction < 0.5 ? 'before' : 'after';
}
