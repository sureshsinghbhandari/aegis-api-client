import { FIND_REPLACE_SCOPES, type FindReplaceResult, type FindReplaceScope } from '@aegis/core';
import { useCallback, useMemo, useState } from 'react';
import { Button, Checkbox, ErrorBanner, Field, Modal } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { SCOPE_LABELS, partitionTabsForReload, previewKey } from '../lib/find-replace-helpers';
import { formatCount } from '../lib/ui-format';
import { isDirty, useApp } from '../store/app';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/collection-ops.css';

type Target = 'collection' | 'workspace';

/**
 * Find & replace across one collection or the whole workspace. The user previews first (counts and
 * before/after excerpts, nothing written), then confirms the replace, which runs in one transaction
 * in the main process. Secrets are never searched or changed.
 */
export default function FindReplaceModal({ props }: ModalComponentProps) {
  const collections = useApp((s) => s.collections);
  const workspaceId = useApp((s) => s.workspaceId);
  const initial = typeof props?.collectionId === 'string' ? props.collectionId : null;

  const [target, setTarget] = useState<Target>('collection');
  const [collectionId, setCollectionId] = useState<string>(initial ?? collections[0]?.id ?? '');
  const [find, setFind] = useState(typeof props?.find === 'string' ? props.find : '');
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [scopes, setScopes] = useState<Set<FindReplaceScope>>(() => new Set(FIND_REPLACE_SCOPES));
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; result: FindReplaceResult } | null>(null);

  const input = useMemo(
    () => ({
      ...(target === 'collection' ? { collectionId } : { workspaceId: workspaceId ?? '' }),
      find,
      replace,
      scopes: [...scopes],
      matchCase,
      wholeWord,
      useRegex,
    }),
    [target, collectionId, workspaceId, find, replace, scopes, matchCase, wholeWord, useRegex],
  );
  const key = previewKey(input);
  const previewCurrent = preview !== null && preview.key === key;
  const canRun = find !== '' && scopes.size > 0 && (target === 'workspace' ? !!workspaceId : !!collectionId) && busy === null;

  const close = useCallback(() => useUi.getState().closeModal(), []);

  const toggleScope = (s: FindReplaceScope, on: boolean) =>
    setScopes((prev) => {
      const next = new Set(prev);
      if (on) next.add(s);
      else next.delete(s);
      return next;
    });

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      const result = await api.collections.findReplace({ ...input, apply: false });
      setPreview({ key, result });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const runApply = async () => {
    if (!previewCurrent || !preview || preview.result.matches === 0) return;
    const ok = await useUi.getState().confirm({
      title: 'Replace all?',
      message: `This will change ${preview.result.summary} ${target === 'workspace' ? 'across the whole workspace' : 'in this collection'}. The change is saved immediately and cannot be undone.`,
      confirmLabel: 'Replace',
      danger: true,
    });
    if (!ok) return;
    setBusy('apply');
    setError(null);
    try {
      const result = await api.collections.findReplace({ ...input, apply: true });
      setPreview({ key, result });
      await refreshAfterReplace(target === 'collection' ? new Set([collectionId]) : null);
      useApp.getState().toast(`Replaced: ${result.summary}`, 'success');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const counts = preview ? (Object.entries(preview.result.byScope) as Array<[FindReplaceScope, number]>).filter(([, n]) => n > 0) : [];

  return (
    <Modal
      title="Find & Replace"
      width={860}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Close</Button>
          <Button onClick={() => void runPreview()} disabled={!canRun}>
            {busy === 'preview' ? 'Searching…' : 'Preview'}
          </Button>
          <Button variant="danger" onClick={() => void runApply()} disabled={!canRun || !previewCurrent || !preview || preview.result.matches === 0 || preview.result.applied} title={previewCurrent ? undefined : 'Preview first'}>
            {busy === 'apply' ? 'Replacing…' : 'Replace all'}
          </Button>
        </>
      }
    >
      <div className="fr-grid">
        <Field label="Find">
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={useRegex ? 'Regular expression' : 'Text to find'} spellCheck={false} autoFocus />
        </Field>
        <Field label="Replace with" hint={useRegex ? '$1, $2 and $& refer to captured groups.' : undefined}>
          <input value={replace} onChange={(e) => setReplace(e.target.value)} placeholder="Replacement (may be empty)" spellCheck={false} />
        </Field>
      </div>
      <div className="fr-options">
        <Checkbox checked={matchCase} onChange={setMatchCase} label="Match case" />
        <Checkbox checked={wholeWord} onChange={setWholeWord} label="Whole word" />
        <Checkbox checked={useRegex} onChange={setUseRegex} label="Regular expression" />
      </div>
      <div className="fr-grid">
        <Field label="Search in">
          <select value={target} onChange={(e) => setTarget(e.target.value as Target)}>
            <option value="collection">One collection</option>
            <option value="workspace">Whole workspace ({collections.length} collections)</option>
          </select>
        </Field>
        {target === 'collection' && (
          <Field label="Collection">
            <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <Field label="Scopes">
        <div className="fr-scopes">
          {FIND_REPLACE_SCOPES.map((s) => (
            <Checkbox key={s} checked={scopes.has(s)} onChange={(on) => toggleScope(s, on)} label={SCOPE_LABELS[s]} />
          ))}
        </div>
      </Field>
      {error && <ErrorBanner message={error} />}
      {preview && (
        <div aria-live="polite">
          <div className="fr-summary">
            {preview.result.applied ? 'Replaced: ' : 'Preview: '}
            {preview.result.summary}
            {!previewCurrent && ' (inputs changed — preview again before replacing)'}
          </div>
          {counts.length > 0 && (
            <div className="fr-counts">
              {counts.map(([s, n]) => (
                <span key={s}>
                  {SCOPE_LABELS[s]}: {formatCount(n)}
                </span>
              ))}
              {preview.result.collections > 1 && <span>Collections: {preview.result.collections}</span>}
            </div>
          )}
          {preview.result.samples.length > 0 && (
            <div className="fr-samples">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Where</th>
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.result.samples.map((s, i) => (
                    <tr key={i}>
                      <td className="fr-loc" title={s.location}>
                        {s.location}
                      </td>
                      <td className="fr-snippet">{s.before}</td>
                      <td className="fr-snippet">{s.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.result.matches > preview.result.samples.length && <div className="fr-note">Showing the first {preview.result.samples.length} of {formatCount(preview.result.matches)} matches.</div>}
        </div>
      )}
      <div className="fr-note">Secret values (vaulted credentials and secret variables) are never searched or changed. The replace runs as one transaction: either everything changes or nothing does.</div>
    </Modal>
  );
}

/** Refresh trees and reload open tabs whose saved request may have changed; dirty tabs are kept and the user is warned. */
async function refreshAfterReplace(affected: ReadonlySet<string> | null): Promise<void> {
  const app = useApp.getState();
  await app.refreshCollections().catch(() => undefined);
  const treeIds = Object.keys(app.trees).filter((id) => !affected || affected.has(id));
  await Promise.all(treeIds.map((id) => app.refreshTree(id).catch(() => undefined)));
  const { reload, keep } = partitionTabsForReload(
    app.tabs.map((t) => ({ tabId: t.tabId, requestId: t.requestId, collectionId: t.collectionId, dirty: isDirty(t) })),
    affected,
  );
  for (const tabId of reload) {
    const tab = useApp.getState().tabs.find((t) => t.tabId === tabId);
    if (!tab?.requestId) continue;
    try {
      const r = await api.requests.get({ id: tab.requestId });
      const { id: _i, collectionId, folderId, sortOrder: _s, createdAt: _c, updatedAt: _u, ...draft } = r;
      useApp.setState((s) => ({ tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, collectionId, folderId, draft, savedJson: JSON.stringify(draft) } : t)) }));
    } catch {
      /* the tab keeps its last known state; syncTabsAfterChange closes it if the request is gone */
    }
  }
  useApp.getState().syncTabsAfterChange();
  if (keep.length) useApp.getState().toast(`${keep.length} open tab(s) with unsaved changes were not reloaded. Saving them would overwrite the replaced text.`, 'info');
}
