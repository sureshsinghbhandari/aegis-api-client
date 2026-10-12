import { constants, createHmac, createSign, type KeyObject } from 'node:crypto';
import { AppError } from '@aegis/core';
import { loadPrivateKey } from './keys';
import { bool, emptyResult, str, type AuthProvider } from './types';

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

const HMAC: Record<string, string> = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };
const RSA: Record<string, string> = { RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512' };
/** ECDSA (JWS requires the raw R||S "ieee-p1363" signature encoding, not DER). */
const ECDSA: Record<string, { hash: string; curve: string; size: number }> = {
  ES256: { hash: 'sha256', curve: 'prime256v1', size: 32 },
  ES384: { hash: 'sha384', curve: 'secp384r1', size: 48 },
  ES512: { hash: 'sha512', curve: 'secp521r1', size: 66 },
};
/** RSASSA-PSS with MGF1 and a salt as long as the digest (RFC 7518 section 3.5). */
const PSS: Record<string, string> = { PS256: 'sha256', PS384: 'sha384', PS512: 'sha512' };

export const JWT_ALGORITHMS_SUPPORTED = [...Object.keys(HMAC), ...Object.keys(RSA), ...Object.keys(ECDSA), ...Object.keys(PSS)];

export interface JwtSignOptions {
  algorithm: string;
  /** HMAC secret (utf8, or base64 when `secretIsBase64`). */
  secret?: string;
  secretIsBase64?: boolean;
  /** Private key (PEM, data: URI or KeyObject) for the RS, ES and PS algorithms. */
  privateKey?: string | KeyObject;
  payload: Record<string, unknown>;
  header?: Record<string, unknown>;
}

/** Sign a compact JWS. Supports HS256/384/512, RS256/384/512, ES256/384/512 and PS256/384/512. */
export function signJwt(options: JwtSignOptions): string {
  const alg = options.algorithm.toUpperCase();
  const header = { alg, typ: 'JWT', ...(options.header ?? {}) };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(options.payload))}`;
  if (HMAC[alg]) {
    if (!options.secret) throw new AppError('AUTH_FAILED', 'A secret is required to sign this JWT.');
    const key = options.secretIsBase64 ? Buffer.from(options.secret, 'base64') : Buffer.from(options.secret, 'utf8');
    return `${signingInput}.${b64url(createHmac(HMAC[alg]!, key).update(signingInput).digest())}`;
  }
  if (RSA[alg] || ECDSA[alg] || PSS[alg]) {
    if (!options.privateKey) throw new AppError('AUTH_FAILED', 'A private key is required to sign this JWT.');
    const key = loadPrivateKey(options.privateKey, 'JWT private key');
    let signature: Buffer;
    if (RSA[alg]) {
      assertKeyType(key, 'rsa', alg);
      signature = createSign(RSA[alg]!).update(signingInput).sign(key);
    } else if (ECDSA[alg]) {
      const ec = ECDSA[alg]!;
      assertKeyType(key, 'ec', alg);
      const curve = key.asymmetricKeyDetails?.namedCurve;
      if (curve && curve !== ec.curve) throw new AppError('AUTH_FAILED', `${alg} requires a ${ec.curve} key; the given key uses ${curve}.`);
      signature = createSign(ec.hash).update(signingInput).sign({ key, dsaEncoding: 'ieee-p1363' });
    } else {
      assertKeyType(key, 'rsa', alg);
      signature = createSign(PSS[alg]!).update(signingInput).sign({ key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
    }
    return `${signingInput}.${b64url(signature)}`;
  }
  throw new AppError('AUTH_FAILED', `Unsupported JWT algorithm "${options.algorithm}". Supported: ${JWT_ALGORITHMS_SUPPORTED.join(', ')}.`);
}

function assertKeyType(key: KeyObject, expected: 'rsa' | 'ec', alg: string): void {
  const type = key.asymmetricKeyType;
  const ok = expected === 'rsa' ? type === 'rsa' || type === 'rsa-pss' : type === 'ec';
  if (!ok) throw new AppError('AUTH_FAILED', `${alg} requires an ${expected === 'rsa' ? 'RSA' : 'EC'} private key (got ${type ?? 'an unknown key type'}).`);
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
  /** Epoch seconds if the `exp` claim is a number. */
  expiresAt?: number;
  expired?: boolean;
}

/** Decode (without verifying) a JWT for display. */
export function decodeJwt(token: string, nowSeconds = Math.floor(Date.now() / 1000)): DecodedJwt {
  const parts = token.trim().split('.');
  if (parts.length < 2) throw new AppError('VALIDATION_FAILED', 'Not a JWT: expected header.payload[.signature].');
  const parse = (s: string): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
      if (typeof v !== 'object' || v === null) throw new Error('not an object');
      return v as Record<string, unknown>;
    } catch (cause) {
      throw new AppError('VALIDATION_FAILED', 'Invalid JWT segment.', {}, { cause });
    }
  };
  const header = parse(parts[0]!);
  const payload = parse(parts[1]!);
  const out: DecodedJwt = { header, payload, signature: parts[2] ?? '' };
  if (typeof payload.exp === 'number') {
    out.expiresAt = payload.exp;
    out.expired = payload.exp < nowSeconds;
  }
  return out;
}

export const jwtProvider: AuthProvider = {
  type: 'jwt',
  apply(params) {
    const algorithm = str(params, 'algorithm', 'HS256');
    const payloadText = str(params, 'payload', '{}').trim() || '{}';
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payloadText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('payload must be an object');
      payload = parsed as Record<string, unknown>;
    } catch (cause) {
      throw new AppError('AUTH_FAILED', 'The JWT payload is not valid JSON.', {}, { cause });
    }
    let header: Record<string, unknown> | undefined;
    const headerText = str(params, 'header').trim();
    if (headerText) {
      try {
        header = JSON.parse(headerText) as Record<string, unknown>;
      } catch (cause) {
        throw new AppError('AUTH_FAILED', 'The JWT header is not valid JSON.', {}, { cause });
      }
    }
    const token = signJwt({
      algorithm,
      secret: str(params, 'secret'),
      secretIsBase64: bool(params, 'isSecretBase64Encoded'),
      privateKey: str(params, 'privateKey') || undefined,
      payload,
      ...(header ? { header } : {}),
    });
    const result = emptyResult();
    const location = str(params, 'addTokenTo', 'header').toLowerCase();
    if (location.startsWith('query')) result.query.push({ name: str(params, 'queryParamKey', 'token'), value: token });
    else {
      const prefix = str(params, 'headerPrefix', 'Bearer').trim();
      result.headers.push({ name: 'Authorization', value: prefix ? `${prefix} ${token}` : token });
    }
    result.notes.push(`Signed a ${algorithm.toUpperCase()} JWT.`);
    return result;
  },
};
