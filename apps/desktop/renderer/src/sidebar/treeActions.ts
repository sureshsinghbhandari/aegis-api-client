import { emptyRequestDraft } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { planCollectionReorder, planNodeMove, type DropPosition } from '../lib/collectionTree';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';

/** Mutations of the collections tree. Each one reports failures as a toast and refreshes the store. */

const app = () => useApp.getState();
const fail = (e: unknown) => app().toast(errorMessage(e), 'error');

export async function expandNode(id: string, isCollection: boolean): Promise<void> {
  useApp.setState((s) => ({ expanded: { ...s.expanded, [id]: true } }));
  if (isCollection) await ensureTree(id);
}

export function setNodeExpanded(id: string, value: boolean, isCollection: boolean): void {
  useApp.setState((s) => ({ expanded: { ...s.expanded, [id]: value } }));
  if (value && isCollection) void ensureTree(id);
}

export async function ensureTree(collectionId: string): Promise<void> {
  if (app().trees[collectionId]) return;
  try {
    await app().refreshTree(collectionId);
  } catch (e) {
    fail(e);
  }
}

async function afterMutation(collectionId: string): Promise<void> {
  await app().refreshTree(collectionId);
  app().syncTabsAfterChange();
}

export async function createCollection(): Promise<void> {
  const { workspaceId } = app();
  if (!workspaceId) return;
  const name = await useUi.getState().prompt({ title: 'New collection', label: 'Collection name', initial: 'New Collection', confirmLabel: 'Create' });
  if (!name) return;
  try {
    const c = await api.collections.create({ workspaceId, name });
    await app().refreshCollections();
    await expandNode(c.id, true);
  } catch (e) {
    fail(e);
  }
}

export async function createRequest(collectionId: string, folderId: string | null): Promise<void> {
  const name = await useUi.getState().prompt({ title: 'New request', label: 'Request name', initial: 'New Request', confirmLabel: 'Create' });
  if (!name) return;
  try {
    const r = await api.requests.create({ collectionId, folderId, draft: emptyRequestDraft({ name }) });
    useApp.setState((s) => ({ expanded: { ...s.expanded, [collectionId]: true, ...(folderId ? { [folderId]: true } : {}) } }));
    await app().refreshTree(collectionId);
    await app().openRequest(r.id);
  } catch (e) {
    fail(e);
  }
}

export async function createFolder(collectionId: string, parentFolderId: string | null): Promise<void> {
  const name = await useUi.getState().prompt({ title: 'New folder', label: 'Folder name', initial: 'New Folder', confirmLabel: 'Create' });
  if (!name) return;
  try {
    const f = await api.folders.create({ collectionId, parentFolderId, name });
    useApp.setState((s) => ({ expanded: { ...s.expanded, [collectionId]: true, ...(parentFolderId ? { [parentFolderId]: true } : {}), [f.id]: true } }));
    await app().refreshTree(collectionId);
  } catch (e) {
    fail(e);
  }
}

export type EntityKind = 'collection' | 'folder' | 'request';

/** Keep open tabs consistent after a request was renamed from the sidebar. */
function applyRenameToTabs(requestId: string, name: string): void {
  useApp.setState((s) => ({
    tabs: s.tabs.map((t) => {
      if (t.requestId !== requestId) return t;
      let savedJson = t.savedJson;
      try {
        savedJson = JSON.stringify({ ...(JSON.parse(t.savedJson) as Record<string, unknown>), name });
      } catch {
        /* keep */
      }
      return { ...t, draft: { ...t.draft, name }, savedJson };
    }),
  }));
}

export async function renameEntity(kind: EntityKind, id: string, collectionId: string, current: string): Promise<void> {
  const name = await useUi.getState().prompt({ title: `Rename ${kind}`, label: 'Name', initial: current, confirmLabel: 'Rename' });
  if (!name || name === current) return;
  try {
    if (kind === 'collection') {
      await api.collections.update({ id, name });
      await app().refreshCollections();
    } else if (kind === 'folder') {
      await api.folders.update({ id, name });
      await afterMutation(collectionId);
    } else {
      const r = await api.requests.get({ id });
      const { id: _id, collectionId: _c, folderId: _f, sortOrder: _s, createdAt: _ca, updatedAt: _u, ...draft } = r;
      await api.requests.save({ id, draft: { ...draft, name } });
      applyRenameToTabs(id, name);
      await afterMutation(collectionId);
    }
  } catch (e) {
    fail(e);
  }
}

export async function duplicateEntity(kind: 'collection' | 'request', id: string, collectionId: string): Promise<void> {
  try {
    if (kind === 'collection') {
      const c = await api.collections.duplicate({ id });
      await app().refreshCollections();
      await expandNode(c.id, true);
    } else {
      const r = await api.requests.duplicate({ id });
      await app().refreshTree(collectionId);
      await app().openRequest(r.id);
    }
  } catch (e) {
    fail(e);
  }
}

export async function deleteEntity(kind: EntityKind, id: string, name: string, collectionId: string): Promise<void> {
  const detail =
    kind === 'collection'
      ? 'All folders and requests inside it will be deleted.'
      : kind === 'folder'
        ? 'All folders and requests inside it will be deleted.'
        : 'This cannot be undone.';
  const ok = await useUi.getState().confirm({ title: `Delete ${kind}`, message: `Delete ${kind} "${name}"? ${detail}`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    if (kind === 'collection') {
      await api.collections.delete({ id });
      useApp.setState((s) => {
        const { [id]: _removed, ...trees } = s.trees;
        const tabs = s.tabs.filter((t) => t.collectionId !== id);
        const activeTabId = tabs.some((t) => t.tabId === s.activeTabId) ? s.activeTabId : (tabs[tabs.length - 1]?.tabId ?? null);
        return { trees, tabs, activeTabId };
      });
      await app().refreshCollections();
    } else if (kind === 'folder') {
      await api.folders.delete({ id });
      await afterMutation(collectionId);
    } else {
      await api.requests.delete({ id });
      await afterMutation(collectionId);
    }
  } catch (e) {
    fail(e);
  }
}

/** Drop of a folder/request onto a row. Returns false when the drop is invalid. */
export async function dropNode(dragged: { id: string; kind: 'folder' | 'request'; collectionId: string }, target: { id: string; kind: EntityKind; collectionId: string }, position: DropPosition): Promise<boolean> {
  const nodes = app().trees[dragged.collectionId];
  if (!nodes) return false;
  const plan = planNodeMove(nodes, dragged, target, position);
  if (!plan) return false;
  try {
    await api.requests.move({ kind: dragged.kind, id: dragged.id, parentFolderId: plan.parentFolderId, index: plan.index });
    if (plan.parentFolderId) useApp.setState((s) => ({ expanded: { ...s.expanded, [plan.parentFolderId!]: true } }));
    if (dragged.kind === 'request') {
      useApp.setState((s) => ({ tabs: s.tabs.map((t) => (t.requestId === dragged.id ? { ...t, folderId: plan.parentFolderId } : t)) }));
    }
    await afterMutation(dragged.collectionId);
  } catch (e) {
    fail(e);
    await app().refreshTree(dragged.collectionId).catch(() => undefined);
  }
  return true;
}

export async function dropCollection(draggedId: string, targetId: string, position: 'before' | 'after'): Promise<void> {
  const { collections, workspaceId } = app();
  if (!workspaceId) return;
  const order = planCollectionReorder(
    collections.map((c) => c.id),
    draggedId,
    targetId,
    position,
  );
  if (!order) return;
  try {
    await api.collections.reorder({ workspaceId, orderedIds: order });
    await app().refreshCollections();
  } catch (e) {
    fail(e);
  }
}
