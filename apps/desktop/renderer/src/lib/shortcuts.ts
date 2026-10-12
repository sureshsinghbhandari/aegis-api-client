import { useEffect } from 'react';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { requestCloseTab } from '../workspace/TabsBar';
import { shortcutAction } from './shortcut-keys';

export { shortcutAction } from './shortcut-keys';

/** Opens Find & Replace for the collection of the active tab (or the first collection). */
export function openFindReplace(): void {
  const s = useApp.getState();
  const active = s.tabs.find((t) => t.tabId === s.activeTabId);
  const collectionId = active?.collectionId ?? s.collections[0]?.id;
  useUi.getState().openModal('find-replace', collectionId ? { collectionId } : {});
}

/**
 * Global keyboard shortcuts. Ctrl/Cmd+Enter send, +S save, +W close tab (asks when dirty), +T new tab,
 * +Shift+T reopen, +Tab / +Shift+Tab next / previous tab, +Shift+F find & replace, +K search, +` console.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutAction(e);
      if (!action) return;
      const s = useApp.getState();
      switch (action) {
        case 'send':
          if (!s.activeTabId) return;
          e.preventDefault();
          void s.sendTab(s.activeTabId);
          return;
        case 'save':
          if (!s.activeTabId) return;
          e.preventDefault();
          void s.saveTab(s.activeTabId);
          return;
        case 'close-tab':
          if (!s.activeTabId) return;
          e.preventDefault();
          void requestCloseTab(s.activeTabId);
          return;
        case 'reopen-tab':
          e.preventDefault();
          s.reopenTab();
          return;
        case 'new-tab':
          e.preventDefault();
          s.newRequest(null, null);
          return;
        case 'next-tab':
          e.preventDefault();
          s.cycleTab(1);
          return;
        case 'prev-tab':
          e.preventDefault();
          s.cycleTab(-1);
          return;
        case 'find-replace':
          e.preventDefault();
          openFindReplace();
          return;
        case 'search':
          e.preventDefault();
          useUi.getState().openModal('search');
          return;
        case 'console':
          e.preventDefault();
          s.toggleBottom('console');
          return;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
