/** Pure helpers for the authorization editor (no React). */
import type { AuthConfig, AuthParamValue, AuthType } from '@aegis/core';

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

export function defaultParams(type: AuthType): Record<string, AuthParamValue> {
  switch (type) {
    case 'apikey':
      return { in: 'header' };
    case 'oauth2':
      return { grant_type: 'authorization_code_with_pkce', addTokenTo: 'header', client_authentication: 'header', headerPrefix: 'Bearer' };
    case 'oauth1':
      return { signatureMethod: 'HMAC-SHA1' };
    case 'jwt':
      return { algorithm: 'HS256', addTokenTo: 'header', headerPrefix: 'Bearer', payload: '{}' };
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
];

export const JWT_ALGORITHMS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512'];
export const OAUTH1_SIGNATURES = ['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT'];

export function jsonError(text: string): string | null {
  if (text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? null : 'Must be a JSON object';
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid JSON';
  }
}
