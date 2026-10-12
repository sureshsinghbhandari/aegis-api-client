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

/**
 * POST a form to an OAuth endpoint with client authentication (Basic header by default, or in the
 * body when `client_authentication` is `body`). Returns the status and the parsed JSON (or
 * form-encoded) body; never throws on a non-2xx status so callers can inspect `error`.
 */
async function postForm(params: AuthParams, context: AuthContext, url: string, body: Array<[string, string]>, options: { alwaysClientIdInBody?: boolean } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const clientId = str(params, 'clientId');
  const clientSecret = str(params, 'clientSecret');
  const headers = [
    { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
    { name: 'Accept', value: 'application/json' },
  ];
  if (str(params, 'client_authentication', 'header') === 'body') {
    body.push(['client_id', clientId], ['client_secret', clientSecret]);
  } else if (options.alwaysClientIdInBody) {
    // Device flow (RFC 8628 sections 3.1 and 3.4): the client id always travels in the body; only confidential clients add Basic auth.
    body.push(['client_id', clientId]);
    if (clientSecret) headers.push({ name: 'Authorization', value: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}` });
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
  return { status: response.status, json };
}

function errorReason(status: number, json: Record<string, unknown>): string {
  return typeof json.error_description === 'string' ? json.error_description : typeof json.error === 'string' ? json.error : `HTTP ${status}`;
}

function tokenFromJson(context: AuthContext, json: Record<string, unknown> & { access_token: string }): OAuth2Token {
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    ...(typeof json.refresh_token === 'string' ? { refreshToken: json.refresh_token } : {}),
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: context.now() + expiresIn * 1000 } : {}),
    ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
  };
}

async function requestToken(params: AuthParams, context: AuthContext, url: string, body: Array<[string, string]>): Promise<OAuth2Token> {
  if (!url) throw new AppError('AUTH_FAILED', 'OAuth 2.0 requires an access token URL.');
  const { status, json } = await postForm(params, context, url, body);
  if (status < 200 || status >= 300 || typeof json.access_token !== 'string') {
    throw new AppError('AUTH_FAILED', `The token endpoint rejected the request: ${errorReason(status, json)}`, { status });
  }
  return tokenFromJson(context, json as Record<string, unknown> & { access_token: string });
}

// ----------------------------------------------------------------------------- device authorization grant (RFC 8628)

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEVICE_DEFAULT_INTERVAL_S = 5;
const DEVICE_MAX_INTERVAL_S = 60;

/** Response of the device authorization endpoint (RFC 8628 section 3.2). The `deviceCode` is a credential: keep it in memory only. */
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Minimum seconds between token polls. */
  interval: number;
}

/**
 * Step 1 of the device flow: ask the device authorization endpoint (`deviceAuthUrl`, falling back
 * to `authUrl`) for a device code and a user code to show to the user.
 */
export async function startDeviceFlow(params: AuthParams, context: AuthContext): Promise<DeviceAuthorization> {
  const url = str(params, 'deviceAuthUrl') || str(params, 'authUrl');
  if (!url) throw new AppError('AUTH_FAILED', 'The device flow requires a device authorization URL.');
  const clientId = str(params, 'clientId');
  if (!clientId) throw new AppError('AUTH_FAILED', 'The device flow requires a client ID.');
  const { status, json } = await postForm(params, context, url, [['scope', str(params, 'scope')], ...extras(params)], { alwaysClientIdInBody: true });
  if (status < 200 || status >= 300 || typeof json.device_code !== 'string' || typeof json.user_code !== 'string') {
    throw new AppError('AUTH_FAILED', `The device authorization endpoint rejected the request: ${errorReason(status, json)}`, { status });
  }
  const verificationUri = typeof json.verification_uri === 'string' ? json.verification_uri : typeof json.verification_url === 'string' ? json.verification_url : '';
  if (!verificationUri) throw new AppError('AUTH_FAILED', 'The device authorization response has no verification URI.');
  const expiresIn = Number(json.expires_in);
  const interval = Number(json.interval);
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri,
    ...(typeof json.verification_uri_complete === 'string' ? { verificationUriComplete: json.verification_uri_complete } : {}),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1800,
    interval: Number.isFinite(interval) && interval > 0 ? Math.min(interval, DEVICE_MAX_INTERVAL_S) : DEVICE_DEFAULT_INTERVAL_S,
  };
}

export type DevicePollOutcome = { status: 'pending'; interval: number } | { status: 'done'; token: OAuth2Token };

/**
 * One poll of the token endpoint (RFC 8628 section 3.4/3.5). `authorization_pending` keeps the
 * interval, `slow_down` adds five seconds; `access_denied` and `expired_token` fail the flow.
 */
export async function pollDeviceTokenOnce(params: AuthParams, context: AuthContext, deviceCode: string, interval: number): Promise<DevicePollOutcome> {
  const url = str(params, 'accessTokenUrl');
  if (!url) throw new AppError('AUTH_FAILED', 'OAuth 2.0 requires an access token URL.');
  if (!deviceCode) throw new AppError('AUTH_FAILED', 'No device code; start the device flow first.');
  const { status, json } = await postForm(params, context, url, [['grant_type', DEVICE_CODE_GRANT], ['device_code', deviceCode]], { alwaysClientIdInBody: true });
  if (status >= 200 && status < 300 && typeof json.access_token === 'string') {
    return { status: 'done', token: tokenFromJson(context, json as Record<string, unknown> & { access_token: string }) };
  }
  const error = typeof json.error === 'string' ? json.error : '';
  const safeInterval = Number.isFinite(interval) && interval > 0 ? Math.min(interval, DEVICE_MAX_INTERVAL_S) : DEVICE_DEFAULT_INTERVAL_S;
  if (error === 'authorization_pending') return { status: 'pending', interval: safeInterval };
  if (error === 'slow_down') return { status: 'pending', interval: Math.min(safeInterval + 5, DEVICE_MAX_INTERVAL_S) };
  if (error === 'expired_token') throw new AppError('AUTH_FAILED', 'The device code expired before the sign-in was completed. Start again.', { status });
  if (error === 'access_denied') throw new AppError('AUTH_FAILED', 'The sign-in was denied.', { status });
  throw new AppError('AUTH_FAILED', `The token endpoint rejected the request: ${errorReason(status, json)}`, { status });
}

/**
 * Poll until the user completes the sign-in, the device code expires or `signal` aborts.
 * `sleep` is injectable for tests.
 */
export async function pollDeviceToken(
  params: AuthParams,
  context: AuthContext,
  device: Pick<DeviceAuthorization, 'deviceCode' | 'interval' | 'expiresIn'>,
  options: { signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): Promise<OAuth2Token> {
  const sleep = options.sleep ?? defaultSleep;
  const deadline = context.now() + device.expiresIn * 1000;
  let interval = device.interval;
  for (;;) {
    if (options.signal?.aborted) throw new AppError('REQUEST_CANCELLED', 'The device flow was cancelled.');
    if (context.now() > deadline) throw new AppError('AUTH_FAILED', 'The device code expired before the sign-in was completed. Start again.');
    const outcome = await pollDeviceTokenOnce(params, context, device.deviceCode, interval);
    if (outcome.status === 'done') return outcome.token;
    interval = outcome.interval;
    await sleep(interval * 1000, options.signal);
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
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
      if (!token && grant === 'device_code') {
        throw new AppError('AUTH_FAILED', 'No valid OAuth 2.0 access token. Use "Get New Access Token" in the Authorization tab to complete the device sign-in.');
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
