import { useEffect } from 'react';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';

/** Global keyboard shortcuts. Ctrl/Cmd+Enter send, +S save, +W close tab, +T new tab, +Shift+T reopen, +K search, +` console. */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const s = useApp.getState();
      const key = e.key.toLowerCase();
      if (key === 'enter' && s.activeTabId) {
        e.preventDefault();
        void s.sendTab(s.activeTabId);
      } else if (key === 's' && s.activeTabId) {
        e.preventDefault();
        void s.saveTab(s.activeTabId);
      } else if (key === 'w' && s.activeTabId) {
        e.preventDefault();
        s.closeTab(s.activeTabId);
      } else if (key === 't' && e.shiftKey) {
        e.preventDefault();
        s.reopenTab();
      } else if (key === 't') {
        e.preventDefault();
        s.newRequest(null, null);
      } else if (key === 'k') {
        e.preventDefault();
        useUi.getState().openModal('search');
      } else if (key === '`') {
        e.preventDefault();
        s.toggleBottom('console');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
