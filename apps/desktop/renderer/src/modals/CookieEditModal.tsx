import type { CookieView } from '@aegis/core';
import { useCallback, useState } from 'react';
import { Button, Checkbox, ErrorBanner, Field, Modal } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/collection-ops.css';

export interface CookieEditDialogProps {
  workspaceId: string;
  /** Edit this cookie; omit to add a new one. */
  cookie?: CookieView | undefined;
  onClose(): void;
  onSaved(saved: CookieView): void;
}

/** ISO timestamp -> value for an <input type="datetime-local"> (local time, minute precision). */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value -> ISO timestamp (null for empty / invalid). */
export function localInputToIso(value: string): string | null {
  if (!value.trim()) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Add/edit form for one cookie. Usable inline (from the settings Cookies section, which is itself a
 * modal) or through the modal host. The value is sent to the main process once and stored in the vault;
 * when editing, an empty value keeps the stored one.
 */
export function CookieEditDialog({ workspaceId, cookie, onClose, onSaved }: CookieEditDialogProps) {
  const [name, setName] = useState(cookie?.name ?? '');
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [domain, setDomain] = useState(cookie?.domain ?? '');
  const [path, setPath] = useState(cookie?.path ?? '/');
  const [expires, setExpires] = useState(isoToLocalInput(cookie?.expiresAt));
  const [secure, setSecure] = useState(cookie?.secure ?? false);
  const [httpOnly, setHttpOnly] = useState(cookie?.httpOnly ?? false);
  const [hostOnly, setHostOnly] = useState(cookie?.hostOnly ?? true);
  const [sameSite, setSameSite] = useState(cookie?.sameSite ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError('A cookie needs a name.');
    if (!domain.trim()) return setError('A cookie needs a domain.');
    if (!cookie && value === '') return setError('Enter the cookie value.');
    if (expires.trim() && localInputToIso(expires) === null) return setError('The expiry date is not valid.');
    setSaving(true);
    try {
      const attrs = { domain: domain.trim(), path: path.trim() || '/', name: name.trim(), hostOnly, secure, httpOnly, sameSite: sameSite || null, expiresAt: localInputToIso(expires) };
      const saved = cookie ? await api.cookies.update({ id: cookie.id, ...attrs, ...(value !== '' ? { value } : {}) }) : await api.cookies.add({ workspaceId, ...attrs, value });
      setValue('');
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={cookie ? `Edit cookie: ${cookie.name}` : 'Add cookie'}
      width={620}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : cookie ? 'Save' : 'Add cookie'}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}
      <div className="ck-grid">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="session" spellCheck={false} autoFocus />
        </Field>
        <Field label="Value" hint={cookie ? 'Leave empty to keep the stored value.' : 'Stored encrypted in the vault; shown only when revealed.'}>
          <div className="ck-value-row">
            <input type={showValue ? 'text' : 'password'} value={value} onChange={(e) => setValue(e.target.value)} placeholder={cookie ? '(unchanged)' : ''} spellCheck={false} autoComplete="off" />
            <Button size="sm" type="button" onClick={() => setShowValue((v) => !v)} aria-label={showValue ? 'Hide value' : 'Show value'}>
              {showValue ? 'Hide' : 'Show'}
            </Button>
          </div>
        </Field>
        <Field label="Domain" hint="Host name only. A leading dot (.example.com) includes sub-domains.">
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="api.example.com" spellCheck={false} />
        </Field>
        <Field label="Path">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/" spellCheck={false} />
        </Field>
        <Field label="Expires" hint="Empty = session cookie.">
          <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <Field label="SameSite">
          <select value={sameSite} onChange={(e) => setSameSite(e.target.value)}>
            <option value="">(not set)</option>
            <option value="Lax">Lax</option>
            <option value="Strict">Strict</option>
            <option value="None">None (requires Secure)</option>
          </select>
        </Field>
      </div>
      <div className="ck-flags">
        <Checkbox checked={secure} onChange={setSecure} label="Secure (https only)" />
        <Checkbox checked={httpOnly} onChange={setHttpOnly} label="HttpOnly (hidden from scripts)" />
        <Checkbox checked={hostOnly} onChange={setHostOnly} label="Host only (no sub-domains)" />
      </div>
    </Modal>
  );
}

/** Modal-host entry: props `{ workspaceId, cookie? }`. */
export default function CookieEditModal({ props }: ModalComponentProps) {
  const workspaceId = typeof props?.workspaceId === 'string' ? props.workspaceId : '';
  const cookie = props?.cookie && typeof props.cookie === 'object' ? (props.cookie as CookieView) : undefined;
  const close = useCallback(() => useUi.getState().closeModal(), []);
  if (!workspaceId) return null;
  return <CookieEditDialog workspaceId={workspaceId} cookie={cookie} onClose={close} onSaved={close} />;
}
