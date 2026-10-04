import { useCallback, useEffect, useState } from 'react';
import type { CertificateView } from '@aegis/core';
import { api, errorMessage } from '../../lib/api';
import { looksLikePem } from '../../lib/settings-helpers';
import { relativeTime } from '../../lib/ui-format';
import { Badge, Button, EmptyState, ErrorBanner, Field, Spinner } from '../../components/ui';
import { useApp } from '../../store/app';
import { useUi } from '../../store/ui';
import { SettingsGroup } from './common';

type Kind = 'ca' | 'client';

export function CertificatesSection() {
  const [certs, setCerts] = useState<CertificateView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<Kind | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCerts(await api.certificates.list());
    } catch (e) {
      setError(errorMessage(e));
      setCerts([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (c: CertificateView) => {
    try {
      await api.certificates.setEnabled({ id: c.id, enabled: !c.enabled });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const remove = async (c: CertificateView) => {
    const ok = await useUi.getState().confirm({ title: 'Delete certificate', message: `Delete the ${c.kind === 'ca' ? 'CA' : 'client'} certificate "${c.name}"? Its private key and passphrase are removed too.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.certificates.delete({ id: c.id });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <SettingsGroup title="Certificates" description="Add a private CA so servers signed by it are trusted, or a client certificate for mutual TLS. Private keys and passphrases are stored in the OS secure storage.">
        <div className="set-row">
          <Button size="sm" variant="primary" onClick={() => setAdding('ca')}>
            Add CA certificate…
          </Button>
          <Button size="sm" onClick={() => setAdding('client')}>
            Add client certificate…
          </Button>
        </div>
        {error && <ErrorBanner message={error} onRetry={() => void load()} />}
        {certs === null ? (
          <Spinner label="Loading certificates" />
        ) : certs.length === 0 ? (
          <EmptyState title="No custom certificates">The system trust store is used.</EmptyState>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Hosts</th>
                <th>Added</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    <Badge tone={c.kind === 'ca' ? 'info' : 'neutral'}>{c.kind === 'ca' ? 'CA' : 'Client'}</Badge> {c.kind === 'client' && (c.hasKey || c.hasPfx) && <Badge tone="success">key stored</Badge>}
                  </td>
                  <td className="mono">{c.hostPattern || '*'}</td>
                  <td>{relativeTime(c.createdAt)}</td>
                  <td>
                    <input type="checkbox" aria-label={`Enable ${c.name}`} checked={c.enabled} onChange={() => void toggle(c)} />
                  </td>
                  <td>
                    <Button size="sm" variant="ghost" onClick={() => void remove(c)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsGroup>
      {adding && (
        <AddCertificate
          kind={adding}
          onClose={() => setAdding(null)}
          onAdded={() => {
            setAdding(null);
            void load();
          }}
        />
      )}
    </>
  );
}

function AddCertificate({ kind, onClose, onAdded }: { kind: Kind; onClose(): void; onAdded(): void }) {
  const [name, setName] = useState('');
  const [hostPattern, setHostPattern] = useState('');
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = async (purpose: 'certificate' | 'key') => {
    try {
      const f = await api.certificates.pickFile({ purpose });
      if (!f) return;
      if (purpose === 'certificate') {
        setCertPem(f.content);
        if (!name) setName(f.name.replace(/\.[^.]+$/, ''));
      } else {
        setKeyPem(f.content);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const certOk = looksLikePem(certPem, 'CERTIFICATE');
  const keyOk = kind === 'ca' || looksLikePem(keyPem, 'PRIVATE KEY');
  const valid = name.trim() !== '' && certOk && keyOk;

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.certificates.add({
        kind,
        name: name.trim(),
        ...(hostPattern.trim() ? { hostPattern: hostPattern.trim() } : {}),
        certPem,
        ...(kind === 'client' ? { keyPem, ...(passphrase ? { passphrase } : {}) } : {}),
      });
      useApp.getState().toast('Certificate added', 'success');
      setKeyPem('');
      setPassphrase('');
      onAdded();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title={kind === 'ca' ? 'Add CA certificate' : 'Add client certificate'}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'ca' ? 'Corporate root CA' : 'Service account'} />
      </Field>
      {kind === 'client' && (
        <Field label="Host pattern" hint="Which hosts get this certificate, e.g. api.example.com or *.example.com. Empty = all hosts.">
          <input value={hostPattern} onChange={(e) => setHostPattern(e.target.value)} placeholder="*.example.com" />
        </Field>
      )}
      <div className="field">
        <span className="field-label">Certificate (PEM)</span>
        <textarea rows={5} className="mono" spellCheck={false} value={certPem} onChange={(e) => setCertPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" aria-label="Certificate PEM" />
        <div className="set-row">
          <Button size="sm" onClick={() => void pickFile('certificate')}>
            Choose file…
          </Button>
          {certPem && !certOk && <span className="field-hint field-err">This does not look like a PEM certificate.</span>}
        </div>
      </div>
      {kind === 'client' && (
        <>
          <div className="field">
            <span className="field-label">Private key (PEM)</span>
            <textarea rows={4} className="mono" spellCheck={false} value={keyPem} onChange={(e) => setKeyPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" aria-label="Private key PEM" />
            <div className="set-row">
              <Button size="sm" onClick={() => void pickFile('key')}>
                Choose file…
              </Button>
              {keyPem && !keyOk && <span className="field-hint field-err">This does not look like a PEM private key.</span>}
            </div>
          </div>
          <Field label="Key passphrase (optional)">
            <input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
        </>
      )}
      {error && <ErrorBanner message={error} />}
      <div className="set-row">
        <Button variant="primary" disabled={!valid || busy} onClick={() => void add()}>
          Add certificate
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </SettingsGroup>
  );
}
