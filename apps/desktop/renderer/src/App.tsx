import { lazy, Suspense, useEffect } from 'react';
import { DialogHost, ToastHost } from './components/DialogHost';
import { Spinner, Tabs, useSplitter } from './components/ui';
import { errorMessage } from './lib/api';
import { useGlobalShortcuts } from './lib/shortcuts';
import { ModalHost } from './modals/ModalHost';
import { useApp } from './store/app';
import { useMenuActions } from './lib/menu-actions';
import { TopBar } from './topbar/TopBar';
import { CollectionsTree } from './sidebar/CollectionsTree';
import { RequestWorkbench } from './workspace/RequestWorkbench';
import { ConsolePanel } from './bottom/ConsolePanel';
import { TestResultsPanel } from './bottom/TestResultsPanel';

const HistoryPanel = lazy(() => import('./panels/HistoryPanel'));
const EnvironmentsPanel = lazy(() => import('./panels/EnvironmentsPanel'));
const RunnerPanel = lazy(() => import('./panels/RunnerPanel'));

export function App() {
  const ready = useApp((s) => s.ready);
  const init = useApp((s) => s.init);
  const toast = useApp((s) => s.toast);
  useEffect(() => {
    init().catch((e) => toast(errorMessage(e), 'error'));
  }, [init, toast]);
  useGlobalShortcuts();
  useMenuActions();

  if (!ready) {
    return (
      <div className="splash">
        <Spinner /> Starting Aegis API Client…
      </div>
    );
  }
  return <Shell />;
}

function Shell() {
  const sidebarView = useApp((s) => s.sidebarView);
  const setSidebarView = useApp((s) => s.setSidebarView);
  const bottomOpen = useApp((s) => s.bottomOpen);
  const bottomPanel = useApp((s) => s.bottomPanel);
  const toggleBottom = useApp((s) => s.toggleBottom);
  const environments = useApp((s) => s.environments);
  const info = useApp((s) => s.info);
  const consoleCount = useApp((s) => s.consoleLines.length);
  const side = useSplitter(300, 200, 560, 'x');
  const bottom = useSplitter(260, 120, 640, 'y', true);
  const active = environments.find((e) => e.isActive);

  return (
    <div className="app">
      <TopBar />
      {active?.isProduction && <div className="prod-banner">ENVIRONMENT: PRODUCTION — {active.name}</div>}
      <div className="main">
        <aside className="sidebar" style={{ width: side.size }} aria-label="Sidebar">
          <div className="segmented" role="tablist">
            {(['collections', 'history', 'environments'] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={sidebarView === v} className={sidebarView === v ? 'active' : ''} onClick={() => setSidebarView(v)}>
                {v[0]!.toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <Suspense fallback={<Spinner />}>
              {sidebarView === 'collections' && <CollectionsTree />}
              {sidebarView === 'history' && <HistoryPanel />}
              {sidebarView === 'environments' && <EnvironmentsPanel />}
            </Suspense>
          </div>
        </aside>
        {side.handle}
        <section className="center">
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <RequestWorkbench />
          </div>
          {bottomOpen && bottom.handle}
          {bottomOpen && (
            <div className="bottom" style={{ height: bottom.size }}>
              <Tabs
                value={bottomPanel}
                onChange={(p) => toggleBottom(p)}
                tabs={[
                  { id: 'console', label: 'Console', badge: consoleCount || undefined },
                  { id: 'runner', label: 'Runner' },
                  { id: 'tests', label: 'Test Results' },
                ]}
              />
              <div className="bottom-body">
                <Suspense fallback={<Spinner />}>
                  {bottomPanel === 'console' && <ConsolePanel />}
                  {bottomPanel === 'runner' && <RunnerPanel />}
                  {bottomPanel === 'tests' && <TestResultsPanel />}
                </Suspense>
              </div>
            </div>
          )}
        </section>
      </div>
      <footer className="statusbar">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleBottom('console')}>
          Console
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleBottom('runner')}>
          Runner
        </button>
        <span style={{ flex: 1 }} />
        <span title="No telemetry, analytics, sync or crash reporting. Only requests you send leave this machine.">{info?.localOnly ? '● Local-only mode' : '○ Local-only mode off'}</span>
        <span title={info?.secretStorage}>{info?.secretStorageAvailable ? '🔒 Secrets protected by the OS' : '⚠ Secure storage unavailable'}</span>
        <span>v{info?.version}</span>
      </footer>
      <ModalHost />
      <DialogHost />
      <ToastHost />
    </div>
  );
}
