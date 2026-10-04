import { createHash, randomBytes } from 'node:crypto';
import { AppError, type AuthParamValue } from '@aegis/core';
import { emptyResult, str, type AuthContext, type AuthParams, type AuthProvider, type AuthResult } from './types';

export interface OAuth2Token {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  /** Epoch ms; undefined when the server did not report an expiry. */
  expiresAt?: number;
  scope?: string;
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256' | 'plain';
}

const REFRESH_SKEW_MS = 30_000;

/** RFC 7636 PKCE pair. `S256` unless `plain` is requested explicitly. */
export function generatePkce(method: 'S256' | 'plain' = 'S256'): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = method === 'S256' ? createHash('sha256').update(verifier).digest('base64url') : verifier;
  return { verifier, challenge, method };
}

export function generateState(): string {
  return randomBytes(16).toString('base64url');
}

/** URL the user must open to authorize (Authorization Code [+ PKCE]). */
export function buildAuthorizationUrl(params: AuthParams, pkce: Pkce | undefined, state: string): string {
  const authUrl = str(params, 'authUrl');
  if (!authUrl) throw new AppError('AUTH_FAILED', 'OAuth 2.0 requires an authorization URL.');
  const url = new URL(authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', str(params, 'clientId'));
  const redirect = str(params, 'redirect_uri');
  if (redirect) url.searchParams.set('redirect_uri', redirect);
  const scope = str(params, 'scope');
  if (scope) url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  if (pkce) {
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);
  }
  const audience = str(params, 'audience');
  if (audience) url.searchParams.set('audience', audience);
  return url.toString();
}

function form(entries: Array<[string, string]>): string {
  return new URLSearchParams(entries.filter(([, v]) => v !== '')).toString();
}

async function requestToken(params: AuthParams, context: AuthContext, url: string, body: Array<[string, string]>): Promise<OAuth2Token> {
  if (!url) throw new AppError('AUTH_FAILED', 'OAuth 2.0 requires an access token URL.');
  const clientId = str(params, 'clientId');
  const clientSecret = str(params, 'clientSecret');
  const headers = [
    { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
    { name: 'Accept', value: 'application/json' },
  ];
  if (str(params, 'client_authentication', 'header') === 'body') {
    body.push(['client_id', clientId], ['client_secret', clientSecret]);
  } else if (clientId || clientSecret) {
    headers.push({ name: 'Authorization', value: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}` });
  }
  const response = await context.send({ method: 'POST', url, headers, body: form(body), timeoutMs: 30_000 });
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(response.bodyText) as Record<string, unknown>;
  } catch {
    // Some servers answer form-encoded.
    json = Object.fromEntries(new URLSearchParams(response.bodyText));
  }
  if (response.status < 200 || response.status >= 300 || typeof json.access_token !== 'string') {
    const reason = typeof json.error_description === 'string' ? json.error_description : typeof json.error === 'string' ? json.error : `HTTP ${response.status}`;
    throw new AppError('AUTH_FAILED', `The token endpoint rejected the request: ${reason}`, { status: response.status });
  }
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    ...(typeof json.refresh_token === 'string' ? { refreshToken: json.refresh_token } : {}),
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: context.now() + expiresIn * 1000 } : {}),
    ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
  };
}

function extras(params: AuthParams): Array<[string, string]> {
  return [
    ['audience', str(params, 'audience')],
    ['resource', str(params, 'resource')],
  ];
}

export function fetchClientCredentialsToken(params: AuthParams, context: AuthContext): Promise<OAuth2Token> {
  return requestToken(params, context, str(params, 'accessTokenUrl'), [['grant_type', 'client_credentials'], ['scope', str(params, 'scope')], ...extras(params)]);
}

export function fetchPasswordToken(params: AuthParams, context: AuthContext): Promise<OAuth2Token> {
  return requestToken(params, context, str(params, 'accessTokenUrl'), [
    ['grant_type', 'password'],
    ['username', str(params, 'username')],
    ['password', str(params, 'password')],
    ['scope', str(params, 'scope')],
    ...extras(params),
  ]);
}

export function refreshAccessToken(params: AuthParams, context: AuthContext): Promise<OAuth2Token> {
  const refresh = str(params, 'refreshToken');
  if (!refresh) throw new AppError('AUTH_FAILED', 'No refresh token available.');
  return requestToken(params, context, str(params, 'refreshTokenUrl') || str(params, 'accessTokenUrl'), [
    ['grant_type', 'refresh_token'],
    ['refresh_token', refresh],
    ['scope', str(params, 'scope')],
  ]);
}

export function exchangeAuthorizationCode(params: AuthParams, context: AuthContext, code: string, pkce?: Pkce): Promise<OAuth2Token> {
  return requestToken(params, context, str(params, 'accessTokenUrl'), [
    ['grant_type', 'authorization_code'],
    ['code', code],
    ['redirect_uri', str(params, 'redirect_uri')],
    ...(pkce ? ([['code_verifier', pkce.verifier]] as Array<[string, string]>) : []),
  ]);
}

/** Convert a fetched token into the auth params that should be persisted. */
export function tokenToParams(token: OAuth2Token): Record<string, AuthParamValue> {
  return {
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
  };
}

function isTokenUsable(params: AuthParams, now: number): boolean {
  if (!str(params, 'accessToken')) return false;
  const expiresAt = Number(params.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt - REFRESH_SKEW_MS > now;
}

export const oauth2Provider: AuthProvider = {
  type: 'oauth2',
  async apply(params, context): Promise<AuthResult> {
    const result = emptyResult();
    let token: OAuth2Token | undefined;
    const grant = str(params, 'grant_type', 'authorization_code');

    if (!isTokenUsable(params, context.now())) {
      if (str(params, 'refreshToken') && (str(params, 'refreshTokenUrl') || str(params, 'accessTokenUrl'))) {
        try {
          token = await refreshAccessToken(params, context);
          result.notes.push('OAuth 2.0 access token refreshed.');
        } catch (error) {
          if (grant !== 'client_credentials' && grant !== 'password_credentials') throw error;
        }
      }
      if (!token && grant === 'client_credentials') {
        token = await fetchClientCredentialsToken(params, context);
        result.notes.push('OAuth 2.0 access token obtained (client credentials).');
      } else if (!token && grant === 'password_credentials') {
        token = await fetchPasswordToken(params, context);
        result.notes.push('OAuth 2.0 access token obtained (password).');
      } else if (!token) {
        throw new AppError('AUTH_FAILED', 'No valid OAuth 2.0 access token. Use "Get New Access Token" in the Authorization tab.');
      }
      result.updatedParams = tokenToParams(token);
    }

    const accessToken = token?.accessToken ?? str(params, 'accessToken');
    const tokenType = token?.tokenType ?? (str(params, 'tokenType') || 'Bearer');
    if (str(params, 'addTokenTo', 'header').toLowerCase().startsWith('query')) {
      result.query.push({ name: 'access_token', value: accessToken });
    } else {
      const prefix = str(params, 'headerPrefix', tokenType || 'Bearer').trim();
      result.headers.push({ name: 'Authorization', value: prefix ? `${prefix} ${accessToken}` : accessToken });
    }
    return result;
  },
};
