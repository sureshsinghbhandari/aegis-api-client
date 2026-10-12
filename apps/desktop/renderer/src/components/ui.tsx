import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { KeyValueEntry } from '@aegis/core';
import { VariableInput } from './VariableInput';

/* ------------------------------------------------------------------ buttons */

export function Button({ variant = 'default', size = 'md', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; size?: 'sm' | 'md' }) {
  return <button type="button" {...props} className={`btn btn-${variant} btn-${size} ${className}`} />;
}

export function IconButton({ label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" aria-label={label} title={label} {...props} className={`icon-btn ${className}`} />;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <span>{message}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- form */

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label?: string; disabled?: boolean }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label && <span>{label}</span>}
    </label>
  );
}

/* --------------------------------------------------------------------- tabs */

export function Tabs<T extends string>({ tabs, value, onChange, className = '' }: { tabs: Array<{ id: T; label: ReactNode; badge?: ReactNode }>; value: T; onChange(id: T): void; className?: string }) {
  return (
    <div className={`tabs ${className}`} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className={`tab ${t.id === value ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.badge !== undefined && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- modal */

export function Modal({ title, onClose, children, footer, width = 640 }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <header className="modal-header">
          <h2>{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            ✕
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- context menu */

export interface MenuEntry {
  label: string;
  onSelect(): void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - entries.length * 30 - 20);
  return (
    <div ref={ref} className="context-menu" style={{ left, top }} role="menu" onMouseDown={(e) => e.stopPropagation()}>
      {entries.map((e, i) => (
        <div key={i}>
          {e.separatorBefore && <div className="menu-sep" />}
          <button
            type="button"
            role="menuitem"
            disabled={e.disabled}
            className={`menu-item ${e.danger ? 'danger' : ''}`}
            onClick={() => {
              onClose();
              e.onSelect();
            }}
          >
            {e.label}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Hook: `const { menu, open } = useContextMenu(); onContextMenu={(e) => open(e, entries)}`. */
export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const open = useCallback((e: { clientX: number; clientY: number; preventDefault(): void }, entries: MenuEntry[]) => {
    e.preventDefault();
    setState({ x: e.clientX, y: e.clientY, entries });
  }, []);
  const menu = state ? <ContextMenu {...state} onClose={() => setState(null)} /> : null;
  return { menu, open };
}

/* ----------------------------------------------------------- key/value table */

export interface KeyValueTableProps {
  rows: KeyValueEntry[];
  onChange(rows: KeyValueEntry[]): void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  showDescription?: boolean;
  /** Mask values (e.g. for secrets) until the field is focused. */
  maskValues?: boolean;
  /** Suggestions for the key column (e.g. common header names). */
  keySuggestions?: string[];
  readOnlyKeys?: boolean;
  /** Offer `{{variable}}` autocomplete/hover/unresolved highlighting in the key and value cells (active request's scopes). */
  variableHints?: boolean;
}

/** Editable key/value grid with enable checkboxes and an always-present empty row. */
export function KeyValueTable({ rows, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value', showDescription = true, maskValues, keySuggestions, readOnlyKeys, variableHints }: KeyValueTableProps) {
  const listId = useRef(`kv-${Math.random().toString(36).slice(2)}`).current;
  const display = [...rows, { key: '', value: '', enabled: true } as KeyValueEntry];
  const update = (i: number, patch: Partial<KeyValueEntry>) => {
    const next = display.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next.filter((r, idx) => idx < rows.length || r.key !== '' || r.value !== '' || (r.description ?? '') !== ''));
  };
  return (
    <div className="kv">
      {keySuggestions && (
        <datalist id={listId}>
          {keySuggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      <div className={`kv-row kv-head ${showDescription ? '' : 'no-desc'}`}>
        <span />
        <span>{keyPlaceholder}</span>
        <span>{valuePlaceholder}</span>
        {showDescription && <span>Description</span>}
        <span />
      </div>
      {display.map((r, i) => {
        const isGhost = i === rows.length;
        return (
          <div key={i} className={`kv-row ${showDescription ? '' : 'no-desc'} ${r.enabled ? '' : 'disabled'}`}>
            <input type="checkbox" aria-label="Enabled" checked={r.enabled} disabled={isGhost} onChange={(e) => update(i, { enabled: e.target.checked })} />
            {variableHints ? (
              <VariableInput value={r.key} placeholder={keyPlaceholder} list={keySuggestions ? listId : undefined} readOnly={readOnlyKeys && !isGhost} onChange={(key) => update(i, { key })} />
            ) : (
              <input value={r.key} placeholder={keyPlaceholder} list={keySuggestions ? listId : undefined} readOnly={readOnlyKeys && !isGhost} spellCheck={false} onChange={(e) => update(i, { key: e.target.value })} />
            )}
            {variableHints && !maskValues ? (
              <VariableInput value={r.value} placeholder={valuePlaceholder} onChange={(value) => update(i, { value })} />
            ) : (
              <input value={r.value} placeholder={valuePlaceholder} type={maskValues ? 'password' : 'text'} spellCheck={false} onChange={(e) => update(i, { value: e.target.value })} />
            )}
            {showDescription && <input value={r.description ?? ''} placeholder="Description" onChange={(e) => update(i, { description: e.target.value })} />}
            <button type="button" className="icon-btn" aria-label="Remove row" disabled={isGhost} onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ splitter */

/** Drag handle that resizes via a CSS variable / state. `direction`: which axis the handle resizes. */
export function useSplitter(initial: number, min: number, max: number, axis: 'x' | 'y', invert = false) {
  const [size, setSize] = useState(initial);
  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const start = axis === 'x' ? e.clientX : e.clientY;
      const startSize = size;
      const move = (ev: MouseEvent) => {
        const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start;
        setSize(Math.max(min, Math.min(max, startSize + (invert ? -delta : delta))));
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
      };
      document.body.classList.add('resizing');
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [size, min, max, axis, invert],
  );
  const handle = <div className={`splitter splitter-${axis}`} onMouseDown={startDrag} role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} />;
  return { size, handle };
}

/* ------------------------------------------------------------------- helpers */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function statusTone(code: number | null | undefined): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  if (!code) return 'neutral';
  if (code < 300) return 'success';
  if (code < 400) return 'info';
  if (code < 500) return 'warning';
  return 'danger';
}

export const METHOD_COLORS: Record<string, string> = {
  GET: 'var(--m-get)',
  POST: 'var(--m-post)',
  PUT: 'var(--m-put)',
  PATCH: 'var(--m-patch)',
  DELETE: 'var(--m-delete)',
  HEAD: 'var(--m-head)',
  OPTIONS: 'var(--m-options)',
};

/** Method badge. Long custom methods (e.g. PROPFIND, CONNECT) are shown in full in a narrower font instead of being cut off. */
export function MethodLabel({ method }: { method: string }) {
  const upper = method.toUpperCase();
  return (
    <span className={`method ${upper.length > 5 ? 'method-long' : ''}`} title={upper} style={{ color: METHOD_COLORS[upper] ?? 'var(--text-dim)' }}>
      {upper}
    </span>
  );
}
