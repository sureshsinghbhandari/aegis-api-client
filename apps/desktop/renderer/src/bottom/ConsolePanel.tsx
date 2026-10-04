import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState } from '../components/ui';
import { copyText } from '../response/useResponseBody';
import { useApp, type ConsoleLine } from '../store/app';
import '../styles/workbench.css';

const LEVELS = ['all', 'log', 'info', 'warn', 'error', 'debug'] as const;
type Level = (typeof LEVELS)[number];

const time = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour12: false });
const asText = (l: ConsoleLine): string => `[${time(l.timestamp)}] ${l.level.toUpperCase()} ${l.request}: ${l.message}`;

export function ConsolePanel() {
  const lines = useApp((s) => s.consoleLines);
  const clear = useApp((s) => s.clearConsole);
  const [level, setLevel] = useState<Level>('all');
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase();
    return lines.filter((l) => (level === 'all' || l.level === level) && (q === '' || l.message.toLowerCase().includes(q) || l.request.toLowerCase().includes(q)));
  }, [lines, level, text]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 20,
    getItemKey: (i) => visible[i]?.id ?? i,
  });

  // Follow the tail unless the user scrolled up.
  useEffect(() => {
    if (stick.current && visible.length > 0) virtualizer.scrollToIndex(visible.length - 1, { align: 'end' });
  }, [visible.length, virtualizer]);

  return (
    <div className="bp-root">
      <div className="bp-toolbar">
        <select aria-label="Filter by level" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === 'all' ? 'All levels' : l}
            </option>
          ))}
        </select>
        <input type="search" aria-label="Filter console" placeholder="Filter messages…" value={text} onChange={(e) => setText(e.target.value)} />
        <span className="wb-dim">
          {visible.length}
          {visible.length !== lines.length ? ` of ${lines.length}` : ''} messages
        </span>
        <span className="wb-spacer" />
        <Button size="sm" disabled={visible.length === 0} onClick={() => void copyText(visible.map(asText).join('\n'), 'Console copied')}>
          Copy all
        </Button>
        <Button size="sm" disabled={lines.length === 0} onClick={clear}>
          Clear
        </Button>
      </div>
      {lines.length === 0 ? (
        <EmptyState title="Console is empty">Output from console.log() in scripts and script errors appear here after you send a request.</EmptyState>
      ) : visible.length === 0 ? (
        <div className="empty">No messages match the filter.</div>
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
              const l = visible[v.index];
              if (!l) return null;
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
