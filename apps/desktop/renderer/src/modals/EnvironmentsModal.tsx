import { useCallback, useEffect, useState } from 'react';
import type { Environment } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { Badge, Button, Checkbox, EmptyState, ErrorBanner, Field, Modal } from '../components/ui';
import { VariablesEditor } from '../components/VariablesEditor';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/panels.css';

type Selection = { kind: 'env'; id: string } | { kind: 'globals' };

export default function EnvironmentsModal({ props }: ModalComponentProps) {
  const environments = useApp((s) => s.environments);
  const workspaceId = useApp((s) => s.workspaceId);
  const info = useApp((s) => s.info);
  const refresh = useApp((s) => s.refreshEnvironments);
  const toast = useApp((s) => s.toast);
  const close = useCallback(() => useUi.getState().closeModal(), []);

  const initial = (): Selection => {
    if (props?.globals === true) return { kind: 'globals' };
    const wanted = typeof props?.environmentId === 'string' ? props.environmentId : null;
    const env = environments.find((e) => e.id === wanted) ?? environments.find((e) => e.isActive) ?? environments[0];
    return env ? { kind: 'env', id: env.id } : { kind: 'globals' };
  };
  const [selection, setSelection] = useState<Selection>(initial);
  const [varsDirty, setVarsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected: Environment | null = selection.kind === 'env' ? (environments.find((e) => e.id === selection.id) ?? null) : null;

  // If the selected environment disappeared (deleted), fall back.
  useEffect(() => {
    if (selection.kind === 'env' && !environments.some((e) => e.id === selection.id)) {
      const first = environments[0];
      setSelection(first ? { kind: 'env', id: first.id } : { kind: 'globals' });
    }
  }, [environments, selection]);

  const guardSwitch = async (): Promise<boolean> => {
    if (!varsDirty) return true;
    return useUi.getState().confirm({ title: 'Discard unsaved variables?', message: 'The variables of the current selection have unsaved changes that will be lost.', confirmLabel: 'Discard', danger: true });
  };
  const select = async (next: Selection) => {
    if (next.kind === selection.kind && (next.kind === 'globals' || (selection.kind === 'env' && selection.id === next.id))) return;
    if (!(await guardSwitch())) return;
    setVarsDirty(false);
    setSelection(next);
  };

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const create = () =>
    run(async () => {
      if (!workspaceId) return;
      const name = await useUi.getState().prompt({ title: 'New environment', label: 'Environment name', confirmLabel: 'Create' });
      if (!name || !(await guardSwitch())) return;
      const env = await api.environments.create({ workspaceId, name });
      await refresh();
      setVarsDirty(false);
      setSelection({ kind: 'env', id: env.id });
    });

  const duplicate = () =>
    run(async () => {
      if (!selected || !(await guardSwitch())) return;
      const copy = await api.environments.duplicate({ id: selected.id });
      await refresh();
      setVarsDirty(false);
      setSelection({ kind: 'env', id: copy.id });
      toast(`Duplicated as "${copy.name}"`, 'success');
    });

  const remove = () =>
    run(async () => {
      if (!selected) return;
      const ok = await useUi.getState().confirm({
        title: 'Delete environment',
        message: `Delete the environment "${selected.name}" and all of its variables, including stored secrets? This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      setVarsDirty(false);
      await api.environments.delete({ id: selected.id });
      await refresh();
    });

  const setActive = (id: string | null) => run(() => useApp.getState().setActiveEnvironment(id));

  const policy = info?.policy;

  return (
    <Modal
      title="Environments"
      width={1000}
      onClose={() => {
        void guardSwitch().then((ok) => {
          if (ok) close();
        });
      }}
    >
      {error && <ErrorBanner message={error} />}
      <div className="env-modal">
        <nav className="env-modal-list" aria-label="Environments">
          <button type="button" className={`env-modal-item ${selection.kind === 'globals' ? 'active' : ''}`} onClick={() => void select({ kind: 'globals' })}>
            <span className="env-name">🌐 Globals</span>
          </button>
          <div className="env-modal-sep">Environments</div>
          {environments.map((env) => (
            <button key={env.id} type="button" className={`env-modal-item ${selection.kind === 'env' && selection.id === env.id ? 'active' : ''}`} onClick={() => void select({ kind: 'env', id: env.id })}>
              <span className="env-name">{env.name}</span>
              {env.isProduction && <Badge tone="danger">PROD</Badge>}
              {env.isActive && <Badge tone="success">active</Badge>}
            </button>
          ))}
          {environments.length === 0 && <div className="field-hint" style={{ padding: 8 }}>No environments yet.</div>}
          <div className="env-modal-actions">
            <Button size="sm" variant="primary" onClick={() => void create()}>
              + New
            </Button>
            <Button size="sm" onClick={() => useUi.getState().openModal('import', { kind: 'postman-environment' })}>
              Import…
            </Button>
          </div>
        </nav>

        <section className="env-modal-detail">
          {selection.kind === 'globals' ? (
            workspaceId ? (
              <>
                <h3>Global variables</h3>
                <p className="field-hint">Globals are available in every request of this workspace. Environment, folder and collection variables override them.</p>
                <VariablesEditor key="globals" owner={{ scope: 'global', ownerId: workspaceId }} onDirtyChange={setVarsDirty} />
              </>
            ) : (
              <EmptyState title="No workspace selected" />
            )
          ) : selected ? (
            <>
              <div className="env-detail-actions">
                <Button size="sm" variant={selected.isActive ? 'default' : 'primary'} onClick={() => void setActive(selected.isActive ? null : selected.id)}>
                  {selected.isActive ? 'Deactivate' : 'Set active'}
                </Button>
                <Button size="sm" onClick={() => void duplicate()}>
                  Duplicate
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    void guardSwitch().then((ok) => ok && useUi.getState().openModal('export', { environmentId: selected.id }));
                  }}
                >
                  Export…
                </Button>
                <span className="panel-spacer" />
                <Button size="sm" variant="danger" onClick={() => void remove()}>
                  Delete
                </Button>
              </div>
              <EnvironmentDetails key={selected.id} env={selected} onError={setError} requireConfirm={policy?.requireProductionConfirmation ?? true} blocked={policy?.blockProductionRequests ?? false} />
              <h3>Variables</h3>
              <VariablesEditor key={selected.id} owner={{ scope: 'environment', ownerId: selected.id }} onDirtyChange={setVarsDirty} />
            </>
          ) : (
            <EmptyState title="Select an environment" />
          )}
        </section>
      </div>
    </Modal>
  );
}

function EnvironmentDetails({ env, onError, requireConfirm, blocked }: { env: Environment; onError(msg: string | null): void; requireConfirm: boolean; blocked: boolean }) {
  const [name, setName] = useState(env.name);
  const [description, setDescription] = useState(env.description);
  const [isProduction, setIsProduction] = useState(env.isProduction);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== env.name || description !== env.description || isProduction !== env.isProduction;

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    onError(null);
    try {
      await api.environments.update({ id: env.id, name: name.trim(), description, isProduction });
      await useApp.getState().refreshEnvironments();
      useApp.getState().toast('Environment saved', 'success');
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="env-details">
      <div className="env-details-grid">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
        </Field>
      </div>
      <Checkbox checked={isProduction} onChange={setIsProduction} label="This is a production environment" />
      <p className="field-hint">
        {blocked
          ? 'Your organization policy blocks sending requests while a production environment is active.'
          : requireConfirm
            ? 'Policy requires a confirmation before a request is sent while this environment is active. The top bar highlights production in red.'
            : 'Production environments are highlighted in red. Your policy does not currently require a confirmation before sending.'}
      </p>
      <div className="env-details-save">
        <Button size="sm" variant="primary" disabled={!dirty || !name.trim() || saving} onClick={() => void save()}>
          Save details
        </Button>
        {dirty && (
          <Button
            size="sm"
            onClick={() => {
              setName(env.name);
              setDescription(env.description);
              setIsProduction(env.isProduction);
            }}
          >
            Revert
          </Button>
        )}
      </div>
    </div>
  );
}
