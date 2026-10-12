import { useCallback, useEffect, useState } from 'react';
import { BACKUP_HISTORY_LIMIT_DEFAULT, BACKUP_HISTORY_LIMIT_MAX, type BackupInfo } from '@aegis/core';
import { api, errorMessage } from '../lib/api';
import { describeBackupSecrets, validateBackupPassphrase } from '../lib/backup-helpers';
import { relativeTime } from '../lib/ui-format';
import { Badge, Button, Checkbox, EmptyState, ErrorBanner, Field, Modal, Spinner, formatBytes } from '../components/ui';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import type { ModalComponentProps } from './ModalHost';
import '../styles/panels.css';

export default function BackupModal(_p: ModalComponentProps) {
  const info = useApp((s) => s.info);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(String(BACKUP_HISTORY_LIMIT_DEFAULT));
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<BackupInfo | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      setBackups(await api.importExport.listBackups());
    } catch (e) {
      setListError(errorMessage(e));
      setBackups([]);
    }
  }, []);
  useEffect(() => {
    void loadList();
  }, [loadList]);

  const passError = validateBackupPassphrase(passphrase, confirm);
  const limitN = /^\d{1,6}$/.test(historyLimit.trim()) && Number(historyLimit) <= BACKUP_HISTORY_LIMIT_MAX ? Number(historyLimit) : null;
  const limitError = includeHistory && limitN === null ? `Enter a whole number from 0 to ${BACKUP_HISTORY_LIMIT_MAX.toLocaleString('en-US')}.` : null;
  const secretNote = describeBackupSecrets(passphrase, info?.policy.allowSecretExport ?? false);

  const create = async () => {
    if (passError || limitError) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    setCancelled(false);
    try {
      const b = await api.importExport.createBackup({ includeHistory, ...(includeHistory && limitN !== null ? { historyLimit: limitN } : {}), ...(passphrase ? { passphrase } : {}) });
      if (b) {
        setCreated(b);
        setPassphrase('');
        setConfirm('');
        await loadList();
      } else {
        setCancelled(true);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => useUi.getState().closeModal();

  return (
    <Modal
      title="Backup"
      width={680}
      onClose={close}
      footer={
        <>
          <Button onClick={() => useUi.getState().openModal('import', { kind: 'backup' })}>Restore from file…</Button>
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      <section>
        <h3>Create backup</h3>
        <p className="field-hint">A backup contains your workspaces, collections and environments as one file. It is stored locally; nothing is uploaded.</p>
        <Checkbox checked={includeHistory} onChange={setIncludeHistory} label="Include request history" />
        {includeHistory && (
          <Field label="History entries per workspace (newest first)" hint={limitError ?? `Default ${BACKUP_HISTORY_LIMIT_DEFAULT.toLocaleString('en-US')}, at most ${BACKUP_HISTORY_LIMIT_MAX.toLocaleString('en-US')}. Older entries are not included in the backup.`}>
            <input value={historyLimit} inputMode="numeric" onChange={(e) => setHistoryLimit(e.target.value)} aria-invalid={limitN === null} />
          </Field>
        )}
        <div className="env-details-grid" style={{ marginTop: 12 }}>
          <Field label="Passphrase (optional)">
            <input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
          <Field label="Confirm passphrase">
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        </div>
        {passError && (
          <div className="field-hint" role="alert" style={{ color: 'var(--danger)' }}>
            {passError}
          </div>
        )}
        <p className="field-hint">{secretNote}</p>
        <Button variant="primary" disabled={busy || passError !== null || limitError !== null} onClick={() => void create()}>
          {busy ? 'Creating…' : 'Create backup…'}
        </Button>
        {error && <ErrorBanner message={error} />}
        {created && (
          <div className="banner exp-ok" role="status">
            Backup saved: <code className="mono">{created.path}</code> ({formatBytes(created.sizeBytes)}
            {created.encrypted ? ', encrypted' : ''})
          </div>
        )}
        {cancelled && <div className="field-hint">Backup cancelled.</div>}
      </section>

      <section style={{ marginTop: 20 }}>
        <h3>Existing backups</h3>
        {backups === null ? (
          <Spinner label="Loading backups" />
        ) : listError ? (
          <ErrorBanner message={listError} onRetry={() => void loadList()} />
        ) : backups.length === 0 ? (
          <EmptyState title="No backups yet">Backups you create appear here.</EmptyState>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Created</th>
                <th>Contents</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <td className="mono" title={b.path}>
                    {b.fileName}
                  </td>
                  <td>{formatBytes(b.sizeBytes)}</td>
                  <td title={b.createdAt}>{relativeTime(b.createdAt)}</td>
                  <td>
                    {b.encrypted ? <Badge tone="success">encrypted</Badge> : <Badge>plain</Badge>} {b.includesHistory && <Badge tone="info">history</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Modal>
  );
}
