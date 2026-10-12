import type { AuthConfig, AuthParamValue } from '@aegis/core';
import { useRef } from 'react';
import { AuthRow, SecretParam, SelectParam, TextParam } from './auth/AuthRow';
import { AUTH_SELECT_OPTIONS, authFromSelectValue, authSelectValue, customProviderId, isExecutableCustom, OAUTH1_SIGNATURES, param, paramBool, withParam, type AuthSelectValue } from './auth/authModel';
import { JwtFields } from './auth/JwtFields';
import { OAuth2Fields, type OAuthContext } from './auth/OAuth2Fields';
import { AsapFields, DigestFields, EdgeGridFields, HawkFields } from './auth/ProviderFields';
import { SecretField } from './auth/SecretField';
import { TokenDecoder } from './auth/TokenDecoder';
import { Checkbox } from './ui';
import '../styles/workbench.css';

export interface AuthEditorProps {
  value: AuthConfig;
  onChange(v: AuthConfig): void;
  allowInherit?: boolean;
  inheritedFrom?: string;
  oauthContext?: { workspaceId: string; requestId?: string; collectionId?: string; folderId?: string };
}

/** Authorization editor shared by requests, folders and collections. Secrets are never displayed (see SecretField). */
export function AuthEditor({ value, onChange, allowInherit, inheritedFrom, oauthContext }: AuthEditorProps) {
  // Remember what was entered per type so switching back and forth does not lose (stored) credentials.
  // Keyed by the selector value, so `custom:digest` and `custom:hawk` keep separate parameters.
  const cache = useRef<Partial<Record<string, AuthConfig['params']>>>({});
  const selected = authSelectValue(value);
  const types = AUTH_SELECT_OPTIONS.filter((o) => o.value !== 'inherit' || allowInherit || value.type === 'inherit');
  const set = (key: string, v: AuthParamValue) => onChange(withParam(value, key, v));
  const common = { auth: value, set };
  const providerId = customProviderId(value);

  const changeType = (next: AuthSelectValue) => {
    if (next === selected) return;
    cache.current[selected] = value.params;
    onChange(authFromSelectValue(next, cache.current[next]));
  };

  return (
    <div className="au-form">
      <AuthRow label="Type">
        <select aria-label="Authorization type" value={selected} onChange={(e) => changeType(e.target.value as AuthSelectValue)}>
          {types.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </AuthRow>

      {value.type === 'inherit' && <div className="au-note">{inheritedFrom ? `Inheriting authorization from ${inheritedFrom}.` : 'Inherits the authorization of the parent folder or collection.'}</div>}
      {value.type === 'none' && <div className="au-note">This request does not use any authorization.</div>}

      {value.type === 'basic' && (
        <>
          <TextParam {...common} name="username" label="Username" />
          <SecretParam {...common} name="password" label="Password" />
        </>
      )}

      {value.type === 'bearer' && (
        <>
          <AuthRow label="Token">
            <SecretField label="Token" value={param(value, 'token')} onChange={(v) => set('token', v)} placeholder="Token or {{variable}}" />
            <TokenDecoder token={param(value, 'token')} />
          </AuthRow>
        </>
      )}

      {value.type === 'apikey' && (
        <>
          <TextParam {...common} name="key" label="Key" placeholder="X-API-Key" />
          <SecretParam {...common} name="value" label="Value" />
          <SelectParam
            {...common}
            name="in"
            label="Add to"
            fallback="header"
            options={[
              { value: 'header', label: 'Header' },
              { value: 'query', label: 'Query params' },
            ]}
          />
        </>
      )}

      {value.type === 'oauth2' && <OAuth2Fields auth={value} set={set} onChange={onChange} {...(oauthContext ? { context: oauthContext as OAuthContext } : {})} />}

      {value.type === 'oauth1' && (
        <>
          <SelectParam {...common} name="signatureMethod" label="Signature method" fallback="HMAC-SHA1" options={OAUTH1_SIGNATURES.map((s) => ({ value: s, label: s }))} />
          <TextParam {...common} name="consumerKey" label="Consumer key" />
          {param(value, 'signatureMethod', 'HMAC-SHA1').toUpperCase().startsWith('RSA-') ? (
            <SecretParam {...common} name="privateKey" label="Private key (PEM)" multiline hint="RSA signature methods sign with this key; the consumer secret is not used." />
          ) : (
            <SecretParam {...common} name="consumerSecret" label="Consumer secret" />
          )}
          <TextParam {...common} name="token" label="Access token" />
          <SecretParam {...common} name="tokenSecret" label="Token secret" />
          <TextParam {...common} name="realm" label="Realm" />
          <TextParam {...common} name="callback" label="Callback URL" />
          <TextParam {...common} name="verifier" label="Verifier" />
          <AuthRow label="Options">
            <Checkbox checked={paramBool(value, 'includeBodyHash')} onChange={(v) => set('includeBodyHash', v)} label="Include body hash" />
            <Checkbox checked={value.params.addParamsToHeader === undefined ? true : paramBool(value, 'addParamsToHeader')} onChange={(v) => set('addParamsToHeader', v)} label="Send parameters in the Authorization header" />
          </AuthRow>
        </>
      )}

      {value.type === 'jwt' && <JwtFields auth={value} set={set} />}

      {value.type === 'awsv4' && (
        <>
          <TextParam {...common} name="accessKey" label="Access key" />
          <SecretParam {...common} name="secretKey" label="Secret key" />
          <TextParam {...common} name="region" label="Region" placeholder="inferred from the host, else us-east-1" />
          <TextParam {...common} name="service" label="Service name" placeholder="inferred from the host, else execute-api" />
          <SecretParam {...common} name="sessionToken" label="Session token" hint="Optional, for temporary credentials." />
        </>
      )}

      {providerId === 'digest' && <DigestFields auth={value} set={set} />}
      {providerId === 'hawk' && <HawkFields auth={value} set={set} />}
      {providerId === 'edgegrid' && <EdgeGridFields auth={value} set={set} />}
      {providerId === 'asap' && <AsapFields auth={value} set={set} />}

      {value.type === 'custom' && !isExecutableCustom(value) && (
        <div className="au-note">
          This authorization type was imported from another tool and is not supported here. It is preserved when you export the collection, but it is <strong>not executed</strong> when sending requests.
          {Object.keys(value.params).length > 0 && <div className="au-dim">Preserved parameters: {Object.keys(value.params).join(', ')}</div>}
        </div>
      )}

      {value.type !== 'inherit' && value.type !== 'none' && (value.type !== 'custom' || isExecutableCustom(value)) && <div className="au-info">Variables such as {'{{token}}'} are resolved at send time. Credentials you type are stored in secure storage when you save.</div>}
    </div>
  );
}
