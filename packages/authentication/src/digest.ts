import { createHash, randomBytes } from 'node:crypto';
import { AppError, type HeaderPair } from '@aegis/core';
import { bool, emptyResult, str, type AuthContext, type AuthParams, type AuthProvider, type AuthResult } from './types';

/**
 * HTTP Digest authentication (RFC 7616, backwards compatible with RFC 2617/2069).
 *
 * Flow: the provider asks the executor for a challenge round trip (`AuthContext.challenge`): the
 * request is sent once without credentials, the `WWW-Authenticate: Digest ...` challenge of the 401
 * is parsed, and the real request is sent with the computed `Authorization` header. When the
 * Postman-style parameters already carry a `nonce` (and optionally realm/opaque/qop/algorithm) the
 * challenge is skipped and the header is computed directly.
 *
 * Supported: MD5, MD5-sess, SHA-256, SHA-256-sess, SHA-512-256, SHA-512-256-sess; qop `auth` and
 * `auth-int` (text/urlencoded bodies); `userhash`; `opaque`; nonce counting per nonce; client nonces.
 */

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  /** Algorithm token as sent by the server; `MD5` when absent (RFC 7616 section 3.3). */
  algorithm: string;
  /** Offered qop values; empty for RFC 2069 servers. */
  qop: string[];
  userhash: boolean;
  stale: boolean;
  charset?: string;
  domain?: string;
}

/** One parsed `WWW-Authenticate` challenge (any scheme). */
export interface WwwAuthenticateChallenge {
  scheme: string;
  params: Record<string, string>;
}

const TOKEN = /\s*(?:,\s*)*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+)))?/y;

/** Parse one or more `WWW-Authenticate` header values (multiple challenges per header, RFC 7235 section 4.1). */
export function parseWwwAuthenticate(values: string | readonly string[]): WwwAuthenticateChallenge[] {
  const out: WwwAuthenticateChallenge[] = [];
  for (const value of typeof values === 'string' ? [values] : values) {
    TOKEN.lastIndex = 0;
    let current: WwwAuthenticateChallenge | undefined;
    let m: RegExpExecArray | null;
    while (TOKEN.lastIndex < value.length && (m = TOKEN.exec(value)) !== null) {
      if (m[0].trim() === '') break;
      const [, name, quoted, bare] = m;
      if (quoted === undefined && bare === undefined) {
        current = { scheme: name!, params: {} };
        out.push(current);
      } else if (current) {
        current.params[name!.toLowerCase()] = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : bare!;
      }
    }
  }
  return out;
}

const HASHES: Record<string, string> = {
  MD5: 'md5',
  'MD5-SESS': 'md5',
  'SHA-256': 'sha256',
  'SHA-256-SESS': 'sha256',
  'SHA-512-256': 'sha512-256',
  'SHA-512-256-SESS': 'sha512-256',
};

export const DIGEST_ALGORITHMS = ['MD5', 'MD5-sess', 'SHA-256', 'SHA-256-sess', 'SHA-512-256', 'SHA-512-256-sess'];

function hashFor(algorithm: string): ((data: string | Buffer) => string) | undefined {
  const name = HASHES[algorithm.toUpperCase()];
  if (!name) return undefined;
  try {
    createHash(name);
  } catch {
    return undefined;
  }
  return (data) => createHash(name).update(data).digest('hex');
}

/** Pick the Digest challenges from the parsed list and normalise them. */
export function digestChallenges(challenges: readonly WwwAuthenticateChallenge[]): DigestChallenge[] {
  return challenges
    .filter((c) => c.scheme.toLowerCase() === 'digest')
    .map((c) => ({
      realm: c.params.realm ?? '',
      nonce: c.params.nonce ?? '',
      ...(c.params.opaque !== undefined ? { opaque: c.params.opaque } : {}),
      algorithm: c.params.algorithm ?? 'MD5',
      qop: (c.params.qop ?? '')
        .split(',')
        .map((q) => q.trim().toLowerCase())
        .filter(Boolean),
      userhash: (c.params.userhash ?? '').toLowerCase() === 'true',
      stale: (c.params.stale ?? '').toLowerCase() === 'true',
      ...(c.params.charset !== undefined ? { charset: c.params.charset } : {}),
      ...(c.params.domain !== undefined ? { domain: c.params.domain } : {}),
    }));
}

export interface DigestInputs {
  username: string;
  password: string;
  method: string;
  /** Absolute request URL; the `uri` directive is its path + query. */
  url: string;
  challenge: DigestChallenge;
  /** Preferred qop when the server offers several. */
  preferredQop?: string;
  /** Entity body for `auth-int`; `undefined` when the body cannot be hashed (streams, multipart). */
  body?: string | Buffer;
  nc: number;
  cnonce: string;
}

export interface DigestHeader {
  value: string;
  /** Effective choices, for notes and tests (no secrets). */
  algorithm: string;
  qop?: string;
  response: string;
}

const quote = (s: string): string => `"${s.replace(/(["\\])/g, '\\$1')}"`;

/** Compute the `Authorization: Digest ...` header value. Exported for tests with fixed cnonce/nc. */
export function buildDigestHeader(inputs: DigestInputs): DigestHeader {
  const { challenge } = inputs;
  const algorithm = challenge.algorithm;
  const H = hashFor(algorithm);
  if (!H) throw new AppError('AUTH_FAILED', `The server requires the Digest algorithm "${algorithm}", which is not supported. Supported: ${DIGEST_ALGORITHMS.join(', ')}.`);
  if (!challenge.nonce) throw new AppError('AUTH_FAILED', 'The Digest challenge has no nonce.');

  const url = new URL(inputs.url);
  const uri = `${url.pathname}${url.search}`;
  const method = inputs.method.toUpperCase();
  const session = algorithm.toUpperCase().endsWith('-SESS');
  const nc = inputs.nc.toString(16).padStart(8, '0');

  let qop: string | undefined;
  if (challenge.qop.length) {
    const preferred = (inputs.preferredQop ?? '').toLowerCase();
    const offered: string[] = challenge.qop.filter((q) => q === 'auth' || q === 'auth-int');
    if (!offered.length) throw new AppError('AUTH_FAILED', `The server offers unsupported Digest qop values (${challenge.qop.join(', ')}).`);
    if (preferred && offered.includes(preferred)) qop = preferred;
    else qop = offered.includes('auth') ? 'auth' : offered[0]!;
    if (qop === 'auth-int' && inputs.body === undefined) {
      if (offered.includes('auth')) qop = 'auth';
      else throw new AppError('AUTH_FAILED', 'Digest qop=auth-int needs a text body; this request body cannot be hashed.');
    }
  }

  const username = challenge.userhash ? H(`${inputs.username}:${challenge.realm}`) : inputs.username;
  let ha1 = H(`${inputs.username}:${challenge.realm}:${inputs.password}`);
  if (session) ha1 = H(`${ha1}:${challenge.nonce}:${inputs.cnonce}`);
  const ha2 = qop === 'auth-int' ? H(`${method}:${uri}:${H(inputs.body ?? '')}`) : H(`${method}:${uri}`);
  const response = qop ? H(`${ha1}:${challenge.nonce}:${nc}:${inputs.cnonce}:${qop}:${ha2}`) : H(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [`username=${quote(username)}`, `realm=${quote(challenge.realm)}`, `nonce=${quote(challenge.nonce)}`, `uri=${quote(uri)}`, `algorithm=${algorithm}`];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(inputs.cnonce)}`);
  parts.push(`response=${quote(response)}`);
  if (challenge.opaque !== undefined) parts.push(`opaque=${quote(challenge.opaque)}`);
  if (challenge.userhash) parts.push('userhash=true');
  return { value: `Digest ${parts.join(', ')}`, algorithm, ...(qop ? { qop } : {}), response };
}

function bodyForAuthInt(context: AuthContext): string | undefined {
  switch (context.body.kind) {
    case 'none':
      return '';
    case 'text':
      return context.body.text;
    case 'urlencoded':
      return new URLSearchParams(context.body.entries.map((e) => [e.name, e.value] as [string, string])).toString();
    default:
      return undefined;
  }
}

/** Nonce counter per server nonce (RFC 7616 section 3.4.1); bounded so it cannot grow without limit. */
const nonceCounts = new Map<string, number>();
function nextNonceCount(nonce: string): number {
  if (nonceCounts.size > 1000) nonceCounts.clear();
  const n = (nonceCounts.get(nonce) ?? 0) + 1;
  nonceCounts.set(nonce, n);
  return n;
}

function challengeFromParams(params: AuthParams): DigestChallenge {
  const qop = str(params, 'qop')
    .split(',')
    .map((q) => q.trim().toLowerCase())
    .filter(Boolean);
  const opaque = str(params, 'opaque');
  return { realm: str(params, 'realm'), nonce: str(params, 'nonce'), ...(opaque ? { opaque } : {}), algorithm: str(params, 'algorithm') || 'MD5', qop, userhash: false, stale: false };
}

/** Postman-compatible parameter names: username, password, realm, nonce, algorithm, qop, nonceCount, clientNonce, opaque, disableRetryRequest. */
export const digestProvider: AuthProvider = {
  type: 'digest',
  async apply(params, context): Promise<AuthResult> {
    const username = str(params, 'username');
    const password = str(params, 'password');
    if (!username) throw new AppError('AUTH_FAILED', 'Digest authentication requires a username.');
    const result = emptyResult();
    const preferredAlgorithm = str(params, 'algorithm');

    let challenge: DigestChallenge;
    if (str(params, 'nonce')) {
      challenge = challengeFromParams(params);
      result.notes.push('Digest: used the configured nonce (no challenge round trip).');
    } else {
      if (bool(params, 'disableRetryRequest')) throw new AppError('AUTH_FAILED', 'Digest: "disable retrying the request" is set but no nonce is configured, so no Authorization header can be computed.');
      if (!context.challenge) throw new AppError('AUTH_FAILED', 'Digest authentication needs a challenge round trip, which is not available in this context.');
      const probe = await context.challenge();
      const headers: string[] = probe.headers.filter((h: HeaderPair) => h.name.toLowerCase() === 'www-authenticate').map((h) => h.value);
      const offered = digestChallenges(parseWwwAuthenticate(headers));
      if (probe.status !== 401) {
        result.notes.push(`Digest: the server answered ${probe.status} without a challenge; the request is sent without credentials.`);
        return result;
      }
      if (!offered.length) {
        const schemes = parseWwwAuthenticate(headers).map((c) => c.scheme);
        throw new AppError('AUTH_FAILED', schemes.length ? `The server does not offer Digest authentication (offered: ${schemes.join(', ')}).` : 'The server answered 401 without a WWW-Authenticate challenge.', { schemes });
      }
      // Servers list challenges in order of preference; take the first supported one, or the one matching the configured algorithm.
      const supported = offered.filter((c) => hashFor(c.algorithm));
      challenge = supported.find((c) => preferredAlgorithm && c.algorithm.toUpperCase() === preferredAlgorithm.toUpperCase()) ?? supported[0] ?? offered[0]!;
      result.notes.push('Digest: challenge received (401), request re-sent with credentials.');
    }

    const nonceCount = Number.parseInt(str(params, 'nonceCount'), 16);
    const nc = Number.isFinite(nonceCount) && nonceCount > 0 ? nonceCount : nextNonceCount(challenge.nonce);
    const cnonce = str(params, 'clientNonce') || randomBytes(8).toString('hex');
    const header = buildDigestHeader({
      username,
      password,
      method: context.method,
      url: context.url,
      challenge,
      ...(str(params, 'qop') ? { preferredQop: str(params, 'qop') } : {}),
      ...(bodyForAuthInt(context) !== undefined ? { body: bodyForAuthInt(context) } : {}),
      nc,
      cnonce,
    });
    result.headers.push({ name: 'Authorization', value: header.value });
    result.notes.push(`Digest ${header.algorithm}${header.qop ? `, qop=${header.qop}` : ''}, realm "${challenge.realm}".`);
    return result;
  },
};
