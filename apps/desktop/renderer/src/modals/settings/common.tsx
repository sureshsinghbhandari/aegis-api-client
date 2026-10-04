import { useEffect, useState, type ReactNode } from 'react';
import type { AppInfo, AppSettings } from '@aegis/core';
import { parseBoundedInt } from '../../lib/settings-helpers';
import '../../styles/panels.css';

export interface SectionProps {
  settings: AppSettings;
  info: AppInfo | null;
  /** Persist a patch; resolves true on success. */
  save(patch: Record<string, unknown>): Promise<boolean>;
  /** Re-read the settings from the backend (e.g. after the proxy password changed). */
  reload(): Promise<void>;
}

export function SettingsGroup({ title, children, description }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="set-group">
      <h3>{title}</h3>
      {description && <p className="field-hint">{description}</p>}
      {children}
    </section>
  );
}

/** Integer input that validates and persists on blur / Enter. */
export function NumberField({ label, value, min, max, unit, hint, disabled, onCommit }: { label: string; value: number; min: number; max: number; unit?: string; hint?: string; disabled?: boolean; onCommit(v: number): void }) {
  const [text, setText] = useState(String(value));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(String(value));
    setErr(null);
  }, [value]);
  const commit = () => {
    const n = parseBoundedInt(text, min, max);
    if (n === null) {
      setErr('Enter a whole number.');
      return;
    }
    setErr(null);
    setText(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {unit ? ` (${unit})` : ''}
      </span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        disabled={disabled}
        aria-invalid={err !== null}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {(err || hint) && <span className={`field-hint ${err ? 'field-err' : ''}`}>{err ?? hint}</span>}
      <span className="field-hint">
        Allowed: {min.toLocaleString('en-US')} to {max.toLocaleString('en-US')}
      </span>
    </label>
  );
}

/** Text input that persists on blur / Enter. */
export function TextField({ label, value, placeholder, hint, type = 'text', disabled, validate, onCommit }: { label: string; value: string; placeholder?: string; hint?: string; type?: 'text' | 'password'; disabled?: boolean; validate?(v: string): string | null; onCommit(v: string): void }) {
  const [text, setText] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(value);
    setErr(null);
  }, [value]);
  const commit = () => {
    const problem = validate?.(text) ?? null;
    setErr(problem);
    if (!problem && text !== value) onCommit(text);
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type={type}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        spellCheck={false}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={err !== null}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {(err || hint) && <span className={`field-hint ${err ? 'field-err' : ''}`}>{err ?? hint}</span>}
    </label>
  );
}
