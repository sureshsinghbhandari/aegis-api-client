/**
 * Protocol-independent-ish HTTP wire types. The HTTP engine (`@aegis/http-client`)
 * consumes `HttpRequestSpec` and produces `HttpResponse`; nothing in here knows
 * about the UI, the database or scripts.
 */

export interface HeaderPair {
  name: string;
  value: string;
}

export type MultipartPart =
  | { kind: 'text'; name: string; value: string; contentType?: string }
  | { kind: 'file'; name: string; path: string; filename?: string; contentType?: string };

export type BodySpec =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'urlencoded'; entries: Array<{ name: string; value: string }> }
  | { kind: 'multipart'; parts: MultipartPart[] }
  /** Streamed from disk; never fully loaded into memory. */
  | { kind: 'file'; path: string };

export interface ClientCertificate {
  /** PEM certificate chain. */
  cert?: string;
  /** PEM private key. */
  key?: string;
  /** Base64 PKCS#12 bundle (alternative to cert+key). */
  pfxBase64?: string;
  passphrase?: string;
}

export interface TlsOptions {
  /** Defaults to true. Setting false requires policy permission and is always surfaced in the timeline. */
  rejectUnauthorized: boolean;
  /** Extra trusted CA certificates (PEM), in addition to the system roots. */
  ca?: string[];
  clientCertificate?: ClientCertificate;
}

export interface ProxyOptions {
  /** e.g. http://proxy.corp:8080 */
  url: string;
  username?: string;
  password?: string;
  /** Comma separated host patterns that bypass the proxy. */
  noProxy?: string;
}

export interface HttpRequestSpec {
  /** Correlation id used for cancellation. */
  id: string;
  method: string;
  url: string;
  headers: HeaderPair[];
  body: BodySpec;
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
  tls: TlsOptions;
  proxy?: ProxyOptions;
  /**
   * Response bodies larger than this are streamed to a temp file instead of
   * being kept in memory (default 8 MiB). `body` then holds only a preview.
   */
  spillThresholdBytes?: number;
  /** Directory for spilled bodies (defaults to the OS temp dir). */
  spillDirectory?: string;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export interface ResponseTimings {
  /** Epoch ms when sending began. */
  startedAt: number;
  /** Time from send until response headers were received (TTFB). */
  waitingMs: number;
  /** Time spent receiving the body. */
  downloadMs: number;
  totalMs: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HeaderPair[];
  /** Raw (decompressed) body bytes. When the body was spilled to disk this is only the first preview chunk. */
  body: Uint8Array;
  /** Total body size in bytes (decompressed), even if spilled. */
  size: number;
  /** Set when `bodyFilePath` is present: `body` is only a prefix of the full body. */
  truncated: boolean;
  /** Full decompressed body on disk, when it exceeded the in-memory threshold. */
  bodyFilePath?: string;
  /** Final URL after redirects. */
  url: string;
  redirects: RedirectHop[];
  timings: ResponseTimings;
  /** Approximate request size in bytes (headers + body). */
  requestSize: number;
  /** Raw Set-Cookie header values from the final response. */
  setCookies: string[];
  /** TLS notes surfaced to the timeline, e.g. "certificate validation disabled". */
  notes: string[];
}

/** Hook the HTTP engine uses to apply a cookie jar on every hop (including redirects). */
export interface CookieJarHook {
  getCookieHeader(url: string): Promise<string | undefined> | string | undefined;
  storeSetCookies(url: string, setCookies: string[]): Promise<void> | void;
}

export function headerValue(headers: HeaderPair[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

export function headerValues(headers: HeaderPair[], name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value);
}
