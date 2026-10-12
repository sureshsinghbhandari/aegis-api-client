import { useCallback, useEffect, useRef, useState } from 'react';
import { HTTP_METHODS, newId, type HistoryItem, type TreeNode } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { withProductionConfirm } from '../lib/confirm-production';
import { folderOptions } from '../lib/tree-helpers';
import { relativeTime, truncate } from '../lib/ui-format';
import { Badge, Button, EmptyState, ErrorBanner, IconButton, MethodLabel, Modal, Spinner, formatMs, statusTone } from '../components/ui';
import { VirtualList } from '../components/VirtualList';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import '../styles/panels.css';

const PAGE = 50;
const ROW_HEIGHT = 50;

type SortBy = 'createdAt' | 'durationMs' | 'statusCode';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function HistoryPanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  const historyVersion = useApp((s) => s.historyVersion);
  const [text, setText] = useState('');
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState<HistoryItem | null>(null);
  const debouncedText = useDebounced(text, 300);
  const seq = useRef(0);

  const query = useCallback(
    (offset: number) => ({
      workspaceId: workspaceId ?? '',
      ...(debouncedText.trim() ? { text: debouncedText.trim() } : {}),
      ...(method ? { method } : {}),
      ...(status ? { status } : {}),
      sortBy,
      sortDir,
      limit: PAGE,
      offset,
    }),
    [workspaceId, debouncedText, method, status, sortBy, sortDir],
  );

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.history.search(query(0));
      if (mine !== seq.current) return;
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [workspaceId, query]);

  // historyVersion is bumped whenever a request is sent, so the list refetches.
  useEffect(() => {
    void reload();
  }, [reload, historyVersion]);

  const loadMore = async () => {
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const res = await api.history.search(query(items.length));
      if (mine !== seq.current) return;
      setItems((prev) => [...prev, ...res.items.filter((r) => !prev.some((p) => p.id === r.id))]);
      setTotal(res.total);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const rerun = async (item: HistoryItem) => {
    const app = useApp.getState();
    setBusyId(item.id);
    try {
      const executionId = newId();
      const result = await withProductionConfirm((confirmProduction) => api.history.replay({ id: item.id, executionId, ...(confirmProduction ? { confirmProduction: true } : {}) }), 're-run this request');
      if (!result) return;
      app.bumpHistory();
      const summary = result.response ? `${item.method} ${result.response.status} ${result.response.statusText} in ${formatMs(result.response.timings.totalMs)}` : `${item.method} failed: ${result.error?.message ?? 'no response'}`;
      app.toast(`Re-run: ${summary}`, result.ok ? 'success' : 'error');
      if (item.requestId) {
        const exists = await api.requests.get({ id: item.requestId }).then(
          () => true,
          () => false,
        );
        if (exists) {
          await app.openRequest(item.requestId);
          useApp.setState((s) => ({
            tabs: s.tabs.map((t) => (t.requestId === item.requestId ? { ...t, response: { status: result.ok ? 'done' : 'error', executionId: result.executionId, result } } : t)),
          }));
        }
      }
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: HistoryItem) => {
    const ok = await useUi.getState().confirm({ title: 'Delete history entry', message: `Delete ${item.method} ${truncate(item.url, 120)} from the history?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.history.delete({ id: item.id });
      setItems((prev) => prev.filter((p) => p.id !== item.id));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'error');
    }
  };

  const clearAll = async () => {
    if (!workspaceId) return;
    const ok = await useUi.getState().confirm({
      title: 'Clear history',
      message: 'Permanently delete the complete request history of this workspace? Saved collections are not affected.',
      confirmLabel: 'Clear history',
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await api.history.clear({ workspaceId });
      useApp.getState().toast(`History cleared (${n} entries)`, 'success');
      useApp.getState().bumpHistory();
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'error');
    }
  };

  const filtered = text !== '' || method !== '' || status !== '';

  return (
    <div className="panel">
      <div className="panel-toolbar panel-col">
        <input type="search" aria-label="Search history" placeholder="Search URL, name…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="panel-row">
          <select aria-label="Filter by method" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">All methods</option>
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="2xx">2xx success</option>
            <option value="3xx">3xx redirect</option>
            <option value="4xx">4xx client error</option>
            <option value="5xx">5xx server error</option>
            <option value="error">Failed / no response</option>
          </select>
        </div>
        <div className="panel-row">
          <select aria-label="Sort by" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
            <option value="createdAt">Sort: time</option>
            <option value="durationMs">Sort: duration</option>
            <option value="statusCode">Sort: status</option>
          </select>
          <IconButton label={sortDir === 'desc' ? 'Descending, click for ascending' : 'Ascending, click for descending'} onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
            {sortDir === 'desc' ? '↓' : '↑'}
          </IconButton>
          <span className="panel-spacer" />
          <Button size="sm" variant="ghost" onClick={() => void clearAll()} disabled={total === 0 && !filtered}>
            Clear history
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void reload()} />}

      <div className="panel-body">
        {loading && items.length === 0 ? (
          <div className="center-fill" style={{ padding: 24 }}>
            <Spinner label="Loading history" />
          </div>
        ) : items.length === 0 && !error ? (
          <EmptyState title={filtered ? 'No matching history' : 'No history yet'}>{filtered ? 'Try different filters.' : 'Requests you send are listed here. Response bodies are not stored unless you turn that on in Settings.'}</EmptyState>
        ) : (
          <VirtualList
            label="Request history"
            count={items.length}
            rowHeight={ROW_HEIGHT}
            renderRow={(i) => {
              const item = items[i]!;
              return <HistoryRow key={item.id} item={item} busy={busyId === item.id} onRerun={() => void rerun(item)} onSave={() => setSaving(item)} onDelete={() => void remove(item)} />;
            }}
            footer={
              items.length < total ? (
                <div className="panel-more">
                  <Button size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? 'Loading…' : `Load more (${items.length} of ${total})`}
                  </Button>
                </div>
              ) : null
            }
          />
        )}
      </div>

      <div className="panel-note">
        Privacy: only metadata (method, URL, status, timing) is kept by default; bodies are not stored.{' '}
        <button type="button" className="link-btn" onClick={() => useUi.getState().openModal('settings', { section: 'history' })}>
          History settings
        </button>
      </div>

      {saving && <SaveToCollectionDialog item={saving} onClose={() => setSaving(null)} />}
    </div>
  );
}

function HistoryRow({ item, busy, onRerun, onSave, onDelete }: { item: HistoryItem; busy: boolean; onRerun(): void; onSave(): void; onDelete(): void }) {
  const failed = item.statusCode === null;
  return (
    <div className="hist-row" role="listitem" style={{ height: ROW_HEIGHT }}>
      <div className="hist-line">
        <MethodLabel method={item.method} />
        <span className="hist-url" title={item.url}>
          {item.url}
        </span>
        {failed ? (
          <Badge tone="danger" title={item.errorCode ?? 'No response'}>
            {item.errorCode ? 'ERR' : '—'}
          </Badge>
        ) : (
          <Badge tone={statusTone(item.statusCode)} title={item.statusText ?? undefined}>
            {item.statusCode}
          </Badge>
        )}
      </div>
      <div className="hist-line hist-meta">
        <span>{item.durationMs !== null ? formatMs(item.durationMs) : '—'}</span>
        <span title={item.createdAt}>{relativeTime(item.createdAt)}</span>
        {item.environmentName && <span className="hist-env">{item.environmentName}</span>}
        <span className="panel-spacer" />
        <span className="hist-actions">
          <IconButton label="Re-run" disabled={busy} onClick={onRerun}>
            {busy ? '…' : '▶'}
          </IconButton>
          <IconButton label="Save to collection" onClick={onSave}>
            💾
          </IconButton>
          <IconButton label="Delete history entry" onClick={onDelete}>
            🗑
          </IconButton>
        </span>
      </div>
    </div>
  );
}

function SaveToCollectionDialog({ item, onClose }: { item: HistoryItem; onClose(): void }) {
  const collections = useApp((s) => s.collections);
  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? '');
  const [folderId, setFolderId] = useState('');
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!collectionId) return;
    let live = true;
    setFolderId('');
    api.collections.tree({ collectionId }).then(
      (nodes) => live && setTree(nodes),
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [collectionId]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.history.saveToCollection({ id: item.id, collectionId, folderId: folderId || null });
      await useApp.getState().refreshTree(collectionId);
      useApp.getState().toast('Saved to collection', 'success');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Save to collection"
      width={460}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!collectionId || busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <p className="pre-wrap">
        {item.method} {truncate(item.url, 100)}
      </p>
      {collections.length === 0 ? (
        <EmptyState title="No collections">Create a collection first.</EmptyState>
      ) : (
        <>
          <label className="field">
            <span className="field-label">Collection</span>
            <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Folder</span>
            <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">(collection root)</option>
              {folderOptions(tree).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {error && <ErrorBanner message={error} />}
    </Modal>
  );
}
