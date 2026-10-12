import type { AuthConfig, ScriptEntry } from '@aegis/core';
import { useCallback, useEffect, useState } from 'react';
import { AuthEditor } from '../components/AuthEditor';
import { MarkdownEditor } from '../components/MarkdownPreview';
import { Button, ErrorBanner, Modal, Spinner, Tabs } from '../components/ui';
import { VariablesEditor } from '../components/VariablesEditor';
import { api, errorMessage } from '../lib/api';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { ScriptPanel } from '../workspace/ScriptPanel';
import type { ModalComponentProps } from './ModalHost';
import '../styles/workbench.css';

type Kind = 'collection' | 'folder';
type Section = 'overview' | 'auth' | 'prerequest' | 'tests' | 'variables';

interface Loaded {
  name: string;
  description: string;
  auth: AuthConfig;
  scripts: ScriptEntry[];
  collectionId: string;
}

const sig = (l: Pick<Loaded, 'name' | 'description' | 'auth' | 'scripts'>): string => JSON.stringify([l.name, l.description, l.auth, l.scripts]);

export default function CollectionEditModal({ props }: ModalComponentProps) {
  const kind: Kind = props?.kind === 'folder' ? 'folder' : 'collection';
  const id = typeof props?.id === 'string' ? props.id : '';
  const workspaceId = useApp((s) => s.workspaceId);
  const [data, setData] = useState<Loaded | null>(null);
  const [original, setOriginal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<Section>('overview');
  const [varsDirty, setVarsDirty] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const loaded: Loaded =
        kind === 'collection'
          ? await api.collections.get({ id }).then((c) => ({ name: c.name, description: c.description, auth: c.auth, scripts: c.scripts, collectionId: c.id }))
          : await api.folders.get({ id }).then((f) => ({ name: f.name, description: f.description, auth: f.auth, scripts: f.scripts, collectionId: f.collectionId }));
      setData(loaded);
      setOriginal(sig(loaded));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [kind, id]);

  useEffect(() => {
    if (id) void load();
    else setError('No collection or folder was specified.');
  }, [id, load]);

  const dirty = data !== null && (sig(data) !== original || varsDirty);
  const close = useCallback(async () => {
    if (dirty) {
      const ok = await useUi.getState().confirm({ title: 'Discard changes?', message: 'You have unsaved changes. Close without saving?', confirmLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    useUi.getState().closeModal();
  }, [dirty]);

  const patch = (p: Partial<Loaded>) => setData((d) => (d ? { ...d, ...p } : d));

  const save = async () => {
    if (!data) return;
    const name = data.name.trim();
    if (!name) {
      setSaveError('The name must not be empty.');
      setSection('overview');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const input = { id, name, description: data.description, auth: data.auth, scripts: data.scripts };
      // The saved entity comes back with credentials replaced by secure references.
      const saved: Loaded =
        kind === 'collection'
          ? await api.collections.update(input).then((c) => ({ ...data, name: c.name, description: c.description, auth: c.auth, scripts: c.scripts }))
          : await api.folders.update(input).then((f) => ({ ...data, name: f.name, description: f.description, auth: f.auth, scripts: f.scripts }));
      setData(saved);
      setOriginal(sig(saved));
      const st = useApp.getState();
      st.toast(`${kind === 'collection' ? 'Collection' : 'Folder'} saved`, 'success');
      await st.refreshCollections();
      await st.refreshTree(saved.collectionId);
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const title = `Edit ${kind}${data ? `: ${data.name}` : ''}`;
  return (
    <Modal
      title={title}
      width={900}
      onClose={() => void close()}
      footer={
        <>
          <Button onClick={() => void close()}>Close</Button>
          <Button variant="primary" onClick={() => void save()} disabled={!data || saving || sig(data) === original}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="ce-body">
        {error && <ErrorBanner message={error} onRetry={() => void load()} />}
        {!data && !error && (
          <div className="center-fill">
            <Spinner label="Loading" />
          </div>
        )}
        {data && (
          <>
            <Tabs<Section>
              value={section}
              onChange={setSection}
              tabs={[
                { id: 'overview' as const, label: 'Overview' },
                { id: 'auth' as const, label: 'Authorization', badge: data.auth.type !== 'none' && data.auth.type !== 'inherit' ? '●' : undefined },
                { id: 'prerequest' as const, label: 'Pre-request Script' },
                { id: 'tests' as const, label: 'Post-response' },
                { id: 'variables' as const, label: 'Variables', badge: varsDirty ? '●' : undefined },
              ]}
            />
            {saveError && <ErrorBanner message={saveError} />}
            <div className="ce-tab">
              {section === 'overview' && (
                <>
                  <label className="field">
                    <span className="field-label">Name</span>
                    <input value={data.name} onChange={(e) => patch({ name: e.target.value })} autoFocus />
                  </label>
                  <div className="field">
                    <span className="field-label">Description (Markdown, previewed on the right)</span>
                    <div className="ce-docs">
                      <MarkdownEditor label={`${kind === 'collection' ? 'Collection' : 'Folder'} description`} value={data.description} onChange={(description) => patch({ description })} placeholder={`Describe this ${kind}: purpose, conventions, links…`} />
                    </div>
                  </div>
                </>
              )}
              {section === 'auth' && (
                <>
                  <p className="wb-hint">{kind === 'folder' ? 'Requests in this folder inherit this authorization unless they define their own.' : 'Requests in this collection inherit this authorization unless a folder or the request defines its own.'}</p>
                  <AuthEditor
                    value={data.auth}
                    onChange={(auth) => patch({ auth })}
                    allowInherit={kind === 'folder'}
                    {...(kind === 'folder' ? { inheritedFrom: 'the parent folder or collection' } : {})}
                    {...(workspaceId ? { oauthContext: { workspaceId, collectionId: data.collectionId, ...(kind === 'folder' ? { folderId: id } : {}) } } : {})}
                  />
                </>
              )}
              {section === 'prerequest' && (
                <div className="ce-script">
                  <ScriptPanel phase="prerequest" scripts={data.scripts} onChange={(scripts) => patch({ scripts })} context={{ collectionId: data.collectionId, folderId: kind === 'folder' ? id : null }} />
                </div>
              )}
              {section === 'tests' && (
                <div className="ce-script">
                  <ScriptPanel phase="test" scripts={data.scripts} onChange={(scripts) => patch({ scripts })} context={{ collectionId: data.collectionId, folderId: kind === 'folder' ? id : null }} />
                </div>
              )}
              {/* Kept mounted (hidden) so unsaved variable edits survive switching tabs. */}
              <div hidden={section !== 'variables'}>
                <VariablesEditor owner={{ scope: kind, ownerId: id }} onDirtyChange={setVarsDirty} />
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
