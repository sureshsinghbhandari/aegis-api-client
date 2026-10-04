import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface VirtualRange {
  start: number;
  end: number;
}

/** Visible index range for a fixed row height (pure, exported for tests). */
export function visibleRange(count: number, rowHeight: number, scrollTop: number, viewport: number, overscan = 8): VirtualRange {
  const first = Math.floor(scrollTop / rowHeight);
  const last = Math.ceil((scrollTop + viewport) / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}

/**
 * Scroll container that only renders the rows in view once there are more than `threshold` rows.
 * Rows must have the fixed height `rowHeight`.
 */
export function VirtualList({
  count,
  rowHeight,
  renderRow,
  threshold = 200,
  className = '',
  footer,
  label,
}: {
  count: number;
  rowHeight: number;
  renderRow(index: number): ReactNode;
  threshold?: number;
  className?: string;
  footer?: ReactNode;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewport(el.clientHeight || 600);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const virtual = count > threshold;
  const range = virtual ? visibleRange(count, rowHeight, scrollTop, viewport) : { start: 0, end: count };
  const rows: ReactNode[] = [];
  for (let i = range.start; i < range.end; i++) rows.push(renderRow(i));

  return (
    <div ref={ref} className={`vlist ${className}`} onScroll={(e) => virtual && setScrollTop(e.currentTarget.scrollTop)} role="list" aria-label={label}>
      {virtual && <div style={{ height: range.start * rowHeight }} aria-hidden="true" />}
      {rows}
      {virtual && <div style={{ height: Math.max(0, count - range.end) * rowHeight }} aria-hidden="true" />}
      {footer}
    </div>
  );
}
