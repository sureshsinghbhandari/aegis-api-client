import { useEffect, useRef } from 'react';
import { EmptyState, Button, useSplitter } from '../components/ui';
import { ResponseViewer } from '../response/ResponseViewer';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { RequestPane } from './RequestPane';
import { TabsBar } from './TabsBar';
import '../styles/workbench.css';
import '../styles/response.css';

function WorkbenchEmpty() {
  const newRequest = useApp((s) => s.newRequest);
  const closed = useApp((s) => s.closedTabs.length);
  const reopen = useApp((s) => s.reopenTab);
  return (
    <div className="wb-empty">
      <EmptyState
        title="No request open"
        action={
          <div className="cs-empty-actions">
            <Button variant="primary" onClick={() => newRequest(null, null)}>
              New request
            </Button>
            {closed > 0 && <Button onClick={reopen}>Reopen closed tab</Button>}
          </div>
        }
      >
        Open a request from the sidebar or create a new one.
      </EmptyState>
      <dl className="wb-shortcuts" aria-label="Keyboard shortcuts">
        {[
          ['Ctrl+Enter', 'Send request'],
          ['Ctrl+S', 'Save request'],
          ['Ctrl+W', 'Close tab'],
          ['Ctrl+T', 'New request'],
          ['Ctrl+Shift+T', 'Reopen closed tab'],
          ['Ctrl+K', 'Search'],
        ].map(([keys, label]) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function RequestWorkbench() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const active = tabs.find((t) => t.tabId === activeTabId) ?? null;
  const split = useSplitter(340, 140, 1200, 'y');

  // Sending in a production environment may be refused until the user confirms (also when triggered by Ctrl+Enter).
  const handled = useRef<string | null>(null);
  const status = active?.response.status;
  const executionId = active?.response.executionId;
  const code = active?.response.error?.code ?? active?.response.result?.error?.code;
  const tabId = active?.tabId;
  useEffect(() => {
    if (!tabId || status !== 'error' || code !== 'CONFIRMATION_REQUIRED' || !executionId || handled.current === executionId) return;
    handled.current = executionId;
    const env = useApp.getState().environments.find((e) => e.isActive);
    void useUi
      .getState()
      .confirm({
        title: 'Production environment',
        message: `The active environment${env ? ` "${env.name}"` : ''} is marked as PRODUCTION. Send this request anyway?`,
        confirmLabel: 'Send anyway',
        danger: true,
      })
      .then((yes) => {
        if (yes) void useApp.getState().sendTab(tabId, { confirmProduction: true });
      });
  }, [tabId, status, code, executionId]);

  return (
    <div className="wb-root">
      <TabsBar />
      {active ? (
        <div className="wb-split" key={active.tabId}>
          <div className="wb-top" style={{ height: split.size }}>
            <RequestPane tab={active} />
          </div>
          {split.handle}
          <div className="wb-bottom">
            <ResponseViewer tab={active} />
          </div>
        </div>
      ) : (
        <WorkbenchEmpty />
      )}
    </div>
  );
}
