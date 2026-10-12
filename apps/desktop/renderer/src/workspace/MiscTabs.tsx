import type { AuthConfig, RequestSettings } from '@aegis/core';
import { useEffect, useState } from 'react';
import { AuthEditor } from '../components/AuthEditor';
import { Badge, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useApp, type OpenTab } from '../store/app';
import { useDraftUpdate } from './useDraft';

export function AuthTab({ tab }: { tab: OpenTab }) {
  const update = useDraftUpdate(tab);
  const workspaceId = useApp((s) => s.workspaceId);
  const { draft } = tab;
  const [inherited, setInherited] = useState<{ requestId: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Describe where inherited auth comes from (only meaningful for saved requests).
  useEffect(() => {
    if (!tab.requestId || draft.auth.type !== 'inherit') return;
    let cancelled = false;
    setError(null);
    api.requests
      .effectiveAuth({ id: tab.requestId })
      .then((res) => !cancelled && setInherited({ requestId: tab.requestId!, text: `${res.source} (${res.auth.type === 'none' ? 'No Auth' : res.auth.type})` }))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [tab.requestId, draft.auth.type, tab.folderId, tab.collectionId]);

  const inheritedFrom = tab.requestId && inherited?.requestId === tab.requestId ? inherited.text : undefined;

  return (
    <div className="wb-pane-scroll">
      <AuthEditor
        value={draft.auth}
        onChange={(auth: AuthConfig) => update({ auth })}
        allowInherit
        {...(inheritedFrom ? { inheritedFrom } : {})}
        {...(workspaceId ? { oauthContext: { workspaceId, ...(tab.requestId ? { requestId: tab.requestId } : {}), ...(tab.collectionId ? { collectionId: tab.collectionId } : {}), ...(tab.folderId ? { folderId: tab.folderId } : {}) } } : {})}
      />
      {draft.auth.type === 'inherit' && !tab.requestId && <p className="wb-hint">Save the request into a collection to see which parent authorization applies.</p>}
      {error && <p className="wb-hint">Could not determine the inherited authorization: {error}</p>}
      {draft.auth.type === 'inherit' && tab.requestId && !inheritedFrom && !error && (
        <p className="wb-hint">
          <Spinner label="Loading" /> Looking up inherited authorization…
        </p>
      )}
    </div>
  );
}

/** Tri-state select for an optional boolean request setting (default / yes / no). */
function TriState({ label, value, defaultValue, hint, onChange }: { label: string; value: boolean | undefined; defaultValue?: boolean; hint?: string; onChange(v: boolean | undefined): void }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select aria-label={label} value={value === undefined ? 'default' : value ? 'yes' : 'no'} onChange={(e) => onChange(e.target.value === 'default' ? undefined : e.target.value === 'yes')}>
        <option value="default">Default{defaultValue !== undefined ? ` (${defaultValue ? 'yes' : 'no'})` : ''}</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

const MB = 1024 * 1024;

export function SettingsTab({ tab }: { tab: OpenTab }) {
  const update = useDraftUpdate(tab);
  const defaults = useApp((s) => s.settings?.network);
  const policy = useApp((s) => s.info?.policy);
  const { settings } = tab.draft;
  const set = (patch: Partial<RequestSettings>) => {
    const next: RequestSettings = { ...settings, ...patch };
    for (const k of Object.keys(next) as Array<keyof RequestSettings>) if (next[k] === undefined) delete next[k];
    update({ settings: next });
  };
  const numberOrUndefined = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() === '' || !Number.isFinite(n) || n < 0 ? undefined : Math.floor(n);
  };
  const insecureAllowed = policy?.allowInsecureTls ?? false;
  const globalVerify = defaults?.verifyTls !== false;
  const verify = settings.verifyTls;
  const maxResponseCapMb = Math.max(1, Math.floor((defaults?.maxResponseBytes ?? 100 * MB) / MB));

  return (
    <div className="wb-pane-scroll wb-settings">
      <label className="field">
        <span className="field-label">Request timeout (ms)</span>
        <input type="number" min={0} aria-label="Request timeout in milliseconds" value={settings.timeoutMs ?? ''} placeholder={defaults ? String(defaults.timeoutMs) : 'default'} onChange={(e) => set({ timeoutMs: numberOrUndefined(e.target.value) })} />
        <span className="field-hint">Empty uses the application default{defaults ? ` (${defaults.timeoutMs} ms)` : ''}.</span>
      </label>
      <label className="field">
        <span className="field-label">Maximum response size (MB)</span>
        <input
          type="number"
          min={1}
          max={maxResponseCapMb}
          aria-label="Maximum response size in megabytes"
          value={settings.maxResponseBytes !== undefined ? Math.max(1, Math.round(settings.maxResponseBytes / MB)) : ''}
          placeholder={String(maxResponseCapMb)}
          onChange={(e) => {
            const n = numberOrUndefined(e.target.value);
            set({ maxResponseBytes: n === undefined ? undefined : Math.min(n, maxResponseCapMb) * MB });
          }}
        />
        <span className="field-hint">Larger responses are aborted. Capped by the global setting and organization policy ({maxResponseCapMb} MB).</span>
      </label>

      <TriState label="Follow redirects" value={settings.followRedirects} {...(defaults ? { defaultValue: defaults.followRedirects } : {})} onChange={(v) => set({ followRedirects: v })} />
      <label className="field">
        <span className="field-label">Maximum redirects</span>
        <input type="number" min={0} max={50} aria-label="Maximum redirects" value={settings.maxRedirects ?? ''} placeholder={defaults ? String(defaults.maxRedirects) : 'default'} onChange={(e) => set({ maxRedirects: numberOrUndefined(e.target.value) })} />
      </label>
      <TriState label="Follow original HTTP method" value={settings.followOriginalHttpMethod} defaultValue={false} hint="Keep the method and body on 301/302/303 redirects instead of switching to GET." onChange={(v) => set({ followOriginalHttpMethod: v })} />
      <TriState label="Follow Authorization header" value={settings.followAuthorizationHeader} defaultValue={false} hint="Keep the Authorization header when a redirect leaves the origin. Off by default: credentials are not sent to other hosts." onChange={(v) => set({ followAuthorizationHeader: v })} />
      {settings.followAuthorizationHeader && (
        <div className="banner banner-error" role="alert">
          <span>Credentials will be forwarded to any host this request is redirected to. A warning is shown in the Timeline on every send.</span>
        </div>
      )}
      <TriState label="Remove Referer header on redirect" value={settings.removeRefererHeaderOnRedirect} defaultValue={false} onChange={(v) => set({ removeRefererHeaderOnRedirect: v })} />

      <TriState label="Encode URL automatically" value={settings.encodeUrl} defaultValue={true} hint="Off sends query keys and values as typed (no percent-encoding)." onChange={(v) => set({ encodeUrl: v })} />
      <TriState label="Disable cookie jar" value={settings.disableCookies} defaultValue={false} hint="On: no stored cookies are sent and Set-Cookie responses are not stored for this request." onChange={(v) => set({ disableCookies: v })} />

      <label className="field">
        <span className="field-label">HTTP version</span>
        <select aria-label="HTTP version" value={settings.httpVersion ?? 'default'} onChange={(e) => set({ httpVersion: e.target.value === 'default' ? undefined : (e.target.value as RequestSettings['httpVersion']) })}>
          <option value="default">Default{defaults?.httpVersion ? ` (${defaults.httpVersion === 'auto' ? 'auto' : defaults.httpVersion === '2' ? 'prefer HTTP/2' : 'HTTP/1.1'})` : ''}</option>
          <option value="auto">Auto (HTTP/2 over TLS when offered)</option>
          <option value="2">Prefer HTTP/2</option>
          <option value="1.1">HTTP/1.1 only</option>
        </select>
        <span className="field-hint">HTTP/2 is negotiated via ALPN over TLS; plain http always uses HTTP/1.1. The negotiated version is shown in the Timeline.</span>
      </label>

      <label className="field">
        <span className="field-label">
          TLS certificate verification {!insecureAllowed && <Badge tone="info">enforced by policy</Badge>}
        </span>
        <select aria-label="TLS certificate verification" value={verify === undefined ? 'default' : verify ? 'yes' : 'no'} disabled={!insecureAllowed} onChange={(e) => set({ verifyTls: e.target.value === 'default' ? undefined : e.target.value === 'yes' })}>
          <option value="default">Default ({globalVerify ? 'enabled' : 'disabled globally'})</option>
          <option value="yes">Enabled</option>
          <option value="no">Disabled (insecure)</option>
        </select>
        <span className="field-hint">
          {insecureAllowed
            ? 'Disabling verification lets anyone on the network read and modify this request. Every such send is flagged in the Timeline.'
            : 'Your organization policy requires certificate verification; a stored "off" value is ignored and reported when sending. Add trusted CAs or client certificates under Settings → Certificates.'}
        </span>
      </label>
      {insecureAllowed && verify === false && (
        <div className="banner banner-error" role="alert">
          <span>TLS verification is OFF for this request. Connections are not protected against interception.</span>
        </div>
      )}
    </div>
  );
}

export function DocsTab({ tab }: { tab: OpenTab }) {
  const update = useDraftUpdate(tab);
  return (
    <div className="wb-pane-scroll wb-docs">
      <textarea aria-label="Request description" placeholder="Describe this request: purpose, expected inputs and outputs…" value={tab.draft.description} onChange={(e) => update({ description: e.target.value })} />
    </div>
  );
}
