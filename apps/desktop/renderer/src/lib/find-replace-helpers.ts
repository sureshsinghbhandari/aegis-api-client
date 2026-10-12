/** Pure helpers for the Find & Replace modal (no React). */
import type { FindReplaceInput, FindReplaceScope } from '@aegis/core';

export const SCOPE_LABELS: Record<FindReplaceScope, string> = {
  url: 'URL',
  params: 'Query & path params',
  headers: 'Headers',
  body: 'Body',
  scripts: 'Scripts',
  descriptions: 'Descriptions',
  variables: 'Variables (non-secret)',
};

/** Stable key of everything that influences a preview; a Replace is only allowed for the previewed key. */
export function previewKey(input: Omit<FindReplaceInput, 'apply'>): string {
  return JSON.stringify([input.collectionId ?? null, input.workspaceId ?? null, input.find, input.replace, [...input.scopes].sort(), !!input.matchCase, !!input.wholeWord, !!input.useRegex]);
}

export interface TabLike {
  tabId: string;
  requestId: string | null;
  collectionId: string | null;
  dirty: boolean;
}

/**
 * After a replace was applied, saved tabs of the affected collections (`null` = every collection) are
 * reloaded from the database; tabs with unsaved edits are left alone and the user is warned instead.
 */
export function partitionTabsForReload(tabs: readonly TabLike[], affectedCollectionIds: ReadonlySet<string> | null): { reload: string[]; keep: string[] } {
  const reload: string[] = [];
  const keep: string[] = [];
  for (const t of tabs) {
    if (!t.requestId || !t.collectionId) continue;
    if (affectedCollectionIds && !affectedCollectionIds.has(t.collectionId)) continue;
    (t.dirty ? keep : reload).push(t.tabId);
  }
  return { reload, keep };
}
