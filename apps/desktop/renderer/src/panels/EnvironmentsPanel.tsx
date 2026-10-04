import { api, errorMessage } from '../lib/api';
import { Badge, Button, EmptyState, IconButton } from '../components/ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import '../styles/panels.css';

export default function EnvironmentsPanel() {
  const environments = useApp((s) => s.environments);
  const workspaceId = useApp((s) => s.workspaceId);
  const setActive = useApp((s) => s.setActiveEnvironment);
  const refresh = useApp((s) => s.refreshEnvironments);
  const toast = useApp((s) => s.toast);
  const openModal = useUi((s) => s.openModal);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const create = async () => {
    if (!workspaceId) return;
    const name = await useUi.getState().prompt({ title: 'New environment', label: 'Environment name', confirmLabel: 'Create' });
    if (!name) return;
    await run(async () => {
      const env = await api.environments.create({ workspaceId, name });
      await refresh();
      openModal('environments', { environmentId: env.id });
    });
  };

  const duplicate = (id: string) =>
    run(async () => {
      await api.environments.duplicate({ id });
      await refresh();
    });

  const remove = async (id: string, name: string) => {
    const ok = await useUi.getState().confirm({
      title: 'Delete environment',
      message: `Delete the environment "${name}" and all of its variables (including stored secrets)? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await run(async () => {
      await api.environments.delete({ id });
      await refresh();
    });
  };

  const hasActive = environments.some((e) => e.isActive);

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <Button size="sm" variant="primary" onClick={() => void create()}>
          + New environment
        </Button>
        <Button size="sm" onClick={() => openModal('environments', { globals: true })}>
          Globals…
        </Button>
      </div>
      <div className="panel-scroll">
        <ul className="env-list" aria-label="Environments">
          <li className="env-item">
            <label className="env-radio">
              <input type="radio" name="active-env" checked={!hasActive} onChange={() => void run(() => setActive(null))} />
              <span className="env-name env-none">No environment</span>
            </label>
          </li>
          {environments.map((env) => (
            <li key={env.id} className={`env-item ${env.isActive ? 'active' : ''}`} onDoubleClick={() => openModal('environments', { environmentId: env.id })}>
              <label className="env-radio">
                <input type="radio" name="active-env" checked={env.isActive} onChange={() => void run(() => setActive(env.id))} aria-label={`Set ${env.name} as active environment`} />
                <span className="env-name" title={env.description || env.name}>
                  {env.name}
                </span>
              </label>
              {env.isProduction && <Badge tone="danger" title="Production environment: sending requests may require confirmation">PRODUCTION</Badge>}
              <span className="env-actions">
                <IconButton label={`Edit ${env.name}`} onClick={() => openModal('environments', { environmentId: env.id })}>
                  ✎
                </IconButton>
                <IconButton label={`Duplicate ${env.name}`} onClick={() => void duplicate(env.id)}>
                  ⧉
                </IconButton>
                <IconButton label={`Delete ${env.name}`} onClick={() => void remove(env.id, env.name)}>
                  🗑
                </IconButton>
              </span>
            </li>
          ))}
        </ul>
        {environments.length === 0 && (
          <EmptyState title="No environments yet" action={<Button onClick={() => void create()}>Create environment</Button>}>
            Environments hold variables such as base URLs and tokens that you can switch between.
          </EmptyState>
        )}
      </div>
    </div>
  );
}
