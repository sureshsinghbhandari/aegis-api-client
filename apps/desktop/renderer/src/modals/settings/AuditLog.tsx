import { useCallback, useEffect, useState } from 'react';
import type { AuditView } from '@aegis/core';
import { api, errorMessage } from '../../lib/api';
import { relativeTime, truncate } from '../../lib/ui-format';
import { Button, EmptyState, ErrorBanner, Spinner } from '../../components/ui';

const PAGE = 25;

export function AuditLog() {
  const [action, setAction] = useState('');
  const [debounced, setDebounced] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AuditView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(action.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [action]);

  const load = useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      setRows(await api.audit.list({ ...(debounced ? { action: debounced } : {}), limit: PAGE + 1, offset }));
    } catch (e) {
      setError(errorMessage(e));
      setRows([]);
    }
  }, [debounced, offset]);
  useEffect(() => {
    void load();
  }, [load]);

  const hasMore = (rows?.length ?? 0) > PAGE;
  const shown = rows?.slice(0, PAGE) ?? [];

  return (
    <div className="audit">
      <div className="set-row">
        <label>
          <span className="field-label">Filter by action </span>
          <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. secret.reveal" spellCheck={false} />
        </label>
        <Button size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {error && <ErrorBanner message={error} onRetry={() => void load()} />}
      {rows === null ? (
        <Spinner label="Loading audit log" />
      ) : shown.length === 0 ? (
        <EmptyState title="No audit entries">Security-relevant actions such as revealing or exporting secrets are recorded here, locally.</EmptyState>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td title={r.createdAt}>{relativeTime(r.createdAt)}</td>
                <td className="mono">{r.action}</td>
                <td className="mono audit-details" title={JSON.stringify(r.details)}>
                  {truncate(JSON.stringify(r.details), 140)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="set-row">
        <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          Previous
        </Button>
        <span className="field-hint">
          Entries {offset + 1} to {offset + shown.length}
        </span>
        <Button size="sm" disabled={!hasMore} onClick={() => setOffset(offset + PAGE)}>
          Next
        </Button>
      </div>
    </div>
  );
}
