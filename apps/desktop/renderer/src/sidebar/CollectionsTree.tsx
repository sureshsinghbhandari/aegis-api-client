import { useVirtualizer } from '@tanstack/react-virtual';
import type { SearchResult, TreeNode } from '@aegis/core';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { EmptyState, IconButton, MethodLabel, Spinner, useContextMenu, Button, type MenuEntry } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { buildRows, dropPositionFromOffset, planNodeMove, type DropPosition, type MovePlan, type SidebarRow } from '../lib/collectionTree';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { createCollection, createFolder, createRequest, deleteEntity, dropCollection, dropNode, duplicateEntity, ensureTree, moveEntity, renameEntity, setNodeExpanded } from './treeActions';
import '../styles/sidebar.css';

const ROW_HEIGHT = 26;

interface DragInfo {
  kind: 'collection' | 'folder' | 'request';
  id: string;
  collectionId: string;
}
/** HTML5 drag data is unreadable during dragover, so the dragged item is kept here. */
let dragging: DragInfo | null = null;

interface DropHint {
  id: string;
  position: DropPosition;
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg className="cs-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d={open ? 'M1.5 4.5h4l1 1.5h8v6.5h-13z' : 'M1.5 3.5h4l1.2 1.5h7.8v7.5h-13z'} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function CollectionIcon() {
  return (
    <svg className="cs-icon cs-icon-collection" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M2 4.5 8 2l6 2.5v7L8 14l-6-2.5z M2 4.5 8 7l6-2.5 M8 7v7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function Chevron({ open, visible }: { open: boolean; visible: boolean }) {
  return (
    <svg className={`cs-chevron ${open ? 'open' : ''} ${visible ? '' : 'hidden'}`} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CollectionsTree() {
  const collections = useApp((s) => s.collections);
  const trees = useApp((s) => s.trees);
  const expanded = useApp((s) => s.expanded);
  const workspaceId = useApp((s) => s.workspaceId);
  const activeRequestId = useApp((s) => s.tabs.find((t) => t.tabId === s.activeTabId)?.requestId ?? null);
  const openRequest = useApp((s) => s.openRequest);

  const [filter, setFilter] = useState('');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const { menu, open: openMenu } = useContextMenu();
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => buildRows({ collections, trees, expanded, filter }), [collections, trees, expanded, filter]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14,
    getItemKey: (i) => rows[i]?.id ?? i,
  });

  // Load the tree of every expanded collection that has not been fetched yet (once per collection).
  const requestedTrees = useRef(new Set<string>());
  useEffect(() => {
    for (const c of collections) {
      if (expanded[c.id] && !trees[c.id] && !requestedTrees.current.has(c.id)) {
        requestedTrees.current.add(c.id);
        void ensureTree(c.id).finally(() => {
          if (!useApp.getState().trees[c.id]) setTimeout(() => requestedTrees.current.delete(c.id), 5000);
        });
      }
    }
  }, [collections, expanded, trees]);

  // Server-side search for >= 2 characters.
  const [remote, setRemote] = useState<{ query: string; items: SearchResult[]; error?: string } | null>(null);
  useEffect(() => {
    const q = filter.trim();
    if (q.length < 2 || !workspaceId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.collections
        .search({ workspaceId, query: q })
        .then((items) => !cancelled && setRemote({ query: q, items }))
        .catch((e) => !cancelled && setRemote({ query: q, items: [], error: errorMessage(e) }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filter, workspaceId]);

  const visibleIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const remoteItems = useMemo(() => {
    const q = filter.trim();
    if (!remote || remote.query !== q || q.length < 2) return [];
    return remote.items.filter((r) => (r.kind === 'request' || r.kind === 'folder' || r.kind === 'collection') && !visibleIds.has(r.id));
  }, [remote, filter, visibleIds]);
  const remoteError = remote && remote.query === filter.trim() ? remote.error : undefined;

  const focusIndex = Math.max(
    0,
    rows.findIndex((r) => r.id === focusedId),
  );
  const focusedRow: SidebarRow | undefined = rows[focusIndex];

  const moveFocus = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    setFocusedId(row.id);
    virtualizer.scrollToIndex(Math.max(0, Math.min(rows.length - 1, index)), { align: 'auto' });
  };

  const toggle = useCallback((row: SidebarRow, value?: boolean) => {
    if (row.type === 'request') return;
    setNodeExpanded(row.id, value ?? !useApp.getState().expanded[row.id], row.type === 'collection');
  }, []);

  const entriesFor = useCallback(
    (row: SidebarRow): MenuEntry[] => {
      const ui = useUi.getState();
      if (row.type === 'collection') {
        return [
          { label: 'New Request', onSelect: () => void createRequest(row.id, null) },
          { label: 'New Folder', onSelect: () => void createFolder(row.id, null) },
          { label: 'Rename', separatorBefore: true, onSelect: () => void renameEntity('collection', row.id, row.id, row.name) },
          { label: 'Duplicate', onSelect: () => void duplicateEntity('collection', row.id, row.id) },
          { label: 'Edit…', onSelect: () => ui.openModal('collection-edit', { kind: 'collection', id: row.id }) },
          { label: 'Find & Replace…', onSelect: () => ui.openModal('find-replace', { collectionId: row.id }) },
          { label: 'Run…', separatorBefore: true, onSelect: () => ui.openModal('runner', { collectionId: row.id }) },
          { label: 'Export…', onSelect: () => ui.openModal('export', { collectionId: row.id }) },
          { label: 'Delete', danger: true, separatorBefore: true, onSelect: () => void deleteEntity('collection', row.id, row.name, row.id) },
        ];
      }
      if (row.type === 'folder') {
        return [
          { label: 'New Request', onSelect: () => void createRequest(row.collectionId, row.id) },
          { label: 'New Folder', onSelect: () => void createFolder(row.collectionId, row.id) },
          { label: 'Rename', separatorBefore: true, onSelect: () => void renameEntity('folder', row.id, row.collectionId, row.name) },
          { label: 'Duplicate', onSelect: () => void duplicateEntity('folder', row.id, row.collectionId) },
          { label: 'Move to…', onSelect: () => moveEntity('folder', row.id, row.collectionId, row.name) },
          { label: 'Edit…', onSelect: () => ui.openModal('collection-edit', { kind: 'folder', id: row.id }) },
          { label: 'Run…', separatorBefore: true, onSelect: () => ui.openModal('runner', { collectionId: row.collectionId, folderId: row.id }) },
          { label: 'Delete', danger: true, separatorBefore: true, onSelect: () => void deleteEntity('folder', row.id, row.name, row.collectionId) },
        ];
      }
      return [
        { label: 'Open', onSelect: () => void openRequest(row.id) },
        { label: 'Rename', separatorBefore: true, onSelect: () => void renameEntity('request', row.id, row.collectionId, row.name) },
        { label: 'Duplicate', onSelect: () => void duplicateEntity('request', row.id, row.collectionId) },
        { label: 'Move to…', onSelect: () => moveEntity('request', row.id, row.collectionId, row.name) },
        { label: 'Delete', danger: true, separatorBefore: true, onSelect: () => void deleteEntity('request', row.id, row.name, row.collectionId) },
      ];
    },
    [openRequest],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0 || e.ctrlKey || e.metaKey || e.altKey) return;
    const row = focusedRow;
    if (!row) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(focusIndex + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(focusIndex - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        e.preventDefault();
        moveFocus(rows.length - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (row.type !== 'request') {
          if (!row.expanded) toggle(row, true);
          else moveFocus(focusIndex + 1);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (row.type !== 'request' && row.expanded && !filter.trim()) toggle(row, false);
        else {
          for (let i = focusIndex - 1; i >= 0; i--) {
            if (rows[i]!.depth < row.depth) {
              moveFocus(i);
              break;
            }
          }
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (row.type === 'request') void openRequest(row.id);
        else toggle(row);
        break;
      case 'F2':
        e.preventDefault();
        void renameEntity(row.type, row.id, row.collectionId, row.name);
        break;
      case 'Delete':
        e.preventDefault();
        void deleteEntity(row.type, row.id, row.name, row.collectionId);
        break;
      case 'ContextMenu': {
        e.preventDefault();
        const rect = scrollRef.current?.getBoundingClientRect();
        openMenu({ clientX: (rect?.left ?? 0) + 40, clientY: (rect?.top ?? 0) + 30 + (virtualizer.getOffsetForIndex(focusIndex)?.[0] ?? 0) - (scrollRef.current?.scrollTop ?? 0), preventDefault: () => undefined }, entriesFor(row));
        break;
      }
      default:
    }
  };

  /* ------------------------------------------------------------ drag & drop */

  const onDragStart = (e: DragEvent<HTMLDivElement>, row: SidebarRow) => {
    dragging = { kind: row.type, id: row.id, collectionId: row.collectionId };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.name);
  };

  const hintFor = (e: DragEvent<HTMLDivElement>, row: SidebarRow): DropHint | null => {
    const d = dragging;
    if (!d) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientY - rect.top) / Math.max(1, rect.height);
    if (d.kind === 'collection') {
      if (row.type !== 'collection' || row.id === d.id || filter.trim()) return null;
      return { id: row.id, position: fraction < 0.5 ? 'before' : 'after' };
    }
    if (filter.trim()) return null;
    const canContain = row.type !== 'request';
    const position: DropPosition = row.type === 'collection' ? 'inside' : dropPositionFromOffset(fraction, canContain);
    // Drops into another collection are allowed. Its tree may not be loaded yet (collapsed collection):
    // a drop on the collection row is then planned against an empty tree and `dropNode` loads it first.
    const nodes = trees[row.collectionId] ?? (row.type === 'collection' ? [] : undefined);
    if (!nodes) return null;
    // Validate with the same planner the drop uses.
    const plan = planPreview(nodes, d, row, position);
    return plan ? { id: row.id, position } : null;
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>, row: SidebarRow) => {
    const hint = hintFor(e, row);
    if (!hint) {
      if (dropHint) setDropHint(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropHint?.id !== hint.id || dropHint.position !== hint.position) setDropHint(hint);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>, row: SidebarRow) => {
    const d = dragging;
    const hint = hintFor(e, row);
    e.preventDefault();
    dragging = null;
    setDropHint(null);
    if (!d || !hint) return;
    if (d.kind === 'collection') void dropCollection(d.id, row.id, hint.position === 'before' ? 'before' : 'after');
    else void dropNode({ id: d.id, kind: d.kind, collectionId: d.collectionId }, { id: row.id, kind: row.type, collectionId: row.collectionId }, hint.position);
  };

  const onDragEnd = () => {
    dragging = null;
    setDropHint(null);
  };

  const collapseAll = () => useApp.setState({ expanded: {} });
  const trimmed = filter.trim();
  const showRemote = trimmed.length >= 2 && (remoteItems.length > 0 || remoteError);

  return (
    <div className="cs-root">
      <div className="cs-head">
        <span className="cs-title">Collections</span>
        <span className="cs-spacer" />
        <IconButton label="Collapse all" onClick={collapseAll} disabled={collections.length === 0}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="m4 6 4 4 4-4M4 2.5h8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconButton>
        <Button size="sm" onClick={() => useUi.getState().openModal('import')}>
          Import
        </Button>
        <IconButton label="New collection" onClick={() => void createCollection()}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </IconButton>
      </div>
      <div className="cs-filter">
        <input type="search" aria-label="Filter collections" placeholder="Filter by name…" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
      </div>

      {collections.length === 0 ? (
        <EmptyState
          title="No collections yet"
          action={
            <div className="cs-empty-actions">
              <Button variant="primary" onClick={() => void createCollection()}>
                New collection
              </Button>
              <Button onClick={() => useUi.getState().openModal('import')}>Import</Button>
            </div>
          }
        >
          Create a collection or import a Postman collection to get started.
        </EmptyState>
      ) : (
        <div
          ref={scrollRef}
          className="cs-scroll"
          role="tree"
          aria-label="Collections"
          tabIndex={0}
          aria-activedescendant={focusedRow ? `cs-item-${focusedRow.id}` : undefined}
          onKeyDown={onKeyDown}
          onFocus={() => focusedId === null && rows[0] && setFocusedId(rows[0].id)}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHint(null);
          }}
        >
          {rows.length === 0 && <div className="cs-note">No matches for “{trimmed}”.</div>}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index];
              if (!row) return null;
              const isCurrent = row.type === 'request' && row.id === activeRequestId;
              const hint = dropHint?.id === row.id ? dropHint.position : null;
              const loading = row.type === 'collection' && row.expanded && !row.loaded;
              return (
                <div
                  key={v.key}
                  id={`cs-item-${row.id}`}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-selected={isCurrent}
                  aria-expanded={row.type === 'request' ? undefined : row.expanded}
                  draggable
                  className={`cs-row cs-${row.type} ${row.id === focusedRow?.id ? 'focused' : ''} ${isCurrent ? 'current' : ''} ${hint ? `drop-${hint}` : ''}`}
                  style={{ transform: `translateY(${v.start}px)`, height: ROW_HEIGHT, paddingLeft: 6 + row.depth * 14 }}
                  onClick={() => {
                    setFocusedId(row.id);
                    if (row.type === 'request') void openRequest(row.id);
                  }}
                  onDoubleClick={() => row.type !== 'request' && toggle(row)}
                  onContextMenu={(e: MouseEvent) => {
                    setFocusedId(row.id);
                    openMenu(e, entriesFor(row));
                  }}
                  onDragStart={(e) => onDragStart(e, row)}
                  onDragOver={(e) => onDragOver(e, row)}
                  onDrop={(e) => onDrop(e, row)}
                  onDragEnd={onDragEnd}
                  title={row.name}
                >
                  {row.type !== 'request' ? (
                    <span
                      className="cs-twisty"
                      aria-hidden="true"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFocusedId(row.id);
                        toggle(row);
                      }}
                    >
                      {loading ? <Spinner label="Loading collection" /> : <Chevron open={row.expanded} visible={row.type === 'collection' || row.hasChildren} />}
                    </span>
                  ) : (
                    <span className="cs-twisty" aria-hidden="true" />
                  )}
                  {row.type === 'collection' && <CollectionIcon />}
                  {row.type === 'folder' && <FolderIcon open={row.expanded} />}
                  {row.type === 'request' && <MethodLabel method={row.method ?? 'GET'} />}
                  <span className="cs-name">{row.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showRemote && (
        <div className="cs-remote" aria-label="More matches">
          <div className="cs-remote-title">More matches</div>
          {remoteError && <div className="cs-note">Search failed: {remoteError}</div>}
          {remoteItems.slice(0, 50).map((r) => (
            <button
              key={`${r.kind}-${r.id}`}
              type="button"
              className="cs-remote-item"
              onClick={() => {
                if (r.kind === 'request') void openRequest(r.id);
                else {
                  const cid = r.kind === 'collection' ? r.id : r.collectionId;
                  if (cid) void ensureTree(cid).then(() => setNodeExpanded(cid, true, true));
                  setFilter('');
                }
              }}
              title={r.subtitle}
            >
              {r.kind === 'request' && r.method ? <MethodLabel method={r.method} /> : <span className="cs-kind">{r.kind}</span>}
              <span className="cs-name">{r.name}</span>
              <span className="cs-sub">{r.subtitle}</span>
            </button>
          ))}
        </div>
      )}
      {menu}
    </div>
  );
}

function planPreview(nodes: TreeNode[], d: DragInfo, row: SidebarRow, position: DropPosition): MovePlan | null {
  if (d.kind === 'collection') return null;
  return planNodeMove(nodes, { id: d.id, kind: d.kind, collectionId: d.collectionId }, { id: row.id, kind: row.type, collectionId: row.collectionId }, position);
}
