import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, EmptyState, formatBytes, formatMs, statusTone } from '../components/ui';
import { mergeConsoleRows, networkEntryText, type ConsoleKindFilter, type ConsoleLevelFilter, type ConsoleRow, type NetworkLogEntry } from '../lib/network-log';
import { copyText } from '../response/useResponseBody';
import { useApp, type ConsoleLine } from '../store/app';
import '../styles/workbench.css';
import '../styles/tools.css';

const LEVELS: readonly ConsoleLevelFilter[] = ['all', 'log', 'info', 'warn', 'error', 'debug'];
type Level = ConsoleLevelFilter;
type Kind = ConsoleKindFilter;
type Row = ConsoleRow<ConsoleLine>;

const time = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour12: false });
const asText = (r: Row): string =>
  r.kind === 'script' ? `[${time(r.line.timestamp)}] ${r.line.level.toUpperCase()} ${r.line.request}: ${r.line.message}` : `[${time(r.entry.timestamp)}] NET ${r.entry.request}: ${networkEntryText(r.entry)}`;

function HeaderTable({ title, headers }: { title: string; headers: NetworkLogEntry['requestHeaders'] }) {
  return (
    <div className="co-net-headers">
      <div className="co-net-title">{title}</div>
      {headers.length === 0 ? (
        <div className="wb-dim">none</div>
      ) : (
        <table className="rv-table">
          <tbody>
            {headers.map((h, i) => (
              <tr key={i}>
                <td className="mono rv-key">{h.name}</td>
                <td className="mono pre-wrap">{h.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NetworkRow({ entry, expanded, onToggle }: { entry: NetworkLogEntry; expanded: boolean; onToggle(): void }) {
  const tone = entry.error ? 'danger' : statusTone(entry.status);
  return (
    <div className={`co-net ${expanded ? 'open' : ''}`}>
      <button type="button" className="co-net-line" onClick={onToggle} aria-expanded={expanded}>
        <span className="co-time">{time(entry.timestamp)}</span>
        <span className={`co-level ${entry.source === 'runner' ? 'info' : entry.source === 'script' ? 'debug' : 'log'}`}>{entry.source === 'script' ? 'script' : entry.source === 'runner' ? 'runner' : 'net'}</span>
        <span className="co-req" title={entry.request}>
          {entry.request}
        </span>
        <span className="co-net-summary">
          <strong className="mono">{entry.method}</strong> <span className="mono co-net-url">{entry.url || '(no URL)'}</span>{' '}
          {entry.status !== null ? <Badge tone={tone}>{entry.status}{entry.statusText ? ` ${entry.statusText}` : ''}</Badge> : entry.error ? <Badge tone="danger">error</Badge> : <Badge tone="neutral">—</Badge>}{' '}
          {entry.durationMs !== null && <span className="wb-dim">{formatMs(entry.durationMs)}</span>} {entry.size !== null && <span className="wb-dim">{formatBytes(entry.size)}</span>}
        </span>
      </button>
      {expanded && (
        <div className="co-net-detail">
          {entry.error && <div className="co-msg error">{entry.error}</div>}
          {entry.note && <div className="wb-dim">{entry.note}</div>}
          <div className="wb-dim">Sensitive header values (Authorization, Cookie, API keys, tokens) are redacted. Bodies are not logged; see the Timeline tab of the request.</div>
          <HeaderTable title="Request headers" headers={entry.requestHeaders} />
          <HeaderTable title="Response headers" headers={entry.responseHeaders} />
        </div>
      )}
    </div>
  );
}

export function ConsolePanel() {
  const lines = useApp((s) => s.consoleLines);
  const network = useApp((s) => s.networkLog);
  const clear = useApp((s) => s.clearConsole);
  const [level, setLevel] = useState<Level>('all');
  const [kind, setKind] = useState<Kind>('all');
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const visible = useMemo(() => mergeConsoleRows(lines, network, { kind, level, text }), [lines, network, kind, level, text]);
  const total = lines.length + network.length;

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 20,
    getItemKey: (i) => {
      const r = visible[i];
      return r ? (r.kind === 'script' ? r.line.id : r.entry.id) : i;
    },
  });

  // Follow the tail unless the user scrolled up.
  useEffect(() => {
    if (stick.current && visible.length > 0) virtualizer.scrollToIndex(visible.length - 1, { align: 'end' });
  }, [visible.length, virtualizer]);

  return (
    <div className="bp-root">
      <div className="bp-toolbar">
        <select aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="all">Scripts + network</option>
          <option value="scripts">Script output</option>
          <option value="network">Network log</option>
        </select>
        <select aria-label="Filter by level" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === 'all' ? 'All levels' : l}
            </option>
          ))}
        </select>
        <input type="search" aria-label="Filter console" placeholder="Filter messages, URLs…" value={text} onChange={(e) => setText(e.target.value)} />
        <span className="wb-dim">
          {visible.length}
          {visible.length !== total ? ` of ${total}` : ''} entries
        </span>
        <span className="wb-spacer" />
        <Button size="sm" disabled={visible.length === 0} onClick={() => void copyText(visible.map(asText).join('\n'), 'Console copied')}>
          Copy all
        </Button>
        <Button size="sm" disabled={total === 0} onClick={clear}>
          Clear
        </Button>
      </div>
      {total === 0 ? (
        <EmptyState title="Console is empty">
          Every request you send, runner item and <code>pm.sendRequest</code> call is logged here with method, URL, status, time and size (headers redacted), together with <code>console.log()</code> output and script errors.
        </EmptyState>
      ) : visible.length === 0 ? (
        <div className="empty">No entries match the filter.</div>
      ) : (
        <div
          ref={scrollRef}
          className="bp-scroll mono"
          role="log"
          aria-label="Console output"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const r = visible[v.index];
              if (!r) return null;
              if (r.kind === 'network') {
                const id = r.entry.id;
                return (
                  <div key={v.key} ref={virtualizer.measureElement} data-index={v.index} className="co-row" style={{ transform: `translateY(${v.start}px)` }}>
                    <NetworkRow entry={r.entry} expanded={!!expanded[id]} onToggle={() => setExpanded((x) => ({ ...x, [id]: !x[id] }))} />
                  </div>
                );
              }
              const l = r.line;
              return (
                <div key={v.key} ref={virtualizer.measureElement} data-index={v.index} className="co-line" style={{ transform: `translateY(${v.start}px)` }}>
                  <span className="co-time">{time(l.timestamp)}</span>
                  <span className={`co-level ${l.level}`}>{l.level}</span>
                  <span className="co-req" title={l.request}>
                    {l.request}
                  </span>
                  <span className={`co-msg ${l.level}`}>{l.message}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
