import { useEffect, useState } from 'react';
import type { HostOverride, HttpVersionPreference } from '@aegis/core';
import { api, errorMessage } from '../../lib/api';
import { bytesToMb, buildPatch, mbToBytes, validateProxyUrl } from '../../lib/settings-helpers';
import { Button, Checkbox, Field } from '../../components/ui';
import { useApp } from '../../store/app';
import { useUi } from '../../store/ui';
import { NumberField, SettingsGroup, TextField, type SectionProps } from './common';
import { normalizeHostOverrides, validateHostOverride } from './hostsOverride';

const HTTP_VERSIONS: Array<{ value: HttpVersionPreference; label: string }> = [
  { value: 'auto', label: 'Auto (HTTP/2 over TLS when offered, else HTTP/1.1)' },
  { value: '2', label: 'Prefer HTTP/2 (TLS only; falls back to 1.1)' },
  { value: '1.1', label: 'HTTP/1.1 only' },
];

export function NetworkSection({ settings, info, save, reload }: SectionProps) {
  const n = settings.network;
  const p = n.proxy;
  const allowInsecure = info?.policy.allowInsecureTls ?? false;
  const [password, setPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const setVerifyTls = async (verify: boolean) => {
    if (!verify) {
      const ok = await useUi.getState().confirm({
        title: 'Disable TLS verification?',
        message: 'Without certificate verification a network attacker can read and modify your requests and responses, including credentials. Only disable this for trusted test servers.',
        confirmLabel: 'Disable verification',
        danger: true,
      });
      if (!ok) return;
    }
    await save(buildPatch(['network', 'verifyTls'], verify));
  };

  const storePassword = async (value: string) => {
    setPwBusy(true);
    try {
      await api.settings.setProxyPassword({ password: value });
      setPassword('');
      await reload();
      useApp.getState().toast(value ? 'Proxy password stored securely' : 'Proxy password removed', 'success');
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'error');
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <>
      <SettingsGroup title="Requests">
        <div className="set-grid">
          <NumberField label="Request timeout" unit="ms" value={n.timeoutMs} min={100} max={3_600_000} onCommit={(v) => void save(buildPatch(['network', 'timeoutMs'], v))} />
          <NumberField label="Maximum redirects" value={n.maxRedirects} min={0} max={50} disabled={!n.followRedirects} onCommit={(v) => void save(buildPatch(['network', 'maxRedirects'], v))} />
          <NumberField label="Maximum response size" unit="MB" value={bytesToMb(n.maxResponseBytes)} min={1} max={Math.max(1, Math.floor(bytesToMb(info?.policy.maxResponseBytes ?? 1024 ** 3)))} hint="Larger responses are cut off. Capped by organization policy." onCommit={(v) => void save(buildPatch(['network', 'maxResponseBytes'], mbToBytes(v)))} />
          <NumberField label="Maximum request size" unit="MB" value={bytesToMb(n.maxRequestBytes)} min={1} max={2048} onCommit={(v) => void save(buildPatch(['network', 'maxRequestBytes'], mbToBytes(v)))} />
        </div>
        <Checkbox checked={n.followRedirects} onChange={(v) => void save(buildPatch(['network', 'followRedirects'], v))} label="Follow redirects" />
        <Field label="HTTP version" hint="Default for every request; the request Settings tab can override it. HTTP/2 is negotiated via ALPN over TLS only (no h2c).">
          <select aria-label="HTTP version" value={n.httpVersion ?? 'auto'} onChange={(e) => void save(buildPatch(['network', 'httpVersion'], e.target.value))}>
            {HTTP_VERSIONS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
      </SettingsGroup>

      <HostOverridesGroup entries={n.hosts ?? []} allowed={info?.policy.allowHostOverrides ?? true} onSave={(hosts) => save(buildPatch(['network', 'hosts'], hosts))} />

      <SettingsGroup title="TLS">
        <Checkbox checked={n.verifyTls} disabled={!allowInsecure && n.verifyTls} onChange={(v) => void setVerifyTls(v)} label="Verify TLS certificates" />
        {!allowInsecure ? (
          <p className="field-hint">Your organization policy requires certificate verification; this cannot be turned off. Use the Certificates section to trust a private CA instead.</p>
        ) : (
          <p className="field-hint">Keep this on. Turning it off should only be done for trusted test servers.</p>
        )}
        {!n.verifyTls && (
          <div className="banner banner-error" role="alert">
            <span>TLS verification is OFF. Connections are not protected against interception. Turn it back on as soon as possible.</span>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Proxy">
        <Field label="Proxy mode">
          <select value={p.mode} onChange={(e) => void save(buildPatch(['network', 'proxy', 'mode'], e.target.value))}>
            <option value="none">No proxy</option>
            <option value="system">Use system proxy settings</option>
            <option value="manual">Manual configuration</option>
          </select>
        </Field>
        {p.mode === 'manual' && (
          <>
            <div className="set-grid">
              <TextField label="HTTP proxy" value={p.httpProxy} placeholder="http://proxy.example.com:8080" validate={validateProxyUrl} onCommit={(v) => void save(buildPatch(['network', 'proxy', 'httpProxy'], v.trim()))} />
              <TextField label="HTTPS proxy" value={p.httpsProxy} placeholder="http://proxy.example.com:8080" validate={validateProxyUrl} onCommit={(v) => void save(buildPatch(['network', 'proxy', 'httpsProxy'], v.trim()))} />
            </div>
            <TextField label="No proxy for" value={p.noProxy} placeholder="localhost, 127.0.0.1, *.internal" hint="Comma-separated hosts that bypass the proxy." onCommit={(v) => void save(buildPatch(['network', 'proxy', 'noProxy'], v.trim()))} />
            <TextField label="Proxy username" value={p.username} onCommit={(v) => void save(buildPatch(['network', 'proxy', 'username'], v))} />
            <div className="field">
              <label className="field-label" htmlFor="proxy-password">
                Proxy password {p.hasPassword ? '(a password is stored)' : '(none stored)'}
              </label>
              <div className="secret-cell">
                <input id="proxy-password" type="password" autoComplete="new-password" value={password} placeholder={p.hasPassword ? 'Enter a new password to replace it' : 'Enter password'} onChange={(e) => setPassword(e.target.value)} />
                <Button size="sm" variant="primary" disabled={!password || pwBusy} onClick={() => void storePassword(password)}>
                  Save password
                </Button>
                {p.hasPassword && (
                  <Button size="sm" disabled={pwBusy} onClick={() => void storePassword('')}>
                    Remove
                  </Button>
                )}
              </div>
              <span className="field-hint">The password is kept in the OS secure storage and is never displayed again.</span>
            </div>
          </>
        )}
      </SettingsGroup>
    </>
  );
}

/**
 * Host overrides: like a private hosts file for the app. Requests to `host` connect to `address`
 * while the Host header, SNI and certificate validation still use `host`. Policy can disable it.
 */
function HostOverridesGroup({ entries, allowed, onSave }: { entries: HostOverride[]; allowed: boolean; onSave(hosts: HostOverride[]): Promise<boolean> }) {
  const [rows, setRows] = useState<HostOverride[]>(entries);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setRows(entries);
    setDirty(false);
  }, [entries]);
  const errors = rows.map((r) => (r.host.trim() === '' && r.address.trim() === '' ? null : validateHostOverride(r)));
  const valid = errors.every((e) => e === null);
  const edit = (i: number, patch: Partial<HostOverride>) => {
    setRows((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const remove = (i: number) => {
    setRows((prev) => prev.filter((_, k) => k !== i));
    setDirty(true);
  };
  const persist = async () => {
    if (await onSave(normalizeHostOverrides(rows))) setDirty(false);
  };

  return (
    <SettingsGroup title="Host overrides" description="Send requests for a host name to a specific IP address without editing the system hosts file (useful for staging). The Host header, SNI and certificate checks keep using the host name; the Timeline shows when an override was used.">
      {!allowed && (
        <div className="banner banner-error" role="alert">
          <span>Your organization policy disables host overrides (allowHostOverrides). Entries below are kept but ignored.</span>
        </div>
      )}
      {rows.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Host name</th>
              <th>Address</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input aria-label={`Override host ${i + 1}`} className="mono" spellCheck={false} value={r.host} placeholder="api.example.com" disabled={!allowed} aria-invalid={errors[i] !== null} onChange={(e) => edit(i, { host: e.target.value })} />
                </td>
                <td>
                  <input aria-label={`Override address ${i + 1}`} className="mono" spellCheck={false} value={r.address} placeholder="10.0.0.5" disabled={!allowed} aria-invalid={errors[i] !== null} onChange={(e) => edit(i, { address: e.target.value })} />
                  {errors[i] && <div className="field-hint field-err">{errors[i]}</div>}
                </td>
                <td>
                  <Button size="sm" variant="ghost" disabled={!allowed} onClick={() => remove(i)}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="set-row">
        <Button
          size="sm"
          disabled={!allowed}
          onClick={() => {
            setRows((prev) => [...prev, { host: '', address: '' }]);
            setDirty(true);
          }}
        >
          Add override
        </Button>
        <Button size="sm" variant="primary" disabled={!allowed || !dirty || !valid} onClick={() => void persist()}>
          Save overrides
        </Button>
        {dirty && valid && <span className="field-hint">Unsaved changes.</span>}
      </div>
    </SettingsGroup>
  );
}
