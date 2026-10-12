import { randomUUID } from 'node:crypto';
import { AppError } from '@aegis/core';
import { signJwt } from './jwt';
import { emptyResult, str, type AuthParams, type AuthProvider } from './types';

/**
 * Atlassian ASAP (S2S authentication protocol, https://s2sauth.bitbucket.io/spec/): a short-lived
 * JWT signed with the issuer's private key, sent as `Authorization: Bearer <token>`.
 * Header: `{ alg, kid, typ: "JWT" }`. Claims: `iss`, `sub` (defaults to `iss`), `aud` (string or
 * list), `iat`, `nbf`, `exp` (default one hour, bounded to 24h by the spec's recommendation) and a
 * unique `jti`. Extra claims can be merged from a JSON object.
 */

export const ASAP_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
const DEFAULT_EXPIRY_SECONDS = 3600;
const MAX_EXPIRY_SECONDS = 24 * 3600;

/** Parse `exp` as seconds, or a duration such as `30s`, `15m`, `1h`, `2d`. */
export function parseExpiry(text: string, fallback = DEFAULT_EXPIRY_SECONDS): number {
  const t = text.trim().toLowerCase();
  if (!t) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/.exec(t);
  if (!m) throw new AppError('AUTH_FAILED', `Invalid ASAP expiry "${text}". Use seconds or a duration like 30s, 15m, 1h.`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const mult = unit === 'ms' ? 0.001 : unit.startsWith('m') ? 60 : unit.startsWith('h') ? 3600 : unit.startsWith('d') ? 86400 : 1;
  const seconds = Math.round(n * mult);
  if (seconds <= 0) throw new AppError('AUTH_FAILED', 'The ASAP expiry must be positive.');
  return Math.min(seconds, MAX_EXPIRY_SECONDS);
}

export interface AsapToken {
  token: string;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

/** Build and sign an ASAP token. Exported for tests with a fixed clock/jti. */
export function buildAsapToken(params: AuthParams, nowMs: number, jti: string = randomUUID()): AsapToken {
  const alg = (str(params, 'alg') || 'RS256').toUpperCase();
  if (!ASAP_ALGORITHMS.includes(alg)) throw new AppError('AUTH_FAILED', `Unsupported ASAP algorithm "${alg}". Supported: ${ASAP_ALGORITHMS.join(', ')}.`);
  const kid = str(params, 'kid');
  const iss = str(params, 'iss');
  const audText = str(params, 'aud');
  const privateKey = str(params, 'privateKey');
  if (!kid || !iss || !audText) throw new AppError('AUTH_FAILED', 'ASAP requires a key id (kid), an issuer (iss) and an audience (aud).');
  if (!privateKey) throw new AppError('AUTH_FAILED', 'ASAP requires a private key.');

  let extra: Record<string, unknown> = {};
  const claimsText = str(params, 'claims').trim();
  if (claimsText) {
    try {
      const parsed: unknown = JSON.parse(claimsText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('claims must be an object');
      extra = parsed as Record<string, unknown>;
    } catch (cause) {
      throw new AppError('AUTH_FAILED', 'The ASAP additional claims are not a valid JSON object.', {}, { cause });
    }
  }
  const audList = audText
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const iat = Math.floor(nowMs / 1000);
  const claims: Record<string, unknown> = {
    ...extra,
    iss,
    sub: str(params, 'sub') || iss,
    aud: audList.length === 1 ? audList[0] : audList,
    iat,
    nbf: iat,
    exp: iat + parseExpiry(str(params, 'exp')),
    jti,
  };
  const header = { kid };
  const token = signJwt({ algorithm: alg, privateKey, payload: claims, header });
  return { token, header: { alg, typ: 'JWT', ...header }, claims };
}

/** Postman-compatible parameter names: alg, kid, iss, sub, aud, exp, privateKey, claims. */
export const asapProvider: AuthProvider = {
  type: 'asap',
  apply(params, context) {
    const { token, header } = buildAsapToken(params, context.now());
    const result = emptyResult();
    result.headers.push({ name: 'Authorization', value: `Bearer ${token}` });
    result.notes.push(`ASAP ${String(header.alg)} token (kid "${String(header.kid)}").`);
    return result;
  },
};
