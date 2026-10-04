import { create } from 'zustand';
import {
  emptyRequestDraft,
  newId,
  type AppInfo,
  type AppSettings,
  type Collection,
  type ConsoleEntry,
  type Environment,
  type ExecutionResult,
  type RequestDraft,
  type TreeNode,
  type Workspace,
} from '@aegis/core';
import { api, errorMessage, ApiError } from '../lib/api';

export type SidebarView = 'collections' | 'history' | 'environments';
export type BottomPanel = 'console' | 'runner' | 'tests';

export interface ResponseState {
  status: 'idle' | 'sending' | 'done' | 'error';
  executionId?: string;
  result?: ExecutionResult;
  /** Error that prevented the request from being executed at all (validation, policy, ...). */
  error?: { code: string; message: string };
}

export interface OpenTab {
  /** Stable UI id (not the request id; unsaved tabs have no request id). */
  tabId: string;
  requestId: string | null;
  collectionId: string | null;
  folderId: string | null;
  draft: RequestDraft;
  /** JSON of the last saved draft; the tab is dirty when it differs from JSON of `draft`. */
  savedJson: string;
  response: ResponseState;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface ConsoleLine extends ConsoleEntry {
  id: string;
  request: string;
  executionId: string;
}

interface AppState {
  ready: boolean;
  info: AppInfo | null;
  settings: AppSettings | null;
  theme: 'dark' | 'light';
  workspaces: Workspace[];
  workspaceId: string | null;
  collections: Collection[];
  trees: Record<string, TreeNode[]>;
  expanded: Record<string, boolean>;
  environments: Environment[];
  sidebarView: SidebarView;
  bottomPanel: BottomPanel;
  bottomOpen: boolean;
  tabs: OpenTab[];
  activeTabId: string | null;
  closedTabs: OpenTab[];
  toasts: Toast[];
  consoleLines: ConsoleLine[];
  /** Bumped when history changes so panels refetch. */
  historyVersion: number;
  /** Incoming `menu:action` events, consumed by the UI that owns the action. */
  pendingMenuAction: { action: string; nonce: number } | null;

  init(): Promise<void>;
  setTheme(theme: 'dark' | 'light'): void;
  applySettings(settings: AppSettings): void;
  selectWorkspace(id: string): Promise<void>;
  refreshWorkspaces(): Promise<void>;
  refreshCollections(): Promise<void>;
  refreshTree(collectionId: string): Promise<void>;
  refreshEnvironments(): Promise<void>;
  setActiveEnvironment(id: string | null): Promise<void>;
  setSidebarView(v: SidebarView): void;
  toggleExpanded(id: string, value?: boolean): void;
  toggleBottom(panel?: BottomPanel): void;

  openRequest(requestId: string): Promise<void>;
  newRequest(collectionId: string | null, folderId: string | null, draft?: Partial<RequestDraft>): void;
  closeTab(tabId: string): void;
  reopenTab(): void;
  setActiveTab(tabId: string): void;
  updateDraft(tabId: string, patch: Partial<RequestDraft>): void;
  saveTab(tabId: string): Promise<void>;
  duplicateTab(tabId: string): void;
  renameTab(tabId: string, name: string): void;
  sendTab(tabId: string, opts?: { confirmProduction?: boolean }): Promise<void>;
  cancelTab(tabId: string): Promise<void>;
  /** Called after a request/folder/collection was renamed or deleted elsewhere. */
  syncTabsAfterChange(): void;

  toast(message: string, kind?: Toast['kind']): void;
  dismissToast(id: string): void;
  clearConsole(): void;
  bumpHistory(): void;
  triggerMenuAction(action: string): void;
}

const draftJson = (d: RequestDraft): string => JSON.stringify(d);
export const isDirty = (t: OpenTab): boolean => draftJson(t.draft) !== t.savedJson;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  info: null,
  settings: null,
  theme: 'dark',
  workspaces: [],
  workspaceId: null,
  collections: [],
  trees: {},
  expanded: {},
  environments: [],
  sidebarView: 'collections',
  bottomPanel: 'console',
  bottomOpen: false,
  tabs: [],
  activeTabId: null,
  closedTabs: [],
  toasts: [],
  consoleLines: [],
  historyVersion: 0,
  pendingMenuAction: null,

  async init() {
    const [info, workspaces] = await Promise.all([api.app.info(), api.workspaces.list()]);
    get().applySettings(info.settings);
    const stored = safeGet('aegis.workspaceId');
    const workspaceId = workspaces.find((w) => w.id === stored)?.id ?? workspaces[0]?.id ?? null;
    set({ info, workspaces, workspaceId });
    if (workspaceId) await get().selectWorkspace(workspaceId);
    api.events.on('menu:action', ({ action }) => get().triggerMenuAction(action));
    set({ ready: true });
  },

  setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },

  applySettings(settings) {
    const pref = settings.appearance.theme;
    const theme = pref === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : pref;
    document.documentElement.dataset.theme = theme;
    set({ settings, theme });
  },

  async selectWorkspace(id) {
    safeSet('aegis.workspaceId', id);
    set({ workspaceId: id, collections: [], trees: {}, environments: [] });
    await Promise.all([get().refreshCollections(), get().refreshEnvironments()]);
  },

  async refreshWorkspaces() {
    set({ workspaces: await api.workspaces.list() });
  },

  async refreshCollections() {
    const { workspaceId } = get();
    if (!workspaceId) return;
    const collections = await api.collections.list({ workspaceId });
    set({ collections });
    await Promise.all(collections.filter((c) => get().expanded[c.id]).map((c) => get().refreshTree(c.id)));
  },

  async refreshTree(collectionId) {
    const nodes = await api.collections.tree({ collectionId });
    set((s) => ({ trees: { ...s.trees, [collectionId]: nodes } }));
  },

  async refreshEnvironments() {
    const { workspaceId } = get();
    if (!workspaceId) return;
    set({ environments: await api.environments.list({ workspaceId }) });
  },

  async setActiveEnvironment(id) {
    const { workspaceId } = get();
    if (!workspaceId) return;
    await api.environments.setActive({ workspaceId, id });
    await get().refreshEnvironments();
  },

  setSidebarView: (sidebarView) => set({ sidebarView }),

  toggleExpanded(id, value) {
    const next = value ?? !get().expanded[id];
    set((s) => ({ expanded: { ...s.expanded, [id]: next } }));
    if (next && get().collections.some((c) => c.id === id) && !get().trees[id]) void get().refreshTree(id);
  },

  toggleBottom(panel) {
    const s = get();
    if (panel && (!s.bottomOpen || s.bottomPanel !== panel)) set({ bottomPanel: panel, bottomOpen: true });
    else set({ bottomOpen: !s.bottomOpen });
  },

  async openRequest(requestId) {
    const existing = get().tabs.find((t) => t.requestId === requestId);
    if (existing) {
      set({ activeTabId: existing.tabId });
      return;
    }
    try {
      const r = await api.requests.get({ id: requestId });
      const { id: _i, collectionId, folderId, sortOrder: _s, createdAt: _c, updatedAt: _u, ...draft } = r;
      const tab: OpenTab = { tabId: newId(), requestId: r.id, collectionId, folderId, draft, savedJson: draftJson(draft), response: { status: 'idle' } };
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.tabId }));
    } catch (e) {
      get().toast(errorMessage(e), 'error');
    }
  },

  newRequest(collectionId, folderId, draft) {
    const d = emptyRequestDraft({ name: 'New Request', ...draft });
    const tab: OpenTab = { tabId: newId(), requestId: null, collectionId, folderId, draft: d, savedJson: '', response: { status: 'idle' } };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.tabId }));
  },

  closeTab(tabId) {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.tabId === tabId);
    if (idx === -1) return;
    const closing = tabs[idx]!;
    const remaining = tabs.filter((t) => t.tabId !== tabId);
    const nextActive = activeTabId === tabId ? (remaining[Math.min(idx, remaining.length - 1)]?.tabId ?? null) : activeTabId;
    const responseId = closing.response.result?.response?.responseId;
    if (responseId) void api.responses.release({ responseId }).catch(() => undefined);
    set((s) => ({ tabs: remaining, activeTabId: nextActive, closedTabs: [{ ...closing, response: { status: 'idle' as const } }, ...s.closedTabs].slice(0, 20) }));
  },

  reopenTab() {
    const [last, ...rest] = get().closedTabs;
    if (!last) return;
    const restored = { ...last, tabId: newId() };
    set((s) => ({ tabs: [...s.tabs, restored], activeTabId: restored.tabId, closedTabs: rest }));
  },

  setActiveTab: (activeTabId) => set({ activeTabId }),

  updateDraft(tabId, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, draft: { ...t.draft, ...patch } } : t)) }));
  },

  async saveTab(tabId) {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;
    try {
      let saved;
      if (tab.requestId) {
        saved = await api.requests.save({ id: tab.requestId, draft: tab.draft });
      } else {
        let collectionId = tab.collectionId;
        if (!collectionId) {
          const first = get().collections[0];
          if (!first) {
            get().toast('Create a collection first, then save the request into it.', 'info');
            return;
          }
          collectionId = first.id;
        }
        saved = await api.requests.create({ collectionId, folderId: tab.folderId, draft: tab.draft });
      }
      const { id, collectionId, folderId, sortOrder: _s, createdAt: _c, updatedAt: _u, ...draft } = saved;
      // Replace the auth with the saved version so literal secrets typed by the user leave renderer memory.
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.tabId !== tabId) return t;
          const next = { ...t.draft, auth: draft.auth };
          return { ...t, requestId: id, collectionId, folderId, draft: next, savedJson: draftJson(next) };
        }),
      }));
      await get().refreshTree(saved.collectionId);
      get().toast('Saved', 'success');
    } catch (e) {
      get().toast(errorMessage(e), 'error');
    }
  },

  duplicateTab(tabId) {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;
    const copy: OpenTab = { ...tab, tabId: newId(), requestId: null, savedJson: '', draft: { ...tab.draft, name: `${tab.draft.name} Copy` }, response: { status: 'idle' } };
    set((s) => ({ tabs: [...s.tabs, copy], activeTabId: copy.tabId }));
  },

  renameTab(tabId, name) {
    get().updateDraft(tabId, { name });
  },

  async sendTab(tabId, opts) {
    const { workspaceId } = get();
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab || !workspaceId) return;
    if (tab.response.status === 'sending') return;
    const executionId = newId();
    const patch = (response: ResponseState) => set((s) => ({ tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, response } : t)) }));
    patch({ status: 'sending', executionId });
    try {
      const result = await api.execution.send({
        executionId,
        workspaceId,
        ...(tab.requestId ? { requestId: tab.requestId } : {}),
        draft: tab.draft,
        ...(tab.collectionId ? { collectionId: tab.collectionId } : {}),
        folderId: tab.folderId,
        ...(opts?.confirmProduction ? { confirmProduction: true } : {}),
      });
      const previous = tab.response.result?.response?.responseId;
      if (previous) void api.responses.release({ responseId: previous }).catch(() => undefined);
      patch({ status: result.ok ? 'done' : 'error', executionId, result });
      const lines: ConsoleLine[] = result.console.map((c) => ({ ...c, id: newId(), request: tab.draft.name, executionId }));
      if (lines.length) set((s) => ({ consoleLines: [...s.consoleLines, ...lines].slice(-2000) }));
      get().bumpHistory();
      await get().refreshEnvironments();
    } catch (e) {
      if (e instanceof ApiError) patch({ status: 'error', executionId, error: { code: e.code, message: e.message } });
      else patch({ status: 'error', executionId, error: { code: 'INTERNAL', message: errorMessage(e) } });
    }
  },

  async cancelTab(tabId) {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (tab?.response.executionId) await api.execution.cancel({ executionId: tab.response.executionId }).catch(() => undefined);
  },

  syncTabsAfterChange() {
    // Close tabs whose saved request no longer exists.
    const known = new Set(Object.values(get().trees).flatMap((nodes) => nodes.filter((n) => n.kind === 'request').map((n) => n.id)));
    const loaded = new Set(Object.keys(get().trees));
    set((s) => ({
      tabs: s.tabs.filter((t) => !t.requestId || !t.collectionId || !loaded.has(t.collectionId) || known.has(t.requestId)),
    }));
  },

  toast(message, kind = 'info') {
    const id = newId();
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearConsole: () => set({ consoleLines: [] }),
  bumpHistory: () => set((s) => ({ historyVersion: s.historyVersion + 1 })),
  triggerMenuAction: (action) => set({ pendingMenuAction: { action, nonce: Date.now() } }),
}));

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
