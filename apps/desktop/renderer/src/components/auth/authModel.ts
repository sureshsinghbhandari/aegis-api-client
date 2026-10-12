/** Pure helpers for the authorization editor (no React). */
import { EXECUTABLE_CUSTOM_AUTH_PROVIDERS, type AuthConfig, type AuthParamValue, type AuthType } from '@aegis/core';

export const AUTH_TYPE_LABELS: Record<AuthType, string> = {
  inherit: 'Inherit auth from parent',
  none: 'No Auth',
  basic: 'Basic Auth',
  bearer: 'Bearer Token',
  apikey: 'API Key',
  oauth2: 'OAuth 2.0',
  oauth1: 'OAuth 1.0',
  jwt: 'JWT Bearer',
  awsv4: 'AWS Signature',
  custom: 'Custom / unsupported',
};

export const AUTH_TYPE_ORDER: AuthType[] = ['inherit', 'none', 'basic', 'bearer', 'apikey', 'oauth2', 'oauth1', 'jwt', 'awsv4', 'custom'];

/**
 * Postman-compatible providers stored as `{ type: 'custom', params: { providerId } }` (so imported
 * collections round-trip unchanged) but executable and edited like native types.
 */
export const CUSTOM_PROVIDER_LABELS: Record<string, string> = {
  digest: 'Digest Auth',
  hawk: 'Hawk Authentication',
  edgegrid: 'Akamai EdgeGrid',
  asap: 'ASAP (Atlassian)',
};

/** Value of the type selector: an `AuthType`, or `custom:<providerId>` for an executable custom provider. */
export type AuthSelectValue = AuthType | `custom:${string}`;

export const AUTH_SELECT_OPTIONS: Array<{ value: AuthSelectValue; label: string }> = AUTH_TYPE_ORDER.flatMap((t) =>
  t === 'custom'
    ? [...EXECUTABLE_CUSTOM_AUTH_PROVIDERS.map((p) => ({ value: `custom:${p}` as AuthSelectValue, label: CUSTOM_PROVIDER_LABELS[p] ?? p })), { value: t, label: AUTH_TYPE_LABELS[t] }]
    : [{ value: t, label: AUTH_TYPE_LABELS[t] }],
);

export function customProviderId(auth: AuthConfig): string {
  return auth.type === 'custom' ? param(auth, 'providerId') : '';
}

/** True for a `custom` config whose provider is implemented (digest, hawk, ...). */
export function isExecutableCustom(auth: AuthConfig): boolean {
  return auth.type === 'custom' && EXECUTABLE_CUSTOM_AUTH_PROVIDERS.includes(customProviderId(auth));
}

export function authSelectValue(auth: AuthConfig): AuthSelectValue {
  return isExecutableCustom(auth) ? `custom:${customProviderId(auth)}` : auth.type;
}

/** Build the auth config for a selector value, reusing `params` when the user previously edited that type. */
export function authFromSelectValue(value: AuthSelectValue, params?: Record<string, AuthParamValue>): AuthConfig {
  if (value.startsWith('custom:')) {
    const providerId = value.slice('custom:'.length);
    return { type: 'custom', params: { ...(params ?? defaultParams(value)), providerId } };
  }
  const type = value as AuthType;
  return { type, params: params ?? defaultParams(type) };
}

export function defaultParams(type: AuthSelectValue): Record<string, AuthParamValue> {
  switch (type) {
    case 'apikey':
      return { in: 'header' };
    case 'oauth2':
      return { grant_type: 'authorization_code_with_pkce', addTokenTo: 'header', client_authentication: 'header', headerPrefix: 'Bearer' };
    case 'oauth1':
      return { signatureMethod: 'HMAC-SHA1' };
    case 'jwt':
      return { algorithm: 'HS256', addTokenTo: 'header', headerPrefix: 'Bearer', payload: '{}' };
    case 'custom:digest':
      return { providerId: 'digest', algorithm: 'MD5', qop: 'auth' };
    case 'custom:hawk':
      return { providerId: 'hawk', algorithm: 'sha256' };
    case 'custom:edgegrid':
      return { providerId: 'edgegrid' };
    case 'custom:asap':
      return { providerId: 'asap', alg: 'RS256', exp: '1h' };
    default:
      return {};
  }
}

export function param(auth: AuthConfig, key: string, fallback = ''): string {
  const v = auth.params[key];
  return v === undefined || v === null ? fallback : String(v);
}

export function paramBool(auth: AuthConfig, key: string): boolean {
  const v = auth.params[key];
  return v === true || v === 'true';
}

export function withParam(auth: AuthConfig, key: string, value: AuthParamValue): AuthConfig {
  return { ...auth, params: { ...auth.params, [key]: value } };
}

export type TokenStatus = { state: 'none' } | { state: 'present'; expiresAt?: number; expired: boolean };

/** OAuth 2.0 token status from the stored params (`expiresAt` is epoch ms). Never reads the token value itself. */
export function oauthTokenStatus(auth: AuthConfig, now = Date.now()): TokenStatus {
  if (param(auth, 'accessToken') === '') return { state: 'none' };
  const raw = Number(auth.params.expiresAt);
  if (!Number.isFinite(raw) || raw <= 0) return { state: 'present', expired: false };
  return { state: 'present', expiresAt: raw, expired: raw <= now };
}

export function describeExpiry(expiresAt: number, now = Date.now()): string {
  const diff = expiresAt - now;
  const abs = Math.abs(diff);
  const text = abs < 90_000 ? `${Math.round(abs / 1000)} s` : abs < 90 * 60_000 ? `${Math.round(abs / 60_000)} min` : abs < 36 * 3_600_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} d`;
  return diff >= 0 ? `expires in ${text}` : `expired ${text} ago`;
}

export const OAUTH2_GRANTS: Array<{ value: string; label: string }> = [
  { value: 'authorization_code_with_pkce', label: 'Authorization Code (with PKCE)' },
  { value: 'authorization_code', label: 'Authorization Code' },
  { value: 'client_credentials', label: 'Client Credentials' },
  { value: 'password_credentials', label: 'Password Credentials' },
  { value: 'device_code', label: 'Device Authorization (device code)' },
];

export const JWT_ALGORITHMS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];
/** Algorithms signed with a private key (everything but HMAC). */
export const isAsymmetricJwtAlgorithm = (algorithm: string): boolean => /^(RS|ES|PS)\d{3}$/i.test(algorithm.trim());
export const OAUTH1_SIGNATURES = ['HMAC-SHA1', 'HMAC-SHA256', 'HMAC-SHA512', 'RSA-SHA1', 'RSA-SHA256', 'RSA-SHA512', 'PLAINTEXT'];
export const DIGEST_ALGORITHMS = ['MD5', 'MD5-sess', 'SHA-256', 'SHA-256-sess', 'SHA-512-256', 'SHA-512-256-sess'];
export const HAWK_ALGORITHMS = ['sha256', 'sha1'];
export const ASAP_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];

export function jsonError(text: string): string | null {
  if (text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? null : 'Must be a JSON object';
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid JSON';
  }
}
