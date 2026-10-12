import type { AuthConfig, AuthParamValue } from '@aegis/core';
import { Checkbox } from '../ui';
import { AuthRow, SecretParam, SelectParam, TextParam } from './AuthRow';
import { ASAP_ALGORITHMS, DIGEST_ALGORITHMS, HAWK_ALGORITHMS, jsonError, param, paramBool } from './authModel';

/**
 * Forms for the Postman-compatible "custom" providers (Digest, Hawk, Akamai EdgeGrid, ASAP).
 * Parameter keys are Postman's so imported collections execute and round-trip unchanged.
 */

type Props = { auth: AuthConfig; set(key: string, value: AuthParamValue): void };

const opt = (values: readonly string[]) => values.map((v) => ({ value: v, label: v }));

export function DigestFields({ auth, set }: Props) {
  const common = { auth, set };
  return (
    <>
      <TextParam {...common} name="username" label="Username" />
      <SecretParam {...common} name="password" label="Password" />
      <SelectParam {...common} name="algorithm" label="Algorithm" fallback="MD5" options={opt(DIGEST_ALGORITHMS)} hint="Preferred algorithm when the server offers several; the server's challenge decides." />
      <SelectParam
        {...common}
        name="qop"
        label="Quality of protection"
        fallback="auth"
        options={[
          { value: 'auth', label: 'auth' },
          { value: 'auth-int', label: 'auth-int (also hashes the body)' },
        ]}
      />
      <TextParam {...common} name="realm" label="Realm" hint="Optional. Taken from the server's challenge when empty." />
      <TextParam {...common} name="nonce" label="Nonce" hint="Optional. Leave empty to let the request obtain a challenge (401) and retry with credentials automatically." />
      <TextParam {...common} name="opaque" label="Opaque" />
      <TextParam {...common} name="nonceCount" label="Nonce count" placeholder="00000001" />
      <TextParam {...common} name="clientNonce" label="Client nonce" placeholder="generated per request" />
      <AuthRow label="Options">
        <Checkbox checked={paramBool(auth, 'disableRetryRequest')} onChange={(v) => set('disableRetryRequest', v)} label="Do not retry after a 401 challenge (requires a nonce above)" />
      </AuthRow>
    </>
  );
}

export function HawkFields({ auth, set }: Props) {
  const common = { auth, set };
  return (
    <>
      <TextParam {...common} name="authId" label="Hawk auth ID" />
      <SecretParam {...common} name="authKey" label="Hawk auth key" />
      <SelectParam {...common} name="algorithm" label="Algorithm" fallback="sha256" options={opt(HAWK_ALGORITHMS)} />
      <TextParam {...common} name="user" label="User" hint="Optional, informational." />
      <TextParam {...common} name="nonce" label="Nonce" placeholder="generated per request" />
      <TextParam {...common} name="extraData" label="ext" hint="Application-specific data included in the MAC." />
      <TextParam {...common} name="app" label="app" hint="Oz application id (optional)." />
      <TextParam {...common} name="delegation" label="dlg" hint="Delegated-by application id (optional)." />
      <TextParam {...common} name="timestamp" label="Timestamp" placeholder="now (epoch seconds)" />
      <AuthRow label="Options">
        <Checkbox checked={paramBool(auth, 'includePayloadHash')} onChange={(v) => set('includePayloadHash', v)} label="Include payload hash (text and form bodies)" />
      </AuthRow>
    </>
  );
}

export function EdgeGridFields({ auth, set }: Props) {
  const common = { auth, set };
  return (
    <>
      <TextParam {...common} name="accessToken" label="Access token" />
      <TextParam {...common} name="clientToken" label="Client token" />
      <SecretParam {...common} name="clientSecret" label="Client secret" />
      <TextParam {...common} name="baseURL" label="Base URL" hint="Optional host override used for signing (from your .edgerc)." />
      <TextParam {...common} name="headersToSign" label="Headers to sign" placeholder="X-Header-A, X-Header-B" hint="Comma-separated request header names included in the signature, in this order." />
      <TextParam {...common} name="maxBodySize" label="Max body size" placeholder="131072" hint="POST bodies are hashed up to this many bytes." />
      <TextParam {...common} name="nonce" label="Nonce" placeholder="generated per request" />
      <TextParam {...common} name="timestamp" label="Timestamp" placeholder="now (yyyyMMddTHH:mm:ss+0000)" />
    </>
  );
}

export function AsapFields({ auth, set }: Props) {
  const common = { auth, set };
  const claims = param(auth, 'claims');
  const claimsError = jsonError(claims);
  return (
    <>
      <SelectParam {...common} name="alg" label="Algorithm" fallback="RS256" options={opt(ASAP_ALGORITHMS)} />
      <TextParam {...common} name="iss" label="Issuer (iss)" />
      <TextParam {...common} name="aud" label="Audience (aud)" placeholder="service-a, service-b" />
      <TextParam {...common} name="kid" label="Key ID (kid)" />
      <SecretParam {...common} name="privateKey" label="Private key" multiline hint="PEM, or a data: URI with the base64 DER key." />
      <TextParam {...common} name="sub" label="Subject (sub)" placeholder="defaults to the issuer" />
      <TextParam {...common} name="exp" label="Expiry" placeholder="1h" hint="Token lifetime: seconds or 30s / 15m / 1h (max 24h)." />
      <AuthRow label="Additional claims" hint={claimsError ?? 'Optional JSON object merged into the token claims.'}>
        <textarea aria-label="ASAP additional claims" className="mono au-multiline" rows={3} spellCheck={false} value={claims} onChange={(e) => set('claims', e.target.value)} aria-invalid={claimsError !== null} />
      </AuthRow>
    </>
  );
}
