import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newId, type VariableEntry, type VariableOwner } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { isSecretRef } from '../lib/ui-format';
import { blankVariable, entriesSignature, invalidKeys, prepareEntries } from '../lib/variables-helpers';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { Button, ErrorBanner, IconButton, Spinner } from './ui';
import { SecretValue } from './SecretValue';
import '../styles/panels.css';

interface Row {
  uid: string;
  entry: VariableEntry;
}

const toRows = (entries: VariableEntry[]): Row[] => entries.map((entry) => ({ uid: newId(), entry }));

export interface VariablesEditorProps {
  owner: VariableOwner;
  /** Called after the variables were saved successfully. */
  onSaved?: () => void;
  /** Reports unsaved changes so a parent can warn before switching away. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * Table editor for the variables of an environment, the globals, a collection or a folder.
 * Secret values are never shown: they appear as masked dots with an explicit Reveal action.
 */
export function VariablesEditor({ owner, onSaved, onDirtyChange }: VariablesEditorProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [original, setOriginal] = useState<string>(entriesSignature([]));
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');
  const reqSeq = useRef(0);
  const { scope, ownerId } = owner;

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setState('loading');
    setError(null);
    try {
      const entries = await api.variables.get({ scope, ownerId });
      if (seq !== reqSeq.current) return;
      setRows(toRows(entries));
      setOriginal(entriesSignature(entries));
      setState('ready');
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(errorMessage(e));
      setState('error');
    }
  }, [scope, ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const entries = useMemo(() => rows.map((r) => r.entry), [rows]);
  const dirty = state === 'ready' && entriesSignature(entries) !== original;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const patchRow = (uid: string, patch: Partial<VariableEntry>) => setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, entry: { ...r.entry, ...patch } } : r)));

  const toggleSecret = async (row: Row, makeSecret: boolean) => {
    const e = row.entry;
    if (makeSecret || (!isSecretRef(e.initialValue) && !isSecretRef(e.currentValue))) {
      patchRow(row.uid, { isSecret: makeSecret });
      return;
    }
    // Secret -> plain: the stored values must be revealed first, otherwise only an opaque reference would remain.
    const ok = await useUi.getState().confirm({
      title: 'Make variable non-secret?',
      message: `"${e.key || 'This variable'}" will be shown and stored as plain text (and included in exports). Its secret value will be revealed in this editor.`,
      confirmLabel: 'Make non-secret',
      danger: true,
    });
    if (!ok) return;
    try {
      const initialValue = isSecretRef(e.initialValue) ? await api.variables.revealSecret({ ref: e.initialValue }) : e.initialValue;
      const currentValue = e.currentValue && isSecretRef(e.currentValue) ? await api.variables.revealSecret({ ref: e.currentValue }) : (e.currentValue ?? '');
      patchRow(row.uid, { isSecret: false, initialValue, currentValue });
    } catch (err) {
      useApp.getState().toast(errorMessage(err), 'error');
    }
  };

  const save = async () => {
    const prepared = prepareEntries(entries);
    const bad = invalidKeys(prepared.entries);
    if (bad.length) {
      setSaveError(`Invalid variable name(s): ${bad.join(', ')}. Names must not contain "{" or "}".`);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.variables.set({ scope, ownerId, entries: prepared.entries });
      setRows(toRows(saved));
      setOriginal(entriesSignature(saved));
      const app = useApp.getState();
      app.toast(prepared.duplicates.length ? `Variables saved. Duplicate names (last one wins): ${prepared.duplicates.join(', ')}` : 'Variables saved', prepared.duplicates.length ? 'info' : 'success');
      if (scope === 'environment' || scope === 'global') await app.refreshEnvironments();
      onSaved?.();
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const revert = () => {
    setSaveError(null);
    void load();
  };

  if (state === 'loading') {
    return (
      <div className="center-fill" style={{ padding: 24 }}>
        <Spinner label="Loading variables" />
      </div>
    );
  }
  if (state === 'error') return <ErrorBanner message={error ?? 'Could not load variables.'} onRetry={() => void load()} />;

  const needle = filter.trim().toLowerCase();
  const visible = rows.filter((r) => !needle || r.entry.key.toLowerCase().includes(needle) || (r.entry.description ?? '').toLowerCase().includes(needle));

  return (
    <div className="ve">
      <div className="ve-toolbar">
        <Button size="sm" onClick={() => setRows((rs) => [...rs, { uid: newId(), entry: blankVariable() }])}>
          + Add variable
        </Button>
        <input aria-label="Filter variables" placeholder="Filter by name…" value={filter} onChange={(e) => setFilter(e.target.value)} className="ve-filter" />
        <span className="ve-spacer" />
        {dirty && <span className="ve-dirty">Unsaved changes</span>}
        <Button size="sm" onClick={revert} disabled={!dirty || saving}>
          Revert
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {saveError && <ErrorBanner message={saveError} />}
      {rows.length === 0 ? (
        <div className="empty">
          <div className="empty-title">No variables yet</div>
          <div className="empty-body">Add a variable and reference it as {'{{name}}'} in requests.</div>
        </div>
      ) : (
        <div className="ve-scroll">
          <div className="ve-table" role="table" aria-label="Variables">
            <div className="ve-row ve-head" role="row">
              <span role="columnheader">On</span>
              <span role="columnheader">Variable</span>
              <span role="columnheader">Initial value</span>
              <span role="columnheader">Current value</span>
              <span role="columnheader">Secret</span>
              <span role="columnheader">Description</span>
              <span />
            </div>
            {visible.map((r) => {
              const e = r.entry;
              const name = e.key || 'new variable';
              return (
                <div key={r.uid} className={`ve-row ${e.enabled ? '' : 've-disabled'}`} role="row">
                  <input type="checkbox" aria-label={`Enable ${name}`} checked={e.enabled} onChange={(ev) => patchRow(r.uid, { enabled: ev.target.checked })} />
                  <input aria-label="Variable name" value={e.key} placeholder="name" spellCheck={false} onChange={(ev) => patchRow(r.uid, { key: ev.target.value })} />
                  {e.isSecret ? (
                    <SecretValue label={`Initial value of ${name}`} value={e.initialValue} onChange={(v) => patchRow(r.uid, { initialValue: v })} />
                  ) : (
                    <input aria-label={`Initial value of ${name}`} value={e.initialValue} spellCheck={false} onChange={(ev) => patchRow(r.uid, { initialValue: ev.target.value })} />
                  )}
                  {e.isSecret ? (
                    <SecretValue label={`Current value of ${name}`} placeholder="(uses initial)" value={e.currentValue ?? ''} onChange={(v) => patchRow(r.uid, { currentValue: v })} />
                  ) : (
                    <input aria-label={`Current value of ${name}`} value={e.currentValue ?? ''} placeholder="(uses initial)" spellCheck={false} onChange={(ev) => patchRow(r.uid, { currentValue: ev.target.value })} />
                  )}
                  <label className="ve-secret">
                    <input type="checkbox" aria-label={`${name} is secret`} checked={e.isSecret} onChange={(ev) => void toggleSecret(r, ev.target.checked)} />
                    <span>{e.isSecret ? '🔒' : ''}</span>
                  </label>
                  <input aria-label={`Description of ${name}`} value={e.description ?? ''} placeholder="Description" onChange={(ev) => patchRow(r.uid, { description: ev.target.value })} />
                  <IconButton label={`Remove ${name}`} onClick={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))}>
                    ✕
                  </IconButton>
                </div>
              );
            })}
            {visible.length === 0 && <div className="empty-body" style={{ padding: 12 }}>No variables match the filter.</div>}
          </div>
        </div>
      )}
      <p className="field-hint">Secret values are stored in the OS secure storage and are never shown unless you press Reveal. Empty current value means the initial value is used.</p>
    </div>
  );
}
