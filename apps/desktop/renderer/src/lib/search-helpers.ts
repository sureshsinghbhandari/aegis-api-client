import type { SearchResult, TreeNode } from '@aegis/core';

export type SearchKind = SearchResult['kind'];

export const SEARCH_KIND_ORDER: readonly SearchKind[] = ['request', 'folder', 'collection', 'environment', 'variable', 'workspace'];

export const SEARCH_KIND_LABEL: Record<SearchKind, string> = {
  request: 'Requests',
  folder: 'Folders',
  collection: 'Collections',
  environment: 'Environments',
  variable: 'Variables',
  workspace: 'Workspaces',
};

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  results: SearchResult[];
}

/** Group results by kind in display order, dropping empty groups. Order within a kind is preserved. */
export function groupSearchResults(results: SearchResult[]): SearchGroup[] {
  const groups: SearchGroup[] = [];
  for (const kind of SEARCH_KIND_ORDER) {
    const list = results.filter((r) => r.kind === kind);
    if (list.length) groups.push({ kind, label: SEARCH_KIND_LABEL[kind], results: list });
  }
  return groups;
}

/** Flat list in the same order as the groups (for keyboard navigation). */
export function flattenGroups(groups: SearchGroup[]): SearchResult[] {
  return groups.flatMap((g) => g.results);
}

/** Next index for ArrowUp/ArrowDown with wrap-around. */
export function moveSelection(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

/** Ids of all ancestor folders of `nodeId` (nearest first), using a collection tree. */
export function ancestorFolderIds(nodes: TreeNode[], nodeId: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  let cur = byId.get(nodeId)?.parentId ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return out;
}
