import { useEffect, useRef } from 'react';
import { api, errorMessage } from './api';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';

async function newCollection(): Promise<void> {
  const app = useApp.getState();
  if (!app.workspaceId) return;
  const name = await useUi.getState().prompt({ title: 'New collection', label: 'Collection name', confirmLabel: 'Create' });
  if (!name) return;
  try {
    const created = await api.collections.create({ workspaceId: app.workspaceId, name });
    await app.refreshCollections();
    app.setSidebarView('collections');
    app.toggleExpanded(created.id, true);
    app.toast(`Collection "${created.name}" created`, 'success');
  } catch (e) {
    app.toast(errorMessage(e), 'error');
  }
}

/** Dispatch one `menu:action` coming from the native application menu. */
export function runMenuAction(action: string): void {
  const app = useApp.getState();
  const ui = useUi.getState();
  switch (action) {
    case 'new-request':
      app.newRequest(app.collections[0]?.id ?? null, null);
      break;
    case 'new-collection':
      void newCollection();
      break;
    case 'import-collection':
      ui.openModal('import', { kind: 'postman-collection', autoPick: true });
      break;
    case 'import-environment':
      ui.openModal('import', { kind: 'postman-environment', autoPick: true });
      break;
    case 'import-backup':
      ui.openModal('import', { kind: 'backup', autoPick: true });
      break;
    case 'export-collection':
      ui.openModal('export', app.collections[0] ? { collectionId: app.collections[0].id } : {});
      break;
    case 'export-environment': {
      const env = app.environments.find((e) => e.isActive) ?? app.environments[0];
      ui.openModal('export', env ? { environmentId: env.id } : {});
      break;
    }
    case 'export-backup':
      ui.openModal('backup');
      break;
    case 'settings':
      ui.openModal('settings');
      break;
    case 'search':
      ui.openModal('search');
      break;
    case 'toggle-console':
      app.toggleBottom('console');
      break;
    case 'about':
      ui.openModal('about');
      break;
    default:
      break;
  }
}

/** Watches the store for menu actions emitted by the main process and runs them. */
export function useMenuActions(): void {
  const pending = useApp((s) => s.pendingMenuAction);
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!pending || handled.current === pending.nonce) return;
    handled.current = pending.nonce;
    runMenuAction(pending.action);
  }, [pending]);
}
