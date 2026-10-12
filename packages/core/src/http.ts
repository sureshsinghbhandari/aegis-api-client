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
  /** `auto` (default): HTTP/2 over TLS when offered via ALPN; `1.1` forces HTTP/1.1; `2` prefers HTTP/2. */
  httpVersion?: 'auto' | '1.1' | '2';
  /** Skip the cookie jar hook for this request (nothing sent from, nothing stored into the jar). */
  disableCookies?: boolean;
  /** Keep method and body on 301/302/303 redirects instead of switching to GET. */
  followOriginalHttpMethod?: boolean;
  /** Keep the Authorization header on cross-origin redirects (dangerous; off by default, surfaced in notes). */
  followAuthorizationHeader?: boolean;
  /** Drop a Referer header when following a redirect. */
  removeRefererHeaderOnRedirect?: boolean;
  /** Informational: the URL was built without percent-encoding the query (`encodeUrl: false`). */
  encodeUrl?: boolean;
  /** Host name overrides applied at DNS lookup time (host -> IP literal). Already policy-filtered by the caller. */
  hosts?: Record<string, string>;
  /** The only directory relative file paths (form-data / binary bodies) may resolve inside; absolute paths are validated as before. */
  workingDirectory?: string;
}

/** TLS details of the connection that served the final response. Never contains key material. */
export interface TlsConnectionInfo {
  /** e.g. `TLSv1.3` */
  protocol: string;
  /** Cipher suite name, e.g. `TLS_AES_256_GCM_SHA384`. */
  cipher: string;
  /** Negotiated ALPN protocol (`h2`, `http/1.1`) or empty. */
  alpn: string;
  /** Whether the peer certificate chain was verified (false only when verification was disabled). */
  authorized: boolean;
  peerCertificate?: {
    subject: string;
    issuer: string;
    /** ISO timestamps. */
    validFrom: string;
    validTo: string;
    /** SHA-256 fingerprint. */
    fingerprint: string;
    subjectAltName?: string;
  };
}

/** Transport details of the connection that served the final response. */
export interface ConnectionInfo {
  remoteAddress: string;
  remotePort: number;
  localAddress: string;
  localPort: number;
  /** True when the connection was created by a hosts override rather than DNS. */
  hostOverride?: string;
  /** True when no new connection was opened for the final hop (DNS/connect/TLS timings are then 0). */
  reused: boolean;
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
  /** DNS lookup for the final hop's connection (0 when an IP literal, a hosts override or a reused connection was used). */
  dnsMs?: number;
  /** TCP connect for the final hop's connection. */
  connectMs?: number;
  /** TLS handshake for the final hop's connection (0 for plain http). */
  tlsMs?: number;
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
  /** TLS details of the final hop's connection (https only). */
  tls?: TlsConnectionInfo;
  /** Transport details of the final hop's connection (not available through a proxy). */
  connection?: ConnectionInfo;
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
