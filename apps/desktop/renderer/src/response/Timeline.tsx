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

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function isExpired(validTo: string): boolean {
  const d = new Date(validTo);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
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
          {(() => {
            const dns = t.dnsMs ?? 0;
            const connect = t.connectMs ?? 0;
            const tls = t.tlsMs ?? 0;
            const setup = dns + connect + tls;
            // Connection phases happen inside the "waiting" window; show them as a breakdown before TTFB.
            const ttfb = Math.max(0, t.waitingMs - setup);
            const hasPhases = t.dnsMs !== undefined || t.connectMs !== undefined || t.tlsMs !== undefined;
            return (
              <>
                {hasPhases && <TimingBar label="DNS lookup" ms={dns} total={total} offset={0} tone="var(--text-dim)" />}
                {hasPhases && <TimingBar label="TCP connect" ms={connect} total={total} offset={dns} tone="var(--warning)" />}
                {hasPhases && response.tls && <TimingBar label="TLS handshake" ms={tls} total={total} offset={dns + connect} tone="var(--danger)" />}
                <TimingBar label="Waiting (TTFB)" ms={hasPhases ? ttfb : t.waitingMs} total={total} offset={hasPhases ? setup : 0} tone="var(--info)" />
                <TimingBar label="Download" ms={t.downloadMs} total={total} offset={t.waitingMs} tone="var(--success)" />
                <TimingBar label="Total" ms={total} total={total} offset={0} tone="var(--accent)" />
              </>
            );
          })()}
          <div className="wb-dim">
            Started {new Date(t.startedAt).toLocaleTimeString()} · request {formatBytes(response.requestSize)} · response {formatBytes(response.size)} · {response.httpVersion}
            {response.connection?.reused ? ' · connection reused' : ''}
          </div>
        </section>
      )}

      {response && (response.tls || response.connection) && (
        <section>
          <h4>Connection</h4>
          <table className="rv-table">
            <tbody>
              <tr>
                <td className="rv-key">Protocol</td>
                <td className="mono">{response.httpVersion}</td>
              </tr>
              {response.connection && (
                <tr>
                  <td className="rv-key">Remote address</td>
                  <td className="mono">
                    {response.connection.remoteAddress}:{response.connection.remotePort}
                    {response.connection.hostOverride && (
                      <>
                        {' '}
                        <Badge tone="warning">hosts override</Badge>
                      </>
                    )}
                  </td>
                </tr>
              )}
              {response.connection && (
                <tr>
                  <td className="rv-key">Local address</td>
                  <td className="mono">
                    {response.connection.localAddress}:{response.connection.localPort}
                  </td>
                </tr>
              )}
              {response.tls && (
                <>
                  <tr>
                    <td className="rv-key">TLS</td>
                    <td className="mono">
                      {response.tls.protocol} · {response.tls.cipher}
                      {response.tls.alpn ? ` · ALPN ${response.tls.alpn}` : ''}{' '}
                      {response.tls.authorized ? <Badge tone="success">verified</Badge> : <Badge tone="danger">not verified</Badge>}
                    </td>
                  </tr>
                  {response.tls.peerCertificate && (
                    <>
                      <tr>
                        <td className="rv-key">Certificate subject</td>
                        <td className="mono pre-wrap">{response.tls.peerCertificate.subject}</td>
                      </tr>
                      <tr>
                        <td className="rv-key">Issuer</td>
                        <td className="mono pre-wrap">{response.tls.peerCertificate.issuer}</td>
                      </tr>
                      <tr>
                        <td className="rv-key">Valid</td>
                        <td className="mono">
                          {formatDate(response.tls.peerCertificate.validFrom)} → {formatDate(response.tls.peerCertificate.validTo)}
                          {isExpired(response.tls.peerCertificate.validTo) && (
                            <>
                              {' '}
                              <Badge tone="danger">expired</Badge>
                            </>
                          )}
                        </td>
                      </tr>
                      {response.tls.peerCertificate.subjectAltName && (
                        <tr>
                          <td className="rv-key">Subject alt names</td>
                          <td className="mono pre-wrap">{response.tls.peerCertificate.subjectAltName}</td>
                        </tr>
                      )}
                      <tr>
                        <td className="rv-key">SHA-256 fingerprint</td>
                        <td className="mono pre-wrap">{response.tls.peerCertificate.fingerprint}</td>
                      </tr>
                    </>
                  )}
                </>
              )}
            </tbody>
          </table>
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
