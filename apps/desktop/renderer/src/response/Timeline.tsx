import type { ExecutionResult, ResponseView } from '@aegis/core';
import { Badge, formatBytes, formatMs } from '../components/ui';

function TimingBar({ label, ms, total, offset, tone }: { label: string; ms: number; total: number; offset: number; tone: string }) {
  const left = total > 0 ? (offset / total) * 100 : 0;
  const width = total > 0 ? Math.max(1, (ms / total) * 100) : 0;
  return (
    <div className="tl-bar-row">
      <span className="tl-bar-label">{label}</span>
      <div className="tl-bar-track" role="img" aria-label={`${label}: ${formatMs(ms)}`}>
        <div className="tl-bar" style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, background: tone }} />
      </div>
      <span className="tl-bar-value mono">{formatMs(ms)}</span>
    </div>
  );
}

export function Timeline({ result, response }: { result: ExecutionResult; response?: ResponseView }) {
  const t = response?.timings;
  const total = t?.totalMs ?? 0;
  const changes = Object.entries(result.variableChanges).filter(([, c]) => c.set.length + c.unset.length > 0);
  return (
    <div className="rv-scroll tl">
      {result.skipped && <div className="banner tl-banner">This request was skipped by a pre-request script.</div>}

      <section>
        <h4>Request</h4>
        {result.request ? (
          <>
            <div className="tl-line mono">
              <strong>{result.request.method}</strong> {result.request.url}
            </div>
            <div className="wb-dim">Sensitive values are redacted. Final headers as sent:</div>
            {result.request.headers.length > 0 && (
              <table className="rv-table">
                <tbody>
                  {result.request.headers.map((h, i) => (
                    <tr key={i}>
                      <td className="mono rv-key">{h.name}</td>
                      <td className="mono pre-wrap">{h.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {result.request.bodyPreview && <pre className="tl-pre mono pre-wrap">{result.request.bodyPreview}</pre>}
          </>
        ) : (
          <div className="wb-dim">The request was not resolved (it failed before it could be built).</div>
        )}
      </section>

      {t && response && (
        <section>
          <h4>Timings</h4>
          <TimingBar label="Waiting (TTFB)" ms={t.waitingMs} total={total} offset={0} tone="var(--info)" />
          <TimingBar label="Download" ms={t.downloadMs} total={total} offset={t.waitingMs} tone="var(--success)" />
          <TimingBar label="Total" ms={total} total={total} offset={0} tone="var(--accent)" />
          <div className="wb-dim">
            Started {new Date(t.startedAt).toLocaleTimeString()} · request {formatBytes(response.requestSize)} · response {formatBytes(response.size)} · {response.httpVersion}
          </div>
        </section>
      )}

      {result.environment && (
        <section>
          <h4>Environment</h4>
          <div>
            {result.environment.name} {result.environment.isProduction && <Badge tone="danger">PRODUCTION</Badge>}
          </div>
        </section>
      )}

      {response && response.redirects.length > 0 && (
        <section>
          <h4>Redirects ({response.redirects.length})</h4>
          <ol className="tl-list">
            {response.redirects.map((r, i) => (
              <li key={i} className="mono">
                {r.status} {r.url} → {r.location}
              </li>
            ))}
          </ol>
          <div className="wb-dim">Final URL: {response.url}</div>
        </section>
      )}

      {response && response.notes.length > 0 && (
        <section>
          <h4>Notes</h4>
          <ul className="tl-list">
            {response.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      {result.warnings.length > 0 && (
        <section>
          <h4>Warnings</h4>
          <ul className="tl-list tl-warn">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      {result.unresolvedVariables.length > 0 && (
        <section>
          <h4>Unresolved variables</h4>
          <div className="tl-chips">
            {result.unresolvedVariables.map((v) => (
              <code key={v} className="wb-var-badge">{`{{${v}}}`}</code>
            ))}
          </div>
        </section>
      )}

      {changes.length > 0 && (
        <section>
          <h4>Variables changed by scripts</h4>
          <div className="wb-dim">Names only; values are not shown.</div>
          <table className="rv-table">
            <tbody>
              {changes.map(([scope, c]) => (
                <tr key={scope}>
                  <td className="rv-key">{scope}</td>
                  <td className="mono pre-wrap">
                    {c.set.length > 0 && <div>set: {c.set.join(', ')}</div>}
                    {c.unset.length > 0 && <div>unset: {c.unset.join(', ')}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {result.nextRequest !== undefined && (
        <section>
          <h4>Next request</h4>
          <div>{result.nextRequest === null ? 'A script stopped the collection run (setNextRequest(null)).' : `A script set the next request to "${result.nextRequest}" (used by the Runner).`}</div>
        </section>
      )}
    </div>
  );
}
