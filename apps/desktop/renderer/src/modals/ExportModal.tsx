import { useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Button, EmptyState, ErrorBanner, Field, Modal } from '../components/ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/panels.css';

type Mode = 'collection' | 'environment' | 'workspace';

export default function ExportModal({ props }: ModalComponentProps) {
  const collections = useApp((s) => s.collections);
  const environments = useApp((s) => s.environments);
  const workspaces = useApp((s) => s.workspaces);
  const workspaceId = useApp((s) => s.workspaceId);
  const info = useApp((s) => s.info);
  const secretExportAllowed = info?.policy.allowSecretExport ?? false;

  const [mode, setMode] = useState<Mode>(typeof props?.environmentId === 'string' ? 'environment' : 'collection');
  const [collectionId, setCollectionId] = useState<string>(typeof props?.collectionId === 'string' ? props.collectionId : (collections[0]?.id ?? ''));
  const [environmentId, setEnvironmentId] = useState<string>(typeof props?.environmentId === 'string' ? props.environmentId : (environments.find((e) => e.isActive)?.id ?? environments[0]?.id ?? ''));
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name ?? 'current workspace';
  const targetMissing = (mode === 'collection' && !collectionId) || (mode === 'environment' && !environmentId) || (mode === 'workspace' && !workspaceId);

  const toggleSecrets = async (on: boolean) => {
    if (!on) {
      setIncludeSecrets(false);
      return;
    }
    const ok = await useUi.getState().confirm({
      title: 'Include secrets in export?',
      message: 'The exported file will contain secret values (tokens, passwords, API keys) in PLAIN TEXT. Anyone who can read the file can use them. Only continue if you need the secrets and will store the file safely.',
      confirmLabel: 'Include secrets',
      danger: true,
    });
    if (ok) setIncludeSecrets(true);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    setSavedPath(null);
    setCancelled(false);
    try {
      let path: string | null;
      if (mode === 'collection') path = await api.importExport.exportCollection({ collectionId, includeSecrets });
      else if (mode === 'environment') path = await api.importExport.exportEnvironment({ environmentId, includeSecrets });
      else path = await api.workspaces.export({ id: workspaceId ?? '', includeSecrets });
      if (path) setSavedPath(path);
      else setCancelled(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => useUi.getState().closeModal();

  return (
    <Modal
      title="Export"
      width={560}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Close</Button>
          <Button variant="primary" disabled={busy || targetMissing} onClick={() => void run()}>
            {busy ? 'Exporting…' : 'Export…'}
          </Button>
        </>
      }
    >
      <fieldset className="imp-kinds">
        <legend className="field-label">What do you want to export?</legend>
        <label className="imp-kind">
          <input type="radio" name="export-mode" checked={mode === 'collection'} onChange={() => setMode('collection')} />
          <span>
            <strong>Collection</strong>
            <span className="field-hint">Postman Collection v2.1 (JSON)</span>
          </span>
        </label>
        <label className="imp-kind">
          <input type="radio" name="export-mode" checked={mode === 'environment'} onChange={() => setMode('environment')} />
          <span>
            <strong>Environment</strong>
            <span className="field-hint">Postman Environment (JSON)</span>
          </span>
        </label>
        <label className="imp-kind">
          <input type="radio" name="export-mode" checked={mode === 'workspace'} onChange={() => setMode('workspace')} />
          <span>
            <strong>Workspace "{workspaceName}"</strong>
            <span className="field-hint">Aegis workspace file with all collections and environments (Aegis format, not Postman)</span>
          </span>
        </label>
      </fieldset>

      {mode === 'collection' &&
        (collections.length === 0 ? (
          <EmptyState title="No collections to export" />
        ) : (
          <Field label="Collection">
            <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        ))}
      {mode === 'environment' &&
        (environments.length === 0 ? (
          <EmptyState title="No environments to export" />
        ) : (
          <Field label="Environment">
            <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
          </Field>
        ))}

      <div className="exp-secrets">
        <label className="checkbox">
          <input type="checkbox" checked={includeSecrets} disabled={!secretExportAllowed} onChange={(e) => void toggleSecrets(e.target.checked)} />
          <span>Include secrets</span>
        </label>
        <p className="field-hint">
          {secretExportAllowed
            ? 'Off by default: secret values (tokens, passwords, keys) are blanked in the file so it can be shared safely.'
            : 'Your organization policy does not allow exporting secrets. Secret values are always blanked.'}
        </p>
      </div>

      <p className="field-hint">Postman Collection v2.1 compatible for supported fields/features. Features Aegis does not implement are preserved where possible but may not behave identically in Postman.</p>

      {error && <ErrorBanner message={error} />}
      {savedPath && (
        <div className="banner exp-ok" role="status">
          Saved to <code className="mono">{savedPath}</code>
        </div>
      )}
      {cancelled && (
        <div className="field-hint" role="status">
          Export cancelled. Nothing was written.
        </div>
      )}
    </Modal>
  );
}
