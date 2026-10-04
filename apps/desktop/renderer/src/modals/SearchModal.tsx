import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchResult } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { ancestorFolderIds, flattenGroups, groupSearchResults, moveSelection } from '../lib/search-helpers';
import { Badge, ErrorBanner, MethodLabel, Spinner } from '../components/ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/panels.css';

interface QuickAction {
  id: string;
  label: string;
  hint: string;
  run(): void;
}

const ICON: Record<SearchResult['kind'], string> = { request: '', folder: '📁', collection: '📚', environment: '🌐', variable: '{ }', workspace: '🗂' };

async function revealInSidebar(collectionId: string, nodeId: string | null): Promise<void> {
  const app = useApp.getState();
  app.setSidebarView('collections');
  app.toggleExpanded(collectionId, true);
  await app.refreshTree(collectionId).catch(() => undefined);
  if (nodeId) for (const id of ancestorFolderIds(useApp.getState().trees[collectionId] ?? [], nodeId)) app.toggleExpanded(id, true);
}

async function openResult(r: SearchResult): Promise<void> {
  const app = useApp.getState();
  const ui = useUi.getState();
  ui.closeModal();
  switch (r.kind) {
    case 'request':
      await app.openRequest(r.id);
      if (r.collectionId) await revealInSidebar(r.collectionId, r.id);
      break;
    case 'folder':
      if (r.collectionId) {
        await revealInSidebar(r.collectionId, r.id);
        app.toggleExpanded(r.id, true);
      }
      break;
    case 'collection':
      await revealInSidebar(r.id, null);
      break;
    case 'environment':
      ui.openModal('environments', { environmentId: r.id });
      break;
    case 'variable':
      if (r.subtitle.startsWith('Global')) ui.openModal('environments', { globals: true });
      else if (r.collectionId) await revealInSidebar(r.collectionId, null);
      else ui.openModal('environments', { environmentId: r.id });
      break;
    case 'workspace':
      await app.selectWorkspace(r.id);
      break;
  }
}

export default function SearchModal(_p: ModalComponentProps) {
  const workspaceId = useApp((s) => s.workspaceId);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const actions: QuickAction[] = useMemo(() => {
    const close = () => useUi.getState().closeModal();
    return [
      {
        id: 'new-request',
        label: 'New request',
        hint: 'Ctrl+T',
        run: () => {
          close();
          const app = useApp.getState();
          app.newRequest(app.collections[0]?.id ?? null, null);
        },
      },
      { id: 'import', label: 'Import…', hint: 'Postman collection, environment or backup', run: () => useUi.getState().openModal('import') },
      { id: 'runner', label: 'Open collection runner…', hint: '', run: () => useUi.getState().openModal('runner') },
      { id: 'settings', label: 'Settings', hint: 'Ctrl+,', run: () => useUi.getState().openModal('settings') },
      {
        id: 'console',
        label: 'Toggle console',
        hint: 'Ctrl+`',
        run: () => {
          close();
          useApp.getState().toggleBottom('console');
        },
      },
    ];
  }, []);

  const trimmed = query.trim();

  useEffect(() => {
    if (!trimmed || !workspaceId) {
      seq.current++;
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api.collections.search({ workspaceId, query: trimmed }).then(
        (r) => {
          if (mine !== seq.current) return;
          setResults(r);
          setError(null);
          setLoading(false);
        },
        (e) => {
          if (mine !== seq.current) return;
          setError(errorMessage(e));
          setResults([]);
          setLoading(false);
        },
      );
    }, 200);
    return () => clearTimeout(t);
  }, [trimmed, workspaceId]);

  const groups = useMemo(() => groupSearchResults(results), [results]);
  const flat = useMemo(() => flattenGroups(groups), [groups]);
  const count = trimmed ? flat.length : actions.length;

  useEffect(() => setSelected(0), [trimmed, flat.length]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const activate = (i: number) => {
    if (trimmed) {
      const r = flat[i];
      if (r) void openResult(r).catch((e) => useApp.getState().toast(errorMessage(e), 'error'));
    } else {
      actions[i]?.run();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => moveSelection(s, 1, count));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => moveSelection(s, -1, count));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(selected);
    }
  };

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && useUi.getState().closeModal();
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, []);

  let flatIndex = -1;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && useUi.getState().closeModal()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Search and commands" style={{ width: 640 }}>
        <div className="palette-input">
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={count ? `palette-opt-${selected}` : undefined}
            aria-label="Search requests, collections, environments and variables"
            placeholder="Search requests, folders, collections, environments, variables…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {loading && <Spinner label="Searching" />}
        </div>
        {error && <ErrorBanner message={error} />}
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {!trimmed &&
            actions.map((a, i) => (
              <div key={a.id} id={`palette-opt-${i}`} role="option" aria-selected={i === selected} className={`palette-item ${i === selected ? 'active' : ''}`} onMouseMove={() => setSelected(i)} onClick={() => activate(i)}>
                <span className="palette-title">{a.label}</span>
                <span className="palette-sub">{a.hint}</span>
              </div>
            ))}
          {trimmed &&
            groups.map((g) => (
              <div key={g.kind} role="group" aria-label={g.label}>
                <div className="palette-group">{g.label}</div>
                {g.results.map((r) => {
                  const i = ++flatIndex;
                  return (
                    <div key={`${r.kind}:${r.id}:${r.name}:${i}`} id={`palette-opt-${i}`} role="option" aria-selected={i === selected} className={`palette-item ${i === selected ? 'active' : ''}`} onMouseMove={() => setSelected(i)} onClick={() => activate(i)}>
                      {r.kind === 'request' && r.method ? <MethodLabel method={r.method} /> : <span className="palette-icon">{ICON[r.kind]}</span>}
                      <span className="palette-title">{r.name}</span>
                      <span className="palette-sub">{r.subtitle}</span>
                      {r.kind === 'variable' && <Badge>name only</Badge>}
                    </div>
                  );
                })}
              </div>
            ))}
          {trimmed && !loading && !error && flat.length === 0 && <div className="empty-body" style={{ padding: 16 }}>No results for "{trimmed}".</div>}
        </div>
        <div className="palette-foot">↑↓ navigate · Enter open · Esc close</div>
      </div>
    </div>
  );
}
