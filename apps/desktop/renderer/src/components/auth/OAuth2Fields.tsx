import type { AuthConfig, AuthParamValue } from '@aegis/core';
import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useApp } from '../../store/app';
import { Badge, Button, Spinner } from '../ui';
import { AuthRow, SecretParam, SelectParam, TextParam } from './AuthRow';
import { describeExpiry, OAUTH2_GRANTS, oauthTokenStatus, param } from './authModel';

export interface OAuthContext {
  workspaceId: string;
  requestId?: string;
  collectionId?: string;
  folderId?: string;
}

const TOKEN_KEYS = ['accessToken', 'refreshToken', 'tokenType', 'expiresAt'];

export function OAuth2Fields({ auth, set, onChange, context }: { auth: AuthConfig; set(key: string, value: AuthParamValue): void; onChange(v: AuthConfig): void; context?: OAuthContext }) {
  const storeWorkspace = useApp((s) => s.workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grant = param(auth, 'grant_type', 'authorization_code_with_pkce');
  const interactive = grant === 'authorization_code' || grant === 'authorization_code_with_pkce';
  const status = oauthTokenStatus(auth);
  const workspaceId = context?.workspaceId ?? storeWorkspace;
  const common = { auth, set };

  const getToken = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.tools.oauth2GetToken({
        auth,
        workspaceId,
        ...(context?.requestId ? { requestId: context.requestId } : {}),
        ...(context?.collectionId ? { collectionId: context.collectionId } : {}),
        ...(context?.folderId ? { folderId: context.folderId } : {}),
      });
      onChange({ ...auth, params: { ...auth.params, ...res.params } });
      useApp.getState().toast('Access token received', 'success');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const clearToken = () => {
    const params = { ...auth.params };
    for (const k of TOKEN_KEYS) delete params[k];
    onChange({ ...auth, params });
  };

  return (
    <>
      <SelectParam {...common} name="grant_type" label="Grant type" fallback="authorization_code_with_pkce" options={OAUTH2_GRANTS} />
      {interactive && <TextParam {...common} name="authUrl" label="Auth URL" placeholder="https://example.com/oauth/authorize" />}
      <TextParam {...common} name="accessTokenUrl" label="Access token URL" placeholder="https://example.com/oauth/token" />
      {interactive && <TextParam {...common} name="redirect_uri" label="Callback URL" placeholder="http://localhost:8080/callback" hint="Must match the redirect URI registered for the client." />}
      <TextParam {...common} name="clientId" label="Client ID" />
      <SecretParam {...common} name="clientSecret" label="Client secret" />
      {grant === 'password_credentials' && (
        <>
          <TextParam {...common} name="username" label="Username" />
          <SecretParam {...common} name="password" label="Password" />
        </>
      )}
      <TextParam {...common} name="scope" label="Scope" placeholder="read write" />
      <SelectParam
        {...common}
        name="client_authentication"
        label="Client authentication"
        fallback="header"
        options={[
          { value: 'header', label: 'Send as Basic Auth header' },
          { value: 'body', label: 'Send client credentials in body' },
        ]}
      />
      <SelectParam
        {...common}
        name="addTokenTo"
        label="Add token to"
        fallback="header"
        options={[
          { value: 'header', label: 'Request headers' },
          { value: 'queryParams', label: 'Query parameters' },
        ]}
      />
      {param(auth, 'addTokenTo', 'header') === 'header' && <TextParam {...common} name="headerPrefix" label="Header prefix" placeholder="Bearer" />}

      <AuthRow label="Access token">
        <div className="au-token">
          {status.state === 'none' ? (
            <Badge>No token</Badge>
          ) : (
            <Badge tone={status.expired ? 'danger' : 'success'}>{status.expired ? 'Expired' : 'Token present'}</Badge>
          )}
          {status.state === 'present' && status.expiresAt !== undefined && <span className="au-dim">{describeExpiry(status.expiresAt)}</span>}
          {param(auth, 'refreshToken') !== '' && <span className="au-dim">refresh token stored</span>}
          <span className="au-spacer" />
          <Button variant="primary" size="sm" disabled={busy || !workspaceId} onClick={() => void getToken()}>
            {busy ? <Spinner label="Requesting token" /> : null} Get New Access Token
          </Button>
          <Button size="sm" disabled={status.state === 'none' && param(auth, 'refreshToken') === ''} onClick={clearToken}>
            Clear token
          </Button>
        </div>
        {busy && interactive && <div className="field-hint">Complete the sign-in in the window that opened. This can take a while.</div>}
        {error && (
          <div className="banner banner-error" role="alert">
            <span>{error}</span>
          </div>
        )}
      </AuthRow>
      <SecretParam {...common} name="accessToken" label="Token value" hint="Paste a token manually, or use Get New Access Token. Never shown once stored." />
    </>
  );
}
