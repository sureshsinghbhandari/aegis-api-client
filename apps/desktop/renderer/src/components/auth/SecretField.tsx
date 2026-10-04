import { isVariableReferenceOnly } from '@aegis/core';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useApp } from '../../store/app';
import { Button } from '../ui';

export const isSecretRef = (v: string): boolean => v.startsWith('secretref:');
const MASK = '••••••••••••';
const AUTO_HIDE_MS = 15_000;

/**
 * Input for a credential.
 * - A stored value (`secretref:`) is NEVER displayed: masked dots, "stored securely", Reveal (explicit, auto-hides) and Change.
 *   If the user does not touch it, the reference is sent back unchanged on save.
 * - A freshly typed value is masked while typing (Show toggles) and is moved into secret storage by the backend on save.
 * - `{{variable}}` references are shown as plain text because they are not credentials themselves.
 */
export function SecretField({ value, onChange, label, placeholder, multiline }: { value: string; onChange(v: string): void; label: string; placeholder?: string; multiline?: boolean }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // A different stored value must never keep showing the previous plaintext.
  useEffect(() => setRevealed(null), [value]);

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setRevealed(null);
  };

  const reveal = async () => {
    setBusy(true);
    try {
      setRevealed(await api.variables.revealSecret({ ref: value }));
      timer.current = setTimeout(() => setRevealed(null), AUTO_HIDE_MS);
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (isSecretRef(value)) {
    return (
      <div className="au-secret">
        <input aria-label={`${label} (stored securely)`} className="mono" readOnly value={revealed ?? MASK} spellCheck={false} />
        <span className="au-secure" title="Stored in the operating system's secure storage">
          stored securely
        </span>
        {revealed === null ? (
          <Button size="sm" disabled={busy} onClick={() => void reveal()} title="Show the value for a few seconds (audited)">
            Reveal
          </Button>
        ) : (
          <Button size="sm" onClick={hide}>
            Hide
          </Button>
        )}
        <Button
          size="sm"
          title="Discard the stored value and enter a new one"
          onClick={() => {
            hide();
            onChange('');
          }}
        >
          Change
        </Button>
      </div>
    );
  }

  const plain = show || isVariableReferenceOnly(value);
  return (
    <div className="au-secret">
      {multiline ? (
        <textarea
          aria-label={label}
          className={`mono au-multiline ${plain ? '' : 'au-masked'}`}
          rows={4}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input aria-label={label} type={plain ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      <Button size="sm" aria-pressed={show} onClick={() => setShow((v) => !v)}>
        {show ? 'Hide' : 'Show'}
      </Button>
    </div>
  );
}
