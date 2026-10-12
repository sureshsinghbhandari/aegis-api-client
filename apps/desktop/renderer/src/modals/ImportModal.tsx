import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportCommitResult, ImportPreview, ImportProgress, ImportSourceKind, ImportWarningModel } from '@aegis/core';
import { ApiError, api, errorMessage } from '../lib/api';
import { IMPORT_KINDS, IMPORT_STAGES, asImportKind, importCreatesWorkspace, previewSummaryLines, progressView, warningsFromDetails } from '../lib/import-helpers';
import { Button, ErrorBanner, Field, Modal, Spinner } from '../components/ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { WarningList } from './import/WarningList';
import type { ModalComponentProps } from './ModalHost';
import '../styles/panels.css';

type Step = 'choose' | 'preview' | 'progress' | 'done';

const MAX_FILE_BYTES = 200 * 1024 * 1024;

export default function ImportModal({ props }: ModalComponentProps) {
  const workspaceId = useApp((s) => s.workspaceId);
  const [kind, setKind] = useState<ImportSourceKind>(asImportKind(props?.kind));
  const [step, setStep] = useState<Step>('choose');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorWarnings, setErrorWarnings] = useState<ImportWarningModel[]>([]);
  const [passphrase, setPassphrase] = useState('');
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [failedAfterCommit, setFailedAfterCommit] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const pending = useRef<string | null>(null); // token of a preview that is neither committed nor discarded
  const autoPicked = useRef(false);

  const setFailure = useCallback((e: unknown) => {
    setError(errorMessage(e));
    setErrorWarnings(e instanceof ApiError ? warningsFromDetails(e.details) : []);
  }, []);

  const discard = useCallback(() => {
    const token = pending.current;
    pending.current = null;
    if (token) void api.importExport.discard({ token }).catch(() => undefined);
  }, []);

  // Never leave a parsed import lingering in the main process.
  useEffect(() => discard, [discard]);

  const acceptPreview = useCallback(
    (p: ImportPreview) => {
      discard();
      pending.current = p.token;
      setPreview(p);
      setStep('preview');
    },
    [discard],
  );

  const pick = useCallback(
    async (k: ImportSourceKind) => {
      setBusy(true);
      setError(null);
      setErrorWarnings([]);
      try {
        const p = await api.importExport.pickAndPreview({ kind: k });
        if (p) acceptPreview(p);
      } catch (e) {
        setFailure(e);
      } finally {
        setBusy(false);
      }
    },
    [acceptPreview, setFailure],
  );

  useEffect(() => {
    if (props?.autoPick === true && !autoPicked.current) {
      autoPicked.current = true;
      void pick(asImportKind(props.kind));
    }
  }, [props, pick]);

  const previewText = async (fileName: string, content: string) => {
    setBusy(true);
    setError(null);
    setErrorWarnings([]);
    try {
      acceptPreview(await api.importExport.previewContent({ kind, fileName, content }));
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(`"${file.name}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB and cannot be imported.`);
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch {
      setError(`Could not read "${file.name}".`);
      return;
    }
    await previewText(file.name, content);
  };

  const commit = async () => {
    if (!preview || !workspaceId) return;
    setBusy(true);
    setError(null);
    setErrorWarnings([]);
    setProgress(null);
    setStep('progress');
    const token = preview.token;
    const off = api.events.on('import:progress', (p) => {
      if (p.token === undefined || p.token === token) setProgress({ stage: p.stage, current: p.current, total: p.total });
    });
    try {
      const res = await api.importExport.commit({ token, workspaceId, ...(passphrase ? { passphrase } : {}) });
      pending.current = null;
      setResult(res);
      setFailedAfterCommit(false);
      setStep('done');
      const app = useApp.getState();
      await Promise.all([app.refreshCollections(), app.refreshEnvironments(), importCreatesWorkspace(res.kind) ? app.refreshWorkspaces() : Promise.resolve()]).catch(() => undefined);
    } catch (e) {
      // The main process imports atomically: on any failure the transaction is rolled back.
      setFailure(e);
      setFailedAfterCommit(true);
      setStep('preview');
    } finally {
      off();
      setBusy(false);
    }
  };

  const cancel = () => {
    discard();
    useUi.getState().closeModal();
  };

  const close = () => {
    if (step === 'progress') return; // an import in flight cannot be interrupted safely
    cancel();
  };

  const openResult = () => {
    if (!result) return;
    const app = useApp.getState();
    if (result.collectionId) {
      app.setSidebarView('collections');
      app.toggleExpanded(result.collectionId, true);
      void app.refreshTree(result.collectionId);
      useUi.getState().closeModal();
    } else if (result.environmentId) {
      useUi.getState().openModal('environments', { environmentId: result.environmentId });
    } else {
      useUi.getState().closeModal();
    }
  };

  const selected = IMPORT_KINDS.find((k) => k.id === kind) ?? IMPORT_KINDS[0]!;

  const footer =
    step === 'choose' ? (
      <>
        <Button onClick={cancel}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={() => void pick(kind)}>
          Choose file…
        </Button>
      </>
    ) : step === 'preview' ? (
      <>
        <Button onClick={cancel}>Cancel</Button>
        <Button
          onClick={() => {
            discard();
            setPreview(null);
            setError(null);
            setErrorWarnings([]);
            setStep('choose');
          }}
        >
          Back
        </Button>
        <Button variant="primary" disabled={busy || !preview} onClick={() => void commit()}>
          Import
        </Button>
      </>
    ) : step === 'done' ? (
      <>
        <Button onClick={() => useUi.getState().closeModal()}>Close</Button>
        {result && (result.collectionId || result.environmentId) && (
          <Button variant="primary" onClick={openResult}>
            {result.collectionId ? 'Open collection' : 'Open environment'}
          </Button>
        )}
      </>
    ) : null;

  return (
    <Modal title="Import" width={720} onClose={close} footer={footer}>
      {step === 'choose' && (
        <div className="imp">
          <fieldset className="imp-kinds">
            <legend className="field-label">What do you want to import?</legend>
            {IMPORT_KINDS.map((k) => (
              <label key={k.id} className="imp-kind">
                <input type="radio" name="import-kind" checked={kind === k.id} onChange={() => setKind(k.id)} />
                <span>
                  <strong>{k.label}</strong>
                  <span className="field-hint">{k.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div
            className={`dropzone ${dragOver ? 'over' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="Drop a file here, press Enter to choose a file, or paste its contents"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void onFile(e.dataTransfer.files[0]);
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (text.trim()) {
                e.preventDefault();
                void previewText(/^\s*[{[]/.test(text) ? 'pasted.json' : 'pasted.yaml', text);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void pick(kind);
              }
            }}
            onClick={() => void pick(kind)}
          >
            {busy ? (
              <>
                <Spinner /> Reading and validating…
              </>
            ) : (
              <>
                <strong>Drop a file here ({selected.extensions})</strong>
                <span>or click to choose a file, or focus this area and paste (Ctrl+V) the file text</span>
              </>
            )}
          </div>
          <p className="field-hint">Files are read locally and validated before anything is written. Nothing is uploaded; references to other files or URLs inside a document are never fetched.</p>
          {error && <ImportError message={error} warnings={errorWarnings} />}
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="imp">
          <h3>Import preview</h3>
          <div className="imp-file field-hint">
            File: {preview.fileName}
            {preview.schemaVersion ? ` · version ${preview.schemaVersion}` : ''}
          </div>
          <ul className="imp-summary" aria-label="Import summary">
            {previewSummaryLines(preview).map((line, i) => (
              <li key={i} className={i === 0 ? 'imp-summary-title' : ''}>
                {line}
              </li>
            ))}
          </ul>
          <WarningList warnings={preview.warnings} />
          {preview.kind === 'aegis-backup' && (
            <Field label="Passphrase (only for encrypted backups)" hint="Leave empty for unencrypted backups. The passphrase is never stored.">
              <input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
          )}
          {preview.kind === 'aegis-backup' && <p className="field-hint">Restoring adds the backup contents to your data; existing items are not deleted.</p>}
          {preview.kind === 'aegis-workspace' && <p className="field-hint">The workspace file is restored as a new workspace; existing workspaces are not changed.</p>}
          {preview.kind !== 'aegis-backup' && preview.kind !== 'aegis-workspace' && <p className="field-hint">Everything is imported into the current workspace in one transaction. Unsupported parts are listed above and are never silently dropped.</p>}
          {error && <ImportError message={error} warnings={errorWarnings} noChange={failedAfterCommit} />}
        </div>
      )}

      {step === 'progress' && (
        <div className="imp" aria-live="polite">
          <h3>Importing…</h3>
          <ol className="imp-stages">
            {IMPORT_STAGES.map((s) => {
              const cur = progress ? IMPORT_STAGES.indexOf(progress.stage) : -1;
              const idx = IMPORT_STAGES.indexOf(s);
              return (
                <li key={s} className={idx < cur ? 'done' : idx === cur ? 'current' : ''}>
                  {idx < cur ? '✓' : idx === cur ? '●' : '○'} {s}
                </li>
              );
            })}
          </ol>
          {progress && (
            <>
              <progress className="imp-bar" max={100} value={progressView(progress).percent} aria-label={`${progress.stage} progress`} />
              <div className="imp-counter">{progressView(progress).counter}</div>
            </>
          )}
          {!progress && (
            <div>
              <Spinner /> Starting…
            </div>
          )}
          <p className="field-hint">The import runs as a single transaction. If it fails nothing is changed.</p>
        </div>
      )}

      {step === 'done' && result && (
        <div className="imp">
          <h3>Import complete</h3>
          <ul className="imp-summary">
            <li>
              Imported: {result.stats.folders} folders, {result.stats.requests} requests, {result.stats.variables} variables, {result.stats.scripts} scripts, {result.stats.examples} examples
            </li>
          </ul>
          <WarningList warnings={result.warnings} defaultOpen={result.warnings.some((w) => w.severity !== 'INFO')} />
        </div>
      )}
    </Modal>
  );
}

function ImportError({ message, warnings, noChange }: { message: string; warnings: ImportWarningModel[]; noChange?: boolean }) {
  return (
    <div className="imp-error">
      <ErrorBanner message={message} />
      {noChange && <p>Import failed and was rolled back. No data was changed.</p>}
      {warnings.length > 0 && <WarningList warnings={warnings} defaultOpen />}
    </div>
  );
}
