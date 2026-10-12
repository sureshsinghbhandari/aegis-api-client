import type { ExecutionResult, ScriptType, VariableEntry } from '@aegis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, ErrorBanner, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import {
  changedNames,
  filterRows,
  mergeVariable,
  SCOPE_LABEL,
  snippetGet,
  snippetSet,
  templateRef,
  toRows,
  type ScriptVarRow,
  type ScriptVarScope,
  type WritableScriptVarScope,
} from '../lib/script-vars';
import { useApp } from '../store/app';
import '../styles/script-vars.css';

const AUTO_HIDE_MS = 20_000;
const MAX_FOLDER_DEPTH = 20;

interface Group {
  scope: ScriptVarScope;
  ownerId: string;
  title: string;
  production?: boolean;
  rows: ScriptVarRow[];
}

export interface ScriptVariablesPaneProps {
  phase: ScriptType;
  collectionId: string | null;
  folderId: string | null;
  /** `result.variableChanges` of the tab's last run (names only; used for the "changed" marker). */
  variableChanges?: ExecutionResult['variableChanges'] | undefined;
  /** Inserts code at the editor cursor. */
  onInsert(code: string): void;
}

/**
 * Side pane listing the variables a script can read (environment, globals, collection, folders)
 * with one-click `pm.*.get/set` insertion. Secret values stay masked until Reveal (auto-hides).
 */
export function ScriptVariablesPane({ phase, collectionId, folderId, variableChanges, onInsert }: ScriptVariablesPaneProps) {
  const workspaceId = useApp((s) => s.workspaceId);
  const environments = useApp((s) => s.environments);
  const historyVersion = useApp((s) => s.historyVersion);
  const activeEnv = useMemo(() => environments.find((e) => e.isActive) ?? null, [environments]);
  const activeEnvId = activeEnv?.id ?? null;

  const [groups, setGroups] = useState<Group[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

  // New-variable form
  const [showForm, setShowForm] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newScope, setNewScope] = useState<WritableScriptVarScope>('environment');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const mySeq = ++seq.current;
    setState('loading');
    setError(null);
    try {
      const next: Group[] = [];
      if (activeEnvId) {
        const entries = await api.variables.get({ scope: 'environment', ownerId: activeEnvId });
        next.push({ scope: 'environment', ownerId: activeEnvId, title: `Environment: ${activeEnv?.name ?? ''}`, production: activeEnv?.isProduction ?? false, rows: toRows('environment', activeEnvId, 'Environment', entries) });
      } else {
        next.push({ scope: 'environment', ownerId: '', title: 'Environment: none active', rows: [] });
      }
      if (workspaceId) {
        const entries = await api.variables.get({ scope: 'global', ownerId: workspaceId });
        next.push({ scope: 'globals', ownerId: workspaceId, title: 'Globals', rows: toRows('globals', workspaceId, 'Globals', entries) });
      }
      if (collectionId) {
        const entries = await api.variables.get({ scope: 'collection', ownerId: collectionId });
        next.push({ scope: 'collection', ownerId: collectionId, title: 'Collection', rows: toRows('collection', collectionId, 'Collection', entries) });
      }
      // Folder chain, innermost first, then shown outermost -> innermost (inner folders win at resolution time).
      const chain: Array<{ id: string; name: string }> = [];
      let cursor = folderId;
      while (cursor && chain.length < MAX_FOLDER_DEPTH) {
        const f = await api.folders.get({ id: cursor });
        chain.push({ id: f.id, name: f.name });
        cursor = f.parentFolderId;
      }
      for (const f of chain.reverse()) {
        const entries = await api.variables.get({ scope: 'folder', ownerId: f.id });
        const title = `Folder "${f.name}"`;
        next.push({ scope: 'folder', ownerId: f.id, title, rows: toRows('folder', f.id, title, entries) });
      }
      if (mySeq !== seq.current) return;
      setGroups(next);
      setState('ready');
    } catch (e) {
      if (mySeq !== seq.current) return;
      setError(errorMessage(e));
      setState('error');
    }
  }, [activeEnvId, activeEnv?.name, activeEnv?.isProduction, workspaceId, collectionId, folderId]);

  // historyVersion is bumped after every send, so values written by scripts show up here.
  useEffect(() => {
    void load();
  }, [load, historyVersion]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const rowId = (r: ScriptVarRow) => `${r.scope}:${r.ownerId}:${r.key}`;

  const hide = (id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setRevealed((m) => {
      if (!(id in m)) return m;
      const { [id]: _gone, ...rest } = m;
      return rest;
    });
  };

  const reveal = async (r: ScriptVarRow) => {
    const id = rowId(r);
    setBusy(id);
    try {
      const plain = await api.variables.revealSecret({ ref: r.raw });
      setRevealed((m) => ({ ...m, [id]: plain }));
      const prev = timers.current.get(id);
      if (prev) clearTimeout(prev);
      timers.current.set(id, setTimeout(() => hide(id), AUTO_HIDE_MS));
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const copyRef = async (key: string) => {
    const text = templateRef(key);
    try {
      await navigator.clipboard.writeText(text);
      useApp.getState().toast(`Copied ${text}`, 'success');
    } catch {
      useApp.getState().toast('Clipboard is not available.', 'error');
    }
  };

  const owners: Record<WritableScriptVarScope, { ownerId: string | null; apiScope: 'environment' | 'global' | 'collection'; why: string }> = {
    environment: { ownerId: activeEnvId, apiScope: 'environment', why: 'No active environment. Select one in the Environments sidebar first.' },
    globals: { ownerId: workspaceId, apiScope: 'global', why: 'No workspace is open.' },
    collection: { ownerId: collectionId, apiScope: 'collection', why: 'Save the request into a collection first.' },
  };
  const target = owners[newScope];

  const addVariable = async () => {
    if (!target.ownerId) {
      setFormError(target.why);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const existing: VariableEntry[] = await api.variables.get({ scope: target.apiScope, ownerId: target.ownerId });
      const merged = mergeVariable(existing, newKey, newValue);
      if (!merged.ok) {
        setFormError(merged.error);
        return;
      }
      await api.variables.set({ scope: target.apiScope, ownerId: target.ownerId, entries: merged.entries });
      const app = useApp.getState();
      app.toast(merged.action === 'added' ? `Variable "${newKey.trim()}" added` : `Variable "${newKey.trim()}" updated`, 'success');
      if (newScope !== 'collection') await app.refreshEnvironments();
      setNewKey('');
      setNewValue('');
      setShowForm(false);
      await load();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const changed = useMemo(() => changedNames(variableChanges), [variableChanges]);
  const needle = filter.trim();
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <aside className="sv" aria-label="Script variables">
      <div className="sv-toolbar">
        <input aria-label="Filter script variables" className="sv-filter" placeholder="Filter variables…" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
        <Button size="sm" onClick={() => void load()} title="Reload values" disabled={state === 'loading'}>
          ↻
        </Button>
        <Button size="sm" aria-expanded={showForm} onClick={() => setShowForm((v) => !v)} title="Create a variable in the active environment, the globals or the collection">
          + New
        </Button>
      </div>

      {showForm && (
        <form
          className="sv-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addVariable();
          }}
        >
          <input aria-label="New variable name" placeholder="name" value={newKey} onChange={(e) => setNewKey(e.target.value)} spellCheck={false} autoFocus />
          <input aria-label="New variable value" placeholder="value" value={newValue} onChange={(e) => setNewValue(e.target.value)} spellCheck={false} />
          <select aria-label="New variable scope" value={newScope} onChange={(e) => setNewScope(e.target.value as WritableScriptVarScope)}>
            <option value="environment">Environment{activeEnv ? ` (${activeEnv.name})` : ' (none active)'}</option>
            <option value="globals">Globals</option>
            <option value="collection" disabled={!collectionId}>
              Collection
            </option>
          </select>
          {!target.ownerId && <div className="sv-form-hint">{target.why}</div>}
          {formError && <div className="sv-form-error" role="alert">{formError}</div>}
          <div className="sv-form-actions">
            <Button size="sm" variant="primary" type="submit" disabled={saving || !target.ownerId || newKey.trim() === ''}>
              {saving ? 'Saving…' : 'Add'}
            </Button>
            <Button size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {state === 'loading' && groups.length === 0 && (
        <div className="sv-center">
          <Spinner label="Loading variables" />
        </div>
      )}
      {state === 'error' && <ErrorBanner message={error ?? 'Could not load variables.'} onRetry={() => void load()} />}

      <div className="sv-scroll">
        {groups.map((g) => {
          const rows = filterRows(g.rows, needle);
          if (needle && rows.length === 0) return null;
          return (
            <section key={`${g.scope}:${g.ownerId}`} className="sv-group">
              <div className="sv-group-title">
                <span>{g.title}</span>
                {g.production && (
                  <Badge tone="danger" title="Production environment">
                    prod
                  </Badge>
                )}
              </div>
              {rows.length === 0 ? (
                <div className="sv-empty">{g.scope === 'environment' && !g.ownerId ? 'pm.environment.set() is discarded without an active environment.' : 'No variables.'}</div>
              ) : (
                rows.map((r) => {
                  const id = rowId(r);
                  const shown = revealed[id];
                  return (
                    <div key={id} className={`sv-row${r.enabled ? '' : ' sv-disabled'}`}>
                      <div className="sv-row-main">
                        <span className="sv-key mono" title={r.key}>
                          {r.key}
                        </span>
                        <Badge title={`${PM_ACCESSOR_HINT[r.scope]} scope`}>{SCOPE_LABEL[r.scope]}</Badge>
                        {changed.has(r.key) && (
                          <Badge tone="info" title="Changed by the last run of this request">
                            changed
                          </Badge>
                        )}
                      </div>
                      <div className="sv-row-value">
                        <span className={`sv-value mono${r.secret && shown === undefined ? ' sv-masked' : ''}`} title={r.secret ? undefined : r.display}>
                          {r.secret ? (shown ?? r.display) : r.display || <em className="sv-faint">(empty)</em>}
                        </span>
                        {r.secret &&
                          (shown === undefined ? (
                            <button type="button" className="btn btn-sm" disabled={busy === id} onClick={() => void reveal(r)} title="Show the secret value for 20 seconds">
                              Reveal
                            </button>
                          ) : (
                            <button type="button" className="btn btn-sm" onClick={() => hide(id)}>
                              Hide
                            </button>
                          ))}
                      </div>
                      <div className="sv-row-actions">
                        <button type="button" className="sv-act" onClick={() => onInsert(snippetGet(r.scope, r.key))} title={snippetGet(r.scope, r.key)}>
                          Insert get
                        </button>
                        <button type="button" className="sv-act" onClick={() => onInsert(snippetSet(r.scope, r.key, r.secret ? '' : r.raw, r.secret))} title={snippetSet(r.scope, r.key, r.secret ? '' : r.raw, r.secret).trim()}>
                          Insert set
                        </button>
                        <button type="button" className="sv-act" onClick={() => void copyRef(r.key)} title={`Copy ${templateRef(r.key)} to the clipboard`}>
                          Copy {'{{'}
                          {r.key.length > 12 ? `${r.key.slice(0, 11)}…` : r.key}
                          {'}}'}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </section>
          );
        })}
        {state === 'ready' && total === 0 && <div className="sv-empty">No variables yet. Use "+ New" or {phase === 'prerequest' ? 'pm.environment.set(...)' : 'pm.environment.set("token", pm.response.json().token)'} in a script.</div>}
      </div>
      <p className="sv-hint">Values set by scripts appear after the next send. Secrets stay masked until you press Reveal.</p>
    </aside>
  );
}

const PM_ACCESSOR_HINT: Record<ScriptVarScope, string> = {
  environment: 'pm.environment',
  globals: 'pm.globals',
  collection: 'pm.collectionVariables',
  folder: 'pm.collectionVariables (folder variables are merged into the collection scope)',
};
