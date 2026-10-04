import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ErrorBanner, formatBytes, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { CHUNK_BYTES, offsetForFraction, splitDisplayLines } from '../lib/chunks';
import { useApp } from '../store/app';
import { copyText } from './useResponseBody';

const ROW = 18;

/**
 * Viewer for bodies too large for an editor. Shows one 256 KB window at a time (read through
 * `responses.readChunk`) with virtualized rows, next/previous navigation and a jump slider.
 */
export function LargeBodyViewer({ responseId, size, onSave }: { responseId: string; size: number; onSave(): void }) {
  const [offset, setOffset] = useState(0);
  const [chunk, setChunk] = useState<{ offset: number; text: string; bytesRead: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.responses
      .readChunk({ responseId, offset, length: CHUNK_BYTES })
      .then((c) => {
        if (cancelled) return;
        setChunk({ offset: c.offset, text: c.text, bytesRead: c.bytesRead });
        scrollRef.current?.scrollTo({ top: 0 });
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [responseId, offset, attempt]);

  const rows = useMemo(() => splitDisplayLines(chunk?.text ?? ''), [chunk]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW, overscan: 30 });

  const end = chunk ? chunk.offset + chunk.bytesRead : offset;
  const hasNext = end < size && (chunk?.bytesRead ?? 0) > 0;
  const hasPrev = offset > 0;

  return (
    <div className="rv-large">
      <div className="rv-large-bar">
        <span className="rv-large-note">
          Large response ({formatBytes(size)}): shown as plain text in {formatBytes(CHUNK_BYTES)} windows. A window may start or end in the middle of a line.
        </span>
        <span className="wb-spacer" />
        <Button size="sm" onClick={onSave}>
          Save to file
        </Button>
        <Button size="sm" disabled={!chunk} onClick={() => chunk && void copyText(chunk.text, 'Copied this window')}>
          Copy window
        </Button>
      </div>
      <div className="rv-large-nav">
        <Button size="sm" disabled={!hasPrev || loading} onClick={() => setOffset(Math.max(0, offset - CHUNK_BYTES))} aria-label="Previous window">
          ‹ Prev
        </Button>
        <input
          type="range"
          aria-label="Position in response"
          min={0}
          max={1000}
          value={Math.round((offset / Math.max(1, size)) * 1000)}
          onChange={(e) => setOffset(offsetForFraction(Number(e.target.value) / 1000, size))}
        />
        <Button size="sm" disabled={!hasNext || loading} onClick={() => setOffset(end)} aria-label="Next window">
          Next ›
        </Button>
        <span className="rv-large-pos">
          {formatBytes(offset)} – {formatBytes(end)} of {formatBytes(size)}
        </span>
        {loading && <Spinner label="Loading" />}
      </div>
      {error && <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />}
      <div ref={scrollRef} className="rv-large-scroll" tabIndex={0} aria-label="Response body (large)">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: '100%' }}>
          {virtualizer.getVirtualItems().map((v) => (
            <div key={v.key} className="rv-large-row" style={{ transform: `translateY(${v.start}px)`, height: ROW }}>
              {rows[v.index]}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Convenience wrapper used by the response viewer. */
export function saveResponse(responseId: string, suggestedName: string): void {
  api.responses
    .saveAs({ responseId, suggestedName })
    .then((path) => path && useApp.getState().toast(`Saved to ${path}`, 'success'))
    .catch((e) => useApp.getState().toast(errorMessage(e), 'error'));
}
