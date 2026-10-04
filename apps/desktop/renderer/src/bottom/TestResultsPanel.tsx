import type { ExecutionResult, TestResult } from '@aegis/core';
import { useState, useSyncExternalStore } from 'react';
import { EmptyState } from '../components/ui';
import { summarizeTests, TestResultsList, TestSummary } from '../response/TestResultsList';
import { useApp } from '../store/app';
import '../styles/workbench.css';
import '../styles/response.css';

interface HistoryEntry {
  key: string;
  name: string;
  at: number;
  tests: TestResult[];
}

const MAX_HISTORY = 12;

/* Executions that ran tests are recorded for as long as the app is open, whether or not this panel is mounted. */
let history: HistoryEntry[] = [];
const listeners = new Set<() => void>();
const seen = new WeakSet<ExecutionResult>();

useApp.subscribe((state) => {
  let added = false;
  for (const tab of state.tabs) {
    const result = tab.response.result;
    if (!result || seen.has(result)) continue;
    seen.add(result);
    if (result.tests.length === 0) continue;
    history = [{ key: result.executionId, name: tab.draft.name, at: Date.now(), tests: result.tests }, ...history].slice(0, MAX_HISTORY);
    added = true;
  }
  if (added) listeners.forEach((l) => l());
});

const subscribeHistory = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const getHistory = () => history;

/** Test results of the active tab's last execution plus a short history of earlier executions' totals. */
export function TestResultsPanel() {
  const tab = useApp((s) => s.tabs.find((t) => t.tabId === s.activeTabId));
  const entries = useSyncExternalStore(subscribeHistory, getHistory);
  const [selected, setSelected] = useState<string | null>(null);

  if (!tab) return <EmptyState title="No request open">Open a request and send it to see its test results.</EmptyState>;
  if (tab.response.status === 'idle') return <EmptyState title="Nothing sent yet">Send the request to run its tests.</EmptyState>;
  if (tab.response.status === 'sending') return <EmptyState title="Sending…">Test results appear when the response arrives.</EmptyState>;

  const shown = entries.find((h) => h.key === selected);
  const tests = shown ? shown.tests : (tab.response.result?.tests ?? []);

  return (
    <div className="bp-root">
      <div className="bp-toolbar">
        <strong>{shown ? `${shown.name || 'Request'} · ${new Date(shown.at).toLocaleTimeString()}` : tab.draft.name || 'Request'}</strong>
        <TestSummary tests={tests} />
        {shown && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(null)}>
            Back to latest
          </button>
        )}
      </div>
      {entries.length > 0 && (
        <div className="th-history" aria-label="Recent executions">
          <span className="wb-dim">History</span>
          {entries.map((h) => {
            const s = summarizeTests(h.tests);
            return (
              <button
                key={h.key}
                type="button"
                className={`th-chip ${s.failed > 0 ? 'fail' : 'pass'} ${h.key === selected ? 'active' : ''}`}
                aria-pressed={h.key === selected}
                onClick={() => setSelected(h.key)}
                title={`${h.name} at ${new Date(h.at).toLocaleTimeString()}`}
              >
                {h.name || 'Request'}: {s.passed}/{s.total - s.skipped}
              </button>
            );
          })}
        </div>
      )}
      <div className="bp-scroll">
        <TestResultsList tests={tests} showSummary={false} />
      </div>
    </div>
  );
}
