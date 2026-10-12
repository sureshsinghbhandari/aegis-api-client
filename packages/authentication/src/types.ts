import type { AuthConfig, AuthParamValue, BodySpec, HeaderPair } from '@aegis/core';

/** Narrow HTTP callback used for token endpoints. The app wires it to the full pipeline (policy, TLS, proxy, limits). */
export interface AuthHttpRequest {
  method: string;
  url: string;
  headers: HeaderPair[];
  body?: string;
  timeoutMs?: number;
}

export interface AuthHttpResponse {
  status: number;
  bodyText: string;
}

export interface AuthContext {
  /** Request method, upper-case. */
  method: string;
  /** Final request URL (variables resolved, query included). */
  url: string;
  headers: readonly HeaderPair[];
  body: BodySpec;
  /** Wall clock in epoch milliseconds (injectable for tests). */
  now(): number;
  send(request: AuthHttpRequest): Promise<AuthHttpResponse>;
  /**
   * Challenge round trip for challenge/response schemes (Digest, ...): sends the
   * request exactly as prepared but WITHOUT authentication and returns the
   * status and headers of that response (e.g. a 401 with `WWW-Authenticate`).
   * The response body is discarded. Same policy/TLS/proxy/cookie handling as
   * the real request. Optional: absent in contexts without a request (token tools).
   */
  challenge?(): Promise<AuthChallengeResponse>;
}

/** Result of {@link AuthContext.challenge}. */
export interface AuthChallengeResponse {
  status: number;
  headers: HeaderPair[];
}

export interface AuthResult {
  /** Headers to set (replacing same-named existing headers). */
  headers: HeaderPair[];
  /** Query parameters to append. */
  query: Array<{ name: string; value: string }>;
  /** Parameters the provider changed and the caller should persist (e.g. a refreshed OAuth2 token). */
  updatedParams?: Record<string, AuthParamValue>;
  /** Human-readable notes for the timeline (never contain secrets). */
  notes: string[];
}

export type AuthParams = Readonly<Record<string, AuthParamValue>>;

export interface AuthProvider {
  /** Auth type id, e.g. `basic`. */
  readonly type: string;
  apply(params: AuthParams, context: AuthContext): Promise<AuthResult> | AuthResult;
}

export const emptyResult = (): AuthResult => ({ headers: [], query: [], notes: [] });

export function str(params: AuthParams, key: string, fallback = ''): string {
  const v = params[key];
  return v === undefined || v === null ? fallback : String(v);
}

export function bool(params: AuthParams, key: string, fallback = false): boolean {
  const v = params[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return fallback;
}

export type { AuthConfig };
