import type { AuthConfig, AuthParamValue } from '@aegis/core';
import { Checkbox } from '../ui';
import { AuthRow, SecretParam, SelectParam, TextParam } from './AuthRow';
import { isAsymmetricJwtAlgorithm, JWT_ALGORITHMS, jsonError, param, paramBool } from './authModel';

export function JwtFields({ auth, set }: { auth: AuthConfig; set(key: string, value: AuthParamValue): void }) {
  const common = { auth, set };
  const algorithm = param(auth, 'algorithm', 'HS256');
  // RS*, ES* and PS* are signed with a private key; HS* with a shared secret.
  const rsa = isAsymmetricJwtAlgorithm(algorithm);
  const payload = param(auth, 'payload', '{}');
  const header = param(auth, 'header');
  const payloadError = jsonError(payload);
  const headerError = jsonError(header);
  const inQuery = param(auth, 'addTokenTo', 'header').startsWith('query');

  return (
    <>
      <SelectParam {...common} name="algorithm" label="Algorithm" fallback="HS256" options={JWT_ALGORITHMS.map((a) => ({ value: a, label: a }))} />
      {rsa ? (
        <SecretParam {...common} name="privateKey" label="Private key (PEM)" multiline />
      ) : (
        <>
          <SecretParam {...common} name="secret" label="Secret" />
          <AuthRow label="Secret encoding">
            <Checkbox checked={paramBool(auth, 'isSecretBase64Encoded')} onChange={(v) => set('isSecretBase64Encoded', v)} label="Secret is Base64 encoded" />
          </AuthRow>
        </>
      )}
      <AuthRow label="Payload" hint={payloadError ?? 'JSON claims. The token is signed when the request is sent; {{variables}} are resolved first.'}>
        <textarea aria-label="JWT payload" className="mono au-multiline" rows={6} spellCheck={false} value={payload} onChange={(e) => set('payload', e.target.value)} aria-invalid={payloadError !== null} />
      </AuthRow>
      <AuthRow label="Header (optional)" hint={headerError ?? 'Extra JWT header fields as JSON, e.g. {"kid": "key-1"}.'}>
        <textarea aria-label="JWT header" className="mono au-multiline" rows={2} spellCheck={false} value={header} onChange={(e) => set('header', e.target.value)} aria-invalid={headerError !== null} />
      </AuthRow>
      <SelectParam
        {...common}
        name="addTokenTo"
        label="Add token to"
        fallback="header"
        options={[
          { value: 'header', label: 'Request header' },
          { value: 'queryParams', label: 'Query parameter' },
        ]}
      />
      {inQuery ? <TextParam {...common} name="queryParamKey" label="Query parameter name" placeholder="token" /> : <TextParam {...common} name="headerPrefix" label="Header prefix" placeholder="Bearer" />}
    </>
  );
}
