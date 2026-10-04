import type { TreeNode } from '@aegis/core';

export interface FolderOption {
  id: string;
  /** Indented display label, e.g. "Users / Admin". */
  label: string;
  depth: number;
}

/** Flatten the folders of a collection tree into depth-first, sorted options with a path label. */
export function folderOptions(nodes: TreeNode[]): FolderOption[] {
  const folders = nodes.filter((n) => n.kind === 'folder');
  const byParent = new Map<string | null, TreeNode[]>();
  for (const f of folders) {
    const list = byParent.get(f.parentId) ?? [];
    list.push(f);
    byParent.set(f.parentId, list);
  }
  const out: FolderOption[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, path: string[], depth: number) => {
    const children = (byParent.get(parent) ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const f of children) {
      if (seen.has(f.id)) continue; // defend against cyclic data
      seen.add(f.id);
      const next = [...path, f.name];
      out.push({ id: f.id, label: next.join(' / '), depth });
      walk(f.id, next, depth + 1);
    }
  };
  walk(null, [], 0);
  return out;
}
