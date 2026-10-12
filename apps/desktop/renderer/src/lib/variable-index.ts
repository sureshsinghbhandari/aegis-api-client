/**
 * Variable index of the ACTIVE request tab, shared by the URL bar, key/value cells,
 * the Monaco body editor and auth fields. Loaded through the existing
 * `variables.get` channel for globals, the active environment, the tab's collection
 * and its folder chain; secrets arrive as `secretref:` values and are only ever shown masked.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { VariableEntry } from '@aegis/core';
import { api } from './api';
import { useApp } from '../store/app';
import { buildVariableIndex, EMPTY_VARIABLE_INDEX, type HintScopes, type VariableIndex } from './variable-hints';

interface Target {
  workspaceId: string;
  environmentId: string | null;
  collectionId: string | null;
  folderId: string | null;
}

interface VariableIndexState {
  index: VariableIndex;
  /** Identity of the scopes the index was built for. */
  key: string;
  loadedAt: number;
  load(target: Target): Promise<void>;
  clear(): void;
}

const MIN_RELOAD_MS = 1500;
const MAX_FOLDER_DEPTH = 32;
let inFlight: Promise<void> | null = null;

async function entriesOf(scope: 'environment' | 'global' | 'collection' | 'folder', ownerId: string): Promise<VariableEntry[]> {
  try {
    return await api.variables.get({ scope, ownerId });
  } catch {
    return [];
  }
}

async function folderChain(folderId: string | null): Promise<Array<{ owner?: string; entries: VariableEntry[] }>> {
  const out: Array<{ owner?: string; entries: VariableEntry[] }> = [];
  let id: string | null = folderId;
  for (let depth = 0; id && depth < MAX_FOLDER_DEPTH; depth++) {
    let folder;
    try {
      folder = await api.folders.get({ id });
    } catch {
      break;
    }
    out.push({ owner: folder.name, entries: await entriesOf('folder', folder.id) });
    id = folder.parentFolderId;
  }
  return out;
}

export const useVariableIndex = create<VariableIndexState>((set, get) => ({
  index: EMPTY_VARIABLE_INDEX,
  key: '',
  loadedAt: 0,
  async load(target) {
    const key = JSON.stringify(target);
    if (key === get().key && Date.now() - get().loadedAt < MIN_RELOAD_MS) return;
    if (inFlight) await inFlight.catch(() => undefined);
    const run = (async () => {
      const app = useApp.getState();
      const envName = target.environmentId ? app.environments.find((e) => e.id === target.environmentId)?.name : undefined;
      const collectionName = target.collectionId ? app.collections.find((c) => c.id === target.collectionId)?.name : undefined;
      const [global, environment, collection, folders] = await Promise.all([
        entriesOf('global', target.workspaceId),
        target.environmentId ? entriesOf('environment', target.environmentId) : Promise.resolve<VariableEntry[]>([]),
        target.collectionId ? entriesOf('collection', target.collectionId) : Promise.resolve<VariableEntry[]>([]),
        folderChain(target.folderId),
      ]);
      const scopes: HintScopes = {
        global: { entries: global },
        ...(target.environmentId ? { environment: { ...(envName ? { owner: envName } : {}), entries: environment } } : {}),
        ...(target.collectionId ? { collection: { ...(collectionName ? { owner: collectionName } : {}), entries: collection } } : {}),
        folders,
      };
      set({ index: buildVariableIndex(scopes), key, loadedAt: Date.now() });
    })();
    inFlight = run;
    try {
      await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  },
  clear: () => set({ index: EMPTY_VARIABLE_INDEX, key: '', loadedAt: 0 }),
}));

/** Index of the active tab (empty until loaded). */
export function useActiveVariableIndex(): VariableIndex {
  return useVariableIndex((s) => s.index);
}

/** Current index without subscribing (for Monaco providers). */
export function getActiveVariableIndex(): VariableIndex {
  return useVariableIndex.getState().index;
}

/** Re-fetch the scopes of the active tab (throttled). Safe to call from focus handlers. */
export function refreshVariableIndex(): void {
  const app = useApp.getState();
  const tab = app.tabs.find((t) => t.tabId === app.activeTabId);
  if (!app.workspaceId || !tab) return;
  void useVariableIndex.getState().load({
    workspaceId: app.workspaceId,
    environmentId: app.environments.find((e) => e.isActive)?.id ?? null,
    collectionId: tab.collectionId,
    folderId: tab.folderId,
  });
}

/**
 * Keeps the shared index in sync with the tab shown in the workbench. Mount once per
 * active tab (the URL bar does this). Reloads when the workspace, the active environment,
 * the environment list (refreshed after every send) or the tab's collection/folder change.
 */
export function useVariableIndexLoader(tab: { collectionId: string | null; folderId: string | null }): void {
  const workspaceId = useApp((s) => s.workspaceId);
  const environments = useApp((s) => s.environments);
  const activeEnvId = environments.find((e) => e.isActive)?.id ?? null;
  const { collectionId, folderId } = tab;
  useEffect(() => {
    if (!workspaceId) {
      useVariableIndex.getState().clear();
      return;
    }
    void useVariableIndex.getState().load({ workspaceId, environmentId: activeEnvId, collectionId, folderId });
  }, [workspaceId, activeEnvId, collectionId, folderId, environments]);
  useEffect(() => {
    const onFocus = () => refreshVariableIndex();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
}
