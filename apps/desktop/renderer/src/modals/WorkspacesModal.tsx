import { useState } from 'react';
import type { Workspace } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { relativeTime } from '../lib/ui-format';
import { Badge, Button, EmptyState, ErrorBanner, Modal } from '../components/ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/panels.css';

export default function WorkspacesModal(_p: ModalComponentProps) {
  const workspaces = useApp((s) => s.workspaces);
  const currentId = useApp((s) => s.workspaceId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const create = () =>
    run('create', async () => {
      const name = await useUi.getState().prompt({ title: 'New workspace', label: 'Workspace name', confirmLabel: 'Create' });
      if (!name) return;
      const ws = await api.workspaces.create({ name });
      await useApp.getState().refreshWorkspaces();
      await useApp.getState().selectWorkspace(ws.id);
    });

  const rename = (ws: Workspace) =>
    run(ws.id, async () => {
      const name = await useUi.getState().prompt({ title: 'Rename workspace', label: 'Workspace name', initial: ws.name, confirmLabel: 'Rename' });
      if (!name || name === ws.name) return;
      await api.workspaces.update({ id: ws.id, name });
      await useApp.getState().refreshWorkspaces();
    });

  const remove = (ws: Workspace) =>
    run(ws.id, async () => {
      if (workspaces.length <= 1) {
        setError('You cannot delete the last workspace.');
        return;
      }
      const ok = await useUi.getState().confirm({
        title: 'Delete workspace',
        message: `Delete the workspace "${ws.name}" with ALL of its collections, requests, environments, variables, secrets and history? This cannot be undone. Consider creating a backup first.`,
        confirmLabel: 'Delete workspace',
        danger: true,
      });
      if (!ok) return;
      await api.workspaces.delete({ id: ws.id });
      await useApp.getState().refreshWorkspaces();
      if (ws.id === currentId) {
        const next = useApp.getState().workspaces[0];
        if (next) await useApp.getState().selectWorkspace(next.id);
      }
    });

  const exportWs = (ws: Workspace) =>
    run(ws.id, async () => {
      const path = await api.workspaces.export({ id: ws.id, includeSecrets: false });
      if (path) useApp.getState().toast(`Workspace exported to ${path}`, 'success');
    });

  const switchTo = (ws: Workspace) => run(ws.id, () => useApp.getState().selectWorkspace(ws.id));

  return (
    <Modal
      title="Workspaces"
      width={640}
      onClose={() => useUi.getState().closeModal()}
      footer={
        <>
          <Button onClick={() => useUi.getState().closeModal()}>Close</Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => void create()}>
            + New workspace
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}
      {workspaces.length === 0 ? (
        <EmptyState title="No workspaces" />
      ) : (
        <ul className="ws-list" aria-label="Workspaces">
          {workspaces.map((ws) => (
            <li key={ws.id} className={`ws-item ${ws.id === currentId ? 'active' : ''}`}>
              <div className="ws-main">
                <div className="ws-name">
                  {ws.name} {ws.id === currentId && <Badge tone="success">current</Badge>}
                </div>
                <div className="field-hint">
                  {ws.description ? `${ws.description} · ` : ''}updated {relativeTime(ws.updatedAt)}
                </div>
              </div>
              <div className="ws-actions">
                {ws.id !== currentId && (
                  <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void switchTo(ws)}>
                    Switch
                  </Button>
                )}
                <Button size="sm" disabled={busy !== null} onClick={() => void rename(ws)}>
                  Rename
                </Button>
                <Button size="sm" disabled={busy !== null} onClick={() => void exportWs(ws)} title="Export without secrets">
                  Export
                </Button>
                <Button size="sm" variant="danger" disabled={busy !== null || workspaces.length <= 1} title={workspaces.length <= 1 ? 'The last workspace cannot be deleted' : undefined} onClick={() => void remove(ws)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="field-hint">Workspaces keep collections, environments, globals, cookies and history separate. Exports from here never include secrets.</p>
    </Modal>
  );
}
