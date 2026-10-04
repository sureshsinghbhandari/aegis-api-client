import { useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import { Button, IconButton } from '../components/ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import '../styles/panels.css';

export function TopBar() {
  const workspaces = useApp((s) => s.workspaces);
  const workspaceId = useApp((s) => s.workspaceId);
  const environments = useApp((s) => s.environments);
  const theme = useApp((s) => s.theme);
  const selectWorkspace = useApp((s) => s.selectWorkspace);
  const setActiveEnvironment = useApp((s) => s.setActiveEnvironment);
  const toast = useApp((s) => s.toast);
  const openModal = useUi((s) => s.openModal);
  const active = environments.find((e) => e.isActive) ?? null;

  const toggleTheme = useCallback(async () => {
    const next = useApp.getState().theme === 'dark' ? 'light' : 'dark';
    try {
      const settings = await api.settings.update({ patch: { appearance: { theme: next } } });
      useApp.getState().applySettings(settings);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }, [toast]);

  const onWorkspace = (id: string) => {
    selectWorkspace(id).catch((e) => toast(errorMessage(e), 'error'));
  };
  const onEnvironment = (id: string) => {
    setActiveEnvironment(id === '' ? null : id).catch((e) => toast(errorMessage(e), 'error'));
  };

  return (
    <header className="topbar" role="banner">
      <div className="topbar-brand" aria-label="Aegis API Client">
        <span className="topbar-logo" aria-hidden="true">
          ◆
        </span>
        Aegis API Client
      </div>

      <div className="topbar-group">
        <label className="topbar-label" htmlFor="topbar-workspace">
          Workspace
        </label>
        <select id="topbar-workspace" className="topbar-select" value={workspaceId ?? ''} onChange={(e) => onWorkspace(e.target.value)}>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => openModal('workspaces')}>
          Manage…
        </Button>
      </div>

      <div className="topbar-group">
        <label className="topbar-label" htmlFor="topbar-env">
          Environment
        </label>
        <select
          id="topbar-env"
          className={`topbar-select ${active?.isProduction ? 'topbar-select-prod' : ''}`}
          value={active?.id ?? ''}
          onChange={(e) => onEnvironment(e.target.value)}
          aria-describedby={active?.isProduction ? 'topbar-env-prod' : undefined}
        >
          <option value="">No environment</option>
          {environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.isProduction ? '⚠ ' : ''}
              {env.name}
              {env.isProduction ? ' (production)' : ''}
            </option>
          ))}
        </select>
        {active?.isProduction && (
          <span id="topbar-env-prod" className="topbar-prod">
            PRODUCTION
          </span>
        )}
        <IconButton label="View or edit environments" onClick={() => openModal('environments', active ? { environmentId: active.id } : {})}>
          👁
        </IconButton>
      </div>

      <div className="topbar-spacer" />

      <Button size="sm" onClick={() => openModal('search')} title="Search (Ctrl+K)">
        🔍 Search <kbd className="kbd">Ctrl+K</kbd>
      </Button>
      <Button size="sm" onClick={() => openModal('import')}>
        Import
      </Button>
      <IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => void toggleTheme()}>
        {theme === 'dark' ? '☀' : '🌙'}
      </IconButton>
      <IconButton label="Settings" onClick={() => openModal('settings')}>
        ⚙
      </IconButton>
    </header>
  );
}
