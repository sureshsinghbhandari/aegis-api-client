import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { IconButton, MethodLabel, useContextMenu } from '../components/ui';
import { isDirty, useApp, type OpenTab } from '../store/app';
import { useUi } from '../store/ui';

/** Close a tab; asks first when it has unsaved changes. */
export async function requestCloseTab(tabId: string): Promise<void> {
  const tab = useApp.getState().tabs.find((t) => t.tabId === tabId);
  if (!tab) return;
  if (isDirty(tab)) {
    const ok = await useUi.getState().confirm({
      title: 'Unsaved changes',
      message: `"${tab.draft.name}" has unsaved changes. Close it anyway? (You can reopen it with Ctrl+Shift+T.)`,
      confirmLabel: 'Close without saving',
      danger: true,
    });
    if (!ok) return;
  }
  useApp.getState().closeTab(tabId);
}

async function closeOthers(keep: string): Promise<void> {
  const others = useApp.getState().tabs.filter((t) => t.tabId !== keep);
  if (others.some(isDirty)) {
    const ok = await useUi.getState().confirm({ title: 'Close other tabs', message: 'Some of the other tabs have unsaved changes. Close them anyway?', confirmLabel: 'Close without saving', danger: true });
    if (!ok) return;
  }
  for (const t of others) useApp.getState().closeTab(t.tabId);
  useApp.getState().setActiveTab(keep);
}

export function TabsBar() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const closedCount = useApp((s) => s.closedTabs.length);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const newRequest = useApp((s) => s.newRequest);
  const listRef = useRef<HTMLDivElement>(null);
  const { menu, open } = useContextMenu();

  // keep the active tab visible
  useEffect(() => {
    const el = activeTabId ? listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`) : null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  const onContext = (e: MouseEvent, t: OpenTab) => {
    const st = useApp.getState();
    open(e, [
      { label: 'Duplicate', onSelect: () => st.duplicateTab(t.tabId) },
      {
        label: 'Rename',
        onSelect: () => {
          void useUi
            .getState()
            .prompt({ title: 'Rename request', label: 'Name', initial: t.draft.name, confirmLabel: 'Rename' })
            .then((name) => name && useApp.getState().renameTab(t.tabId, name));
        },
      },
      { label: 'Close', separatorBefore: true, onSelect: () => void requestCloseTab(t.tabId) },
      { label: 'Close Others', disabled: tabs.length < 2, onSelect: () => void closeOthers(t.tabId) },
      { label: 'Reopen Closed Tab', disabled: closedCount === 0, separatorBefore: true, onSelect: () => st.reopenTab() },
    ]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number) => {
    const go = (i: number) => {
      const target = tabs[(i + tabs.length) % tabs.length];
      if (target) {
        setActiveTab(target.tabId);
        listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${target.tabId}"]`)?.focus();
      }
    };
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(index + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(index - 1);
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && e.shiftKey)) {
      e.preventDefault();
      void requestCloseTab(tabs[index]!.tabId);
    }
  };

  return (
    <div className="wb-tabbar">
      <div className="wb-tabs" role="tablist" aria-label="Open requests" ref={listRef}>
        {tabs.map((t, i) => {
          const active = t.tabId === activeTabId;
          const dirty = isDirty(t);
          return (
            <div
              key={t.tabId}
              role="tab"
              data-tab-id={t.tabId}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`wb-tab ${active ? 'active' : ''}`}
              title={`${t.draft.method} ${t.draft.name}`}
              onClick={() => setActiveTab(t.tabId)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void requestCloseTab(t.tabId);
                }
              }}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onContextMenu={(e) => onContext(e, t)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <MethodLabel method={t.draft.method} />
              <span className="wb-tab-name">{t.draft.name || 'Untitled'}</span>
              {dirty && <span className="wb-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
              {t.response.status === 'sending' && <span className="wb-sending" title="Sending…" />}
              <IconButton
                label={`Close ${t.draft.name || 'tab'}`}
                className="wb-tab-close"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  void requestCloseTab(t.tabId);
                }}
              >
                ✕
              </IconButton>
            </div>
          );
        })}
      </div>
      <IconButton label="New request (Ctrl+T)" onClick={() => newRequest(null, null)} className="wb-newtab">
        +
      </IconButton>
      {menu}
    </div>
  );
}
