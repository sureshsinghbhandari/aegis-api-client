import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { isSecretRef, MASK } from '../lib/ui-format';
import { useApp } from '../store/app';
import '../styles/panels.css';

const AUTO_HIDE_MS = 20_000;

/**
 * Input for a secret value.
 *  - A `secretref:` value is never displayed: masked dots + Reveal (explicit action, auto-hides) + Replace.
 *  - A freshly typed value is a password field with a Show toggle; the backend stores it as a secret on save.
 */
export function SecretValue({ value, onChange, label, placeholder }: { value: string; onChange(v: string): void; label: string; placeholder?: string }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTyped, setShowTyped] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setRevealed(null);
  };

  const reveal = async () => {
    setBusy(true);
    try {
      const plain = await api.variables.revealSecret({ ref: value });
      setRevealed(plain);
      timer.current = setTimeout(() => setRevealed(null), AUTO_HIDE_MS);
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (isSecretRef(value)) {
    return (
      <div className="secret-cell">
        <input aria-label={`${label} (secret)`} readOnly value={revealed ?? MASK} type="text" className="mono" spellCheck={false} />
        {revealed === null ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void reveal()} title="Show the secret value for a few seconds">
            Reveal
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={hide}>
            Hide
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm"
          title="Discard the stored value and type a new one"
          onClick={() => {
            hide();
            onChange('');
          }}
        >
          Replace
        </button>
      </div>
    );
  }
  return (
    <div className="secret-cell">
      <input
        aria-label={`${label} (secret)`}
        type={showTyped ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder ?? 'Enter secret value'}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="btn btn-sm" aria-pressed={showTyped} onClick={() => setShowTyped((v) => !v)}>
        {showTyped ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
