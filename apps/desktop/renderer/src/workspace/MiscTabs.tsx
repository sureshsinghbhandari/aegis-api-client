import type { AuthConfig, RequestSettings } from '@aegis/core';
import { useEffect, useState } from 'react';
import { AuthEditor } from '../components/AuthEditor';
import { Spinner } from '../components/ui';
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
  const follow = settings.followRedirects;

  return (
    <div className="wb-pane-scroll wb-settings">
      <label className="field">
        <span className="field-label">Request timeout (ms)</span>
        <input type="number" min={0} aria-label="Request timeout in milliseconds" value={settings.timeoutMs ?? ''} placeholder={defaults ? String(defaults.timeoutMs) : 'default'} onChange={(e) => set({ timeoutMs: numberOrUndefined(e.target.value) })} />
        <span className="field-hint">Empty uses the application default{defaults ? ` (${defaults.timeoutMs} ms)` : ''}.</span>
      </label>
      <label className="field">
        <span className="field-label">Follow redirects</span>
        <select aria-label="Follow redirects" value={follow === undefined ? 'default' : follow ? 'yes' : 'no'} onChange={(e) => set({ followRedirects: e.target.value === 'default' ? undefined : e.target.value === 'yes' })}>
          <option value="default">Default{defaults ? ` (${defaults.followRedirects ? 'yes' : 'no'})` : ''}</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Maximum redirects</span>
        <input type="number" min={0} max={50} aria-label="Maximum redirects" value={settings.maxRedirects ?? ''} placeholder={defaults ? String(defaults.maxRedirects) : 'default'} onChange={(e) => set({ maxRedirects: numberOrUndefined(e.target.value) })} />
      </label>
      <div className="field">
        <span className="field-label">TLS certificate verification</span>
        <span className="wb-readonly">{defaults?.verifyTls === false && policy?.allowInsecureTls ? 'Disabled globally (allowed by policy)' : 'Enabled'}</span>
        <span className="field-hint">
          Certificate verification cannot be turned off per request. Add trusted CAs or client certificates under Settings → Certificates.
          {policy && !policy.allowInsecureTls ? ' Your organization policy does not allow disabling verification.' : ''}
        </span>
      </div>
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
