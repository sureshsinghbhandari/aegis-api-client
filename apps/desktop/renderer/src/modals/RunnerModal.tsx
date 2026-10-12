import { useEffect, useMemo, useState } from 'react';
import type { TreeNode } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { effectiveIterations, moveId, previewDataFile, requestIdsForRun, runnableRequestsInScope, type DataPreview } from '../lib/runner-helpers';
import { parseBoundedInt } from '../lib/settings-helpers';
import { folderOptions } from '../lib/tree-helpers';
import { Button, Checkbox, EmptyState, ErrorBanner, Field, MethodLabel, Modal } from '../components/ui';
import { useApp } from '../store/app';
import { useRunner } from '../store/runner';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/panels.css';

const MAX_DATA_BYTES = 50 * 1024 * 1024;

export default function RunnerModal({ props }: ModalComponentProps) {
  const collections = useApp((s) => s.collections);
  const environments = useApp((s) => s.environments);
  const workspaceId = useApp((s) => s.workspaceId);
  const starting = useRunner((s) => s.starting);
  const runnerError = useRunner((s) => s.error);

  const [collectionId, setCollectionId] = useState<string>(typeof props?.collectionId === 'string' ? props.collectionId : (collections[0]?.id ?? ''));
  const [folderId, setFolderId] = useState<string>(typeof props?.folderId === 'string' ? props.folderId : '');
  const [environmentId, setEnvironmentId] = useState<string>(environments.find((e) => e.isActive)?.id ?? '');
  const [iterations, setIterations] = useState('1');
  const [delayMs, setDelayMs] = useState('0');
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [keepResponses, setKeepResponses] = useState(false);
  const [data, setData] = useState<{ name: string; content: string; preview: DataPreview } | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [showRequests, setShowRequests] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    useRunner.getState().clearError();
  }, []);

  useEffect(() => {
    if (!collectionId) return;
    let live = true;
    setTreeError(null);
    api.collections.tree({ collectionId }).then(
      (nodes) => {
        if (!live) return;
        setTree(nodes);
        setFolderId((f) => (f && nodes.some((n) => n.id === f && n.kind === 'folder') ? f : ''));
      },
      (e) => live && setTreeError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [collectionId]);

  const scoped = useMemo(() => runnableRequestsInScope(tree, folderId || null), [tree, folderId]);
  const defaultOrder = useMemo(() => scoped.map((r) => r.id), [scoped]);
  // Whenever the scope changes, start again from "everything, tree order".
  useEffect(() => {
    setOrder(defaultOrder);
    setSelected(new Set(defaultOrder));
  }, [defaultOrder]);
  const byId = useMemo(() => new Map(scoped.map((r) => [r.id, r])), [scoped]);
  const requestIds = requestIdsForRun(order, selected, defaultOrder);
  const chosenCount = order.filter((id) => selected.has(id)).length;

  const collection = collections.find((c) => c.id === collectionId);
  const iterN = parseBoundedInt(iterations, 1, 100_000);
  const delayN = parseBoundedInt(delayMs, 0, 600_000);
  const effective = iterN === null ? null : effectiveIterations(iterN, data?.preview.rowCount ?? null);
  const valid = Boolean(collectionId && workspaceId && iterN !== null && delayN !== null && chosenCount > 0);

  const onFile = async (file: File | undefined) => {
    setDataError(null);
    if (!file) return;
    if (file.size > MAX_DATA_BYTES) {
      setDataError(`The data file is larger than ${MAX_DATA_BYTES / 1024 / 1024} MB.`);
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch {
      setDataError('Could not read the file.');
      return;
    }
    const preview = previewDataFile(file.name, content);
    if ('error' in preview) {
      setData(null);
      setDataError(preview.error);
      return;
    }
    setData({ name: file.name, content, preview });
    if (iterN === null || iterN < preview.rowCount) setIterations(String(preview.rowCount));
  };

  const start = async () => {
    if (!valid || iterN === null || delayN === null || !workspaceId || !collection) return;
    const ok = await useRunner.getState().start({
      workspaceId,
      collectionId,
      folderId: folderId || null,
      environmentId: environmentId || null,
      iterations: effective ?? iterN,
      delayMs: delayN,
      stopOnFailure,
      ...(keepResponses ? { keepResponses: true } : {}),
      ...(requestIds ? { requestIds } : {}),
      ...(data ? { dataFile: { name: data.name, content: data.content } } : {}),
      collectionName: collection.name + (folderId ? ` / ${folderOptions(tree).find((f) => f.id === folderId)?.label ?? ''}` : ''),
    });
    if (ok) {
      useUi.getState().closeModal();
      const app = useApp.getState();
      if (!(app.bottomOpen && app.bottomPanel === 'runner')) app.toggleBottom('runner');
    }
  };

  const activeEnv = environments.find((e) => e.id === environmentId);
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Modal
      title="Collection runner"
      width={640}
      onClose={() => useUi.getState().closeModal()}
      footer={
        <>
          <Button onClick={() => useUi.getState().closeModal()}>Cancel</Button>
          <Button variant="primary" disabled={!valid || starting} onClick={() => void start()}>
            {starting ? 'Starting…' : 'Start run'}
          </Button>
        </>
      }
    >
      {collections.length === 0 ? (
        <EmptyState title="No collections">Create or import a collection to run it.</EmptyState>
      ) : (
        <>
          <div className="env-details-grid">
            <Field label="Collection">
              <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Folder (optional)" hint={treeError ?? `${scoped.length} request(s) in scope`}>
              <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                <option value="">Whole collection</option>
                {folderOptions(tree).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="field">
            <button type="button" className="link-btn" aria-expanded={showRequests} onClick={() => setShowRequests((v) => !v)}>
              {showRequests ? '▾' : '▸'} Requests to run: {chosenCount} of {scoped.length}
              {requestIds ? ' (custom selection / order)' : ' (all, in collection order)'}
            </button>
            {showRequests && (
              <div className="runner-select" role="group" aria-label="Requests to run">
                <div className="set-row">
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(order))}>
                    Select all
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    Select none
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setOrder(defaultOrder);
                      setSelected(new Set(defaultOrder));
                    }}
                  >
                    Reset order
                  </Button>
                </div>
                {order.length === 0 ? (
                  <div className="field-hint">No requests in this scope.</div>
                ) : (
                  <ol className="runner-select-list">
                    {order.map((id, i) => {
                      const r = byId.get(id);
                      if (!r) return null;
                      return (
                        <li key={id} className={selected.has(id) ? '' : 'runner-select-off'}>
                          <label>
                            <input type="checkbox" checked={selected.has(id)} onChange={(e) => toggle(id, e.target.checked)} />
                            <MethodLabel method={r.method} /> <span className="runner-select-name">{r.name}</span>
                            {r.path && <span className="field-hint"> {r.path}</span>}
                          </label>
                          <span className="runner-select-move">
                            <button type="button" className="link-btn" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => setOrder((o) => moveId(o, id, -1))}>
                              ▲
                            </button>
                            <button type="button" className="link-btn" aria-label={`Move ${r.name} down`} disabled={i === order.length - 1} onClick={() => setOrder((o) => moveId(o, id, 1))}>
                              ▼
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
                <span className="field-hint">Unchecked requests are skipped; the list order is the run order. pm.execution.setNextRequest can still jump between the selected requests.</span>
              </div>
            )}
          </div>

          <Field label="Environment">
            <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
              <option value="">No environment</option>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.isProduction ? '⚠ ' : ''}
                  {env.name}
                  {env.isActive ? ' (active)' : ''}
                </option>
              ))}
            </select>
          </Field>
          {activeEnv?.isProduction && <div className="banner banner-error">This run will send real requests to a PRODUCTION environment. You will be asked to confirm.</div>}

          <div className="env-details-grid" style={{ marginTop: 12 }}>
            <Field label="Iterations" hint={iterN === null ? 'Enter a whole number from 1 to 100,000.' : undefined}>
              <input value={iterations} inputMode="numeric" onChange={(e) => setIterations(e.target.value)} aria-invalid={iterN === null} />
            </Field>
            <Field label="Delay between requests (ms)" hint={delayN === null ? 'Enter a whole number from 0 to 600,000.' : undefined}>
              <input value={delayMs} inputMode="numeric" onChange={(e) => setDelayMs(e.target.value)} aria-invalid={delayN === null} />
            </Field>
          </div>
          <Checkbox checked={stopOnFailure} onChange={setStopOnFailure} label="Stop the run when a request or test fails" />
          <Checkbox checked={keepResponses} onChange={setKeepResponses} label="Keep responses with the results (redacted: first 64 KiB of the body, no Authorization/Cookie headers)" />

          <div className="field" style={{ marginTop: 14 }}>
            <label className="field-label" htmlFor="runner-data">
              Data file (CSV or JSON, optional)
            </label>
            <input id="runner-data" type="file" accept=".csv,.json,text/csv,application/json" onChange={(e) => void onFile(e.target.files?.[0])} />
            <span className="field-hint">Each row is one iteration; its columns are available to scripts through pm.iterationData. Iterations are capped by the number of rows.</span>
          </div>
          {dataError && <ErrorBanner message={dataError} />}
          {data && (
            <div className="data-preview">
              <div className="set-row">
                <strong>{data.name}</strong>
                <span className="field-hint">
                  {data.preview.rowCount.toLocaleString('en-US')} rows, {data.preview.headers.length} columns ({data.preview.format.toUpperCase()})
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setData(null);
                    setIterations('1');
                  }}
                >
                  Remove
                </Button>
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    {data.preview.headers.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.preview.rows.map((r, i) => (
                    <tr key={i}>
                      {data.preview.headers.map((h, j) => (
                        <td key={h} className="mono">
                          {r[j] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.preview.rowCount > data.preview.rows.length && <div className="field-hint">Showing the first {data.preview.rows.length} rows.</div>}
            </div>
          )}
          {effective !== null && (
            <p className="field-hint" role="status">
              {effective.toLocaleString('en-US')} iteration(s) will run{data && iterN !== null && iterN > effective ? ` (capped by ${data.preview.rowCount.toLocaleString('en-US')} data rows)` : ''}.
            </p>
          )}
          {runnerError && <ErrorBanner message={runnerError} />}
        </>
      )}
    </Modal>
  );
}
