import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunSummary, RunnerItemEvent } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { downloadText } from '../lib/download';
import { formatRunnerRow, groupByIteration, resultsToCsv, resultsToJson, summarizeItems } from '../lib/runner-helpers';
import { relativeTime } from '../lib/ui-format';
import { Badge, Button, EmptyState, ErrorBanner, MethodLabel, Spinner, formatMs } from '../components/ui';
import { useApp } from '../store/app';
import { ensureRunnerSubscription, useRunner } from '../store/runner';
import { useUi } from '../store/ui';
import '../styles/panels.css';

export default function RunnerPanel() {
  const workspaceId = useApp((s) => s.workspaceId);
  const currentRunId = useRunner((s) => s.currentRunId);
  const run = useRunner((s) => (s.currentRunId ? s.runs[s.currentRunId] : undefined));
  const starting = useRunner((s) => s.starting);
  const error = useRunner((s) => s.error);
  const lastOptions = useRunner((s) => s.lastOptions);
  const [previous, setPrevious] = useState<RunSummary[] | null>(null);
  const [prevError, setPrevError] = useState<string | null>(null);
  const [showPrev, setShowPrev] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureRunnerSubscription();
  }, []);

  const finished = run?.done != null;
  const running = Boolean(run) && !finished;

  const loadPrevious = useCallback(async () => {
    if (!workspaceId) return;
    setPrevError(null);
    try {
      setPrevious(await api.runner.list({ workspaceId }));
    } catch (e) {
      setPrevError(errorMessage(e));
      setPrevious([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (showPrev) void loadPrevious();
  }, [showPrev, loadPrevious, finished]);

  // Keep the newest rows in view while a run is live.
  const itemCount = run?.items.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [itemCount, running]);

  const stats = run ? summarizeItems(run.items) : null;
  const groups = run ? groupByIteration(run.items) : [];

  const exportAs = (kind: 'json' | 'csv') => {
    if (!run) return;
    const base = `run-${run.label}-${new Date(run.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    if (kind === 'json') downloadText(`${base}.json`, resultsToJson(run.items, { runId: run.runId, label: run.label, ...(run.done ? { status: run.done.status } : {}) }), 'application/json');
    else downloadText(`${base}.csv`, resultsToCsv(run.items), 'text/csv');
  };

  return (
    <div className="runner">
      <div className="runner-bar">
        <strong>{run ? run.label : 'Collection runner'}</strong>
        {running && (
          <span className="runner-live">
            <Spinner label="Run in progress" /> Running… {itemCount} request(s)
          </span>
        )}
        {run?.done && <Badge tone={run.done.status === 'completed' && run.done.failedTests === 0 && stats?.failedRequests === 0 ? 'success' : run.done.status === 'failed' ? 'danger' : 'warning'}>{run.done.status}</Badge>}
        <span className="panel-spacer" />
        {running && (
          <Button size="sm" variant="danger" onClick={() => void useRunner.getState().stop()}>
            Stop
          </Button>
        )}
        {finished && lastOptions && (
          <Button size="sm" onClick={() => void useRunner.getState().start(lastOptions)} disabled={starting}>
            Run again
          </Button>
        )}
        {run && itemCount > 0 && (
          <>
            <Button size="sm" onClick={() => exportAs('json')}>
              Export JSON
            </Button>
            <Button size="sm" onClick={() => exportAs('csv')}>
              Export CSV
            </Button>
          </>
        )}
        <Button size="sm" variant="primary" onClick={() => useUi.getState().openModal('runner')}>
          New run…
        </Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {run?.done && stats && (
        <div className="runner-summary" role="status">
          <span>
            Requests: <strong>{run.done.totalRequests || stats.requests}</strong>
          </span>
          <span className="runner-pass">Tests passed: {run.done.passedTests}</span>
          <span className={run.done.failedTests ? 'runner-fail' : ''}>Tests failed: {run.done.failedTests}</span>
          {stats.failedRequests > 0 && <span className="runner-fail">Failed requests: {stats.failedRequests}</span>}
          <span>Duration: {formatMs(run.done.durationMs || stats.durationMs)}</span>
        </div>
      )}

      <div className="runner-body" ref={scroller}>
        {!run ? (
          <EmptyState title="No run yet" action={<Button variant="primary" onClick={() => useUi.getState().openModal('runner')}>Start a run…</Button>}>
            Run a whole collection or folder with an environment and optional data file. Results appear here live.
          </EmptyState>
        ) : run.items.length === 0 ? (
          <div className="center-fill" style={{ padding: 24 }}>
            {running ? (
              <>
                <Spinner /> Waiting for the first result…
              </>
            ) : (
              <span className="field-hint">No requests were executed.</span>
            )}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.iteration} className="runner-iter">
              {groups.length > 1 && (
                <div className="runner-iter-head">
                  Iteration {g.iteration + 1} {g.failed > 0 && <Badge tone="danger">{g.failed} failed</Badge>}
                </div>
              )}
              {g.items.map((it) => (
                <RunnerRow key={`${it.iteration}:${it.index}`} item={it} />
              ))}
            </div>
          ))
        )}
        {run && run.items.length > 0 && !finished && currentRunId && <div className="field-hint" style={{ padding: 8 }}>Results are stored locally once the run finishes.</div>}
      </div>

      <div className="runner-prev">
        <button type="button" className="link-btn" aria-expanded={showPrev} onClick={() => setShowPrev((v) => !v)}>
          {showPrev ? '▾' : '▸'} Previous runs
        </button>
        {showPrev &&
          (previous === null ? (
            <Spinner label="Loading previous runs" />
          ) : prevError ? (
            <ErrorBanner message={prevError} onRetry={() => void loadPrevious()} />
          ) : previous.length === 0 ? (
            <div className="field-hint">No previous runs.</div>
          ) : (
            <ul className="runner-prev-list">
              {previous.map((r) => (
                <li key={r.id}>
                  <button type="button" className={`runner-prev-item ${r.id === currentRunId ? 'active' : ''}`} onClick={() => void useRunner.getState().viewRun(r)}>
                    <span className="runner-prev-name">{r.collectionName}</span>
                    <Badge tone={r.status === 'completed' && r.failedTests === 0 ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{r.status}</Badge>
                    <span>{r.totalRequests} req</span>
                    <span>
                      {r.passedTests} passed / {r.failedTests} failed
                    </span>
                    <span title={r.startedAt}>{relativeTime(r.startedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}

function RunnerRow({ item }: { item: RunnerItemEvent }) {
  const [open, setOpen] = useState(!item.passed);
  const failedTests = item.tests.filter((t) => !t.passed && !t.skipped).length;
  const expandable = item.tests.length > 0 || Boolean(item.error);
  const text = formatRunnerRow(item);
  return (
    <div className={`runner-row ${item.passed ? 'pass' : 'fail'}`}>
      <button type="button" className="runner-row-main" aria-expanded={expandable ? open : undefined} disabled={!expandable} onClick={() => setOpen((o) => !o)} title={text}>
        <span className="runner-mark" aria-label={item.passed ? 'Passed' : 'Failed'}>
          {item.passed ? '✓' : '✗'}
        </span>
        <span className="runner-name">{item.name}</span>
        <span className="runner-status">{item.statusCode ?? 'ERR'}</span>
        <span className="runner-ms">{item.durationMs === null ? '—' : `${Math.round(item.durationMs)}ms`}</span>
        {item.tests.length > 0 && (
          <span className="runner-tests">
            {item.tests.length - failedTests}/{item.tests.length} tests
          </span>
        )}
        {expandable && <span aria-hidden="true">{open ? '▾' : '▸'}</span>}
      </button>
      {open && expandable && (
        <div className="runner-detail">
          <div className="runner-url">
            <MethodLabel method={item.method} /> <span className="mono">{item.url}</span>
          </div>
          {item.error && <div className="runner-error">Error: {item.error}</div>}
          {item.tests.length > 0 && (
            <ul className="runner-tests-list">
              {item.tests.map((t, i) => (
                <li key={i} className={t.skipped ? 'skip' : t.passed ? 'pass' : 'fail'}>
                  {t.skipped ? '○' : t.passed ? '✓' : '✗'} {t.name}
                  {t.error && <div className="runner-error">{t.error}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
