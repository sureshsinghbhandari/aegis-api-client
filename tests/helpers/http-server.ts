import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { HttpRequestSpec } from '@aegis/core';

export interface TestServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Credentials the `/digest/*` routes accept (same as the kitchen-sink fixture's "Digest protected" request). */
export const DIGEST_CREDENTIALS = { username: 'admin', password: 'digest-password-literal', realm: 'metrics' } as const;

/** Minimal request shape shared by the http/https (IncomingMessage) and http2 compat (Http2ServerRequest) servers. */
interface AnyRequest extends NodeJS.ReadableStream {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  httpVersion: string;
}

interface AnyResponse {
  writeHead(status: number, headers?: Record<string, string | string[] | number>): unknown;
  write(chunk: Buffer | string): boolean;
  end(chunk?: Buffer | string): unknown;
  once(event: 'drain', listener: (...args: unknown[]) => void): unknown;
}

async function readAll(req: AnyRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Parse `key="value", key=value` auth parameter lists (Digest). */
export function parseAuthParams(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)=(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const m of header.matchAll(re)) out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  return out;
}

const DIGEST_NONCES = new Set<string>();

/** Verify a Digest Authorization header (RFC 7616, qop=auth, MD5 or SHA-256). Returns null when valid, else the reason. */
export function verifyDigest(authorization: string | undefined, method: string, algorithm: 'MD5' | 'SHA-256'): string | null {
  if (!authorization || !/^Digest\s/i.test(authorization)) return 'no digest credentials';
  const p = parseAuthParams(authorization.slice(7));
  const hash = (s: string) => createHash(algorithm === 'MD5' ? 'md5' : 'sha256').update(s).digest('hex');
  if (p.username !== DIGEST_CREDENTIALS.username) return 'unknown user';
  if (p.realm !== DIGEST_CREDENTIALS.realm) return 'wrong realm';
  if (!p.nonce || !DIGEST_NONCES.has(p.nonce)) return 'unknown nonce';
  if ((p.algorithm ?? 'MD5').toUpperCase() !== algorithm) return `algorithm must be ${algorithm}`;
  if (p.qop !== 'auth') return 'qop must be auth';
  if (!p.nc || !p.cnonce || !p.uri || !p.response) return 'missing parameters';
  const ha1 = hash(`${p.username}:${p.realm}:${DIGEST_CREDENTIALS.password}`);
  const ha2 = hash(`${method}:${p.uri}`);
  const expected = hash(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
  return expected === p.response ? null : 'bad response';
}

export function requestHandler() {
  return async (req: AnyRequest, res: AnyResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readAll(req);
    const json = (status: number, value: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    const parts = url.pathname.split('/').filter(Boolean);
    const host = req.headers.host ?? req.headers[':authority'];
    switch (parts[0]) {
      case 'echo':
        return json(200, {
          method: req.method,
          path: url.pathname + url.search,
          headers: req.headers,
          body: body.toString('utf8'),
          bodyLength: body.length,
          httpVersion: req.httpVersion,
        });
      case 'host':
        // For hosts-override tests: what the server saw as the Host header (`:authority` over HTTP/2).
        return json(200, { host, httpVersion: req.httpVersion });
      case 'status':
        res.writeHead(Number(parts[1]), { 'Content-Type': 'text/plain' });
        return res.end(`status ${parts[1]}`);
      case 'delay':
        await new Promise((r) => setTimeout(r, Number(parts[1])));
        return json(200, { ok: true });
      case 'redirect': {
        const n = Number(parts[1]);
        if (n <= 0) return json(200, { arrived: true, headers: req.headers, method: req.method, body: body.toString() });
        res.writeHead(Number(url.searchParams.get('code') ?? 302), { Location: `/redirect/${n - 1}` });
        return res.end();
      }
      case 'redirect-abs': {
        res.writeHead(302, { Location: url.searchParams.get('to') ?? '/' });
        return res.end();
      }
      case 'gzip': {
        const payload = gzipSync(JSON.stringify({ gz: true }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        return res.end(payload);
      }
      case 'bomb': {
        // 20 MiB of zeros compresses to a few KiB
        const payload = gzipSync(Buffer.alloc(20 * 1024 * 1024));
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' });
        return res.end(payload);
      }
      case 'big': {
        const size = Number(parts[1] ?? 1) * 1024 * 1024;
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        const chunk = Buffer.alloc(64 * 1024, 97);
        let sent = 0;
        while (sent < size) {
          if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
          sent += chunk.length;
        }
        return res.end();
      }
      case 'cookie-set':
        return json(200, { set: true }, { 'Set-Cookie': ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Path=/'] });
      case 'cookie-echo':
        return json(200, { cookie: req.headers.cookie ?? null });
      case 'digest': {
        // `/digest/md5` or `/digest/sha256`: 401 + challenge until a valid Digest response arrives.
        const algorithm = parts[1] === 'sha256' ? 'SHA-256' : 'MD5';
        const auth = req.headers.authorization;
        const reason = verifyDigest(Array.isArray(auth) ? auth[0] : auth, req.method ?? 'GET', algorithm);
        if (reason === null) return json(200, { authenticated: true, user: DIGEST_CREDENTIALS.username, algorithm, path: url.pathname + url.search });
        const nonce = randomBytes(12).toString('hex');
        DIGEST_NONCES.add(nonce);
        const challenge = `Digest realm="${DIGEST_CREDENTIALS.realm}", qop="auth", nonce="${nonce}", opaque="opaque-${algorithm}", algorithm=${algorithm}, charset=UTF-8`;
        return json(401, { error: 'unauthorized', reason }, { 'WWW-Authenticate': challenge });
      }
      case 'token': {
        // Minimal OAuth 2.0 token endpoint: echoes how the client authenticated so tests can assert variable resolution.
        const form = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
        return json(200, { access_token: `AT-${form.client_id ?? 'anon'}`, token_type: 'Bearer', expires_in: 3600, grant_type: form.grant_type ?? null, authorization: req.headers.authorization ?? null });
      }
      case 'hang':
        return; // never respond
      default:
        res.writeHead(404);
        return res.end('not found');
    }
  };
}

function closer(server: { close(cb: () => void): unknown; closeAllConnections?(): void }): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
}

export async function startServer(): Promise<TestServer> {
  const server = http.createServer(requestHandler() as http.RequestListener);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, close: closer(server) };
}

/** `requestCert` + `ca` turn the listener into a mutual-TLS server that rejects clients without a certificate signed by `ca`. */
export async function startHttpsServer(key: string, cert: string, options: { requestCert?: boolean; ca?: string[] } = {}): Promise<TestServer> {
  const server = https.createServer({ key, cert, ...(options.requestCert ? { requestCert: true, rejectUnauthorized: true, ca: options.ca ?? [cert] } : {}) }, requestHandler() as http.RequestListener);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `https://127.0.0.1:${port}`, port, close: closer(server) };
}

/**
 * HTTP/2 over TLS (ALPN `h2`) with HTTP/1.1 fallback (`allowHTTP1`), self-signed `key`/`cert`.
 * Requests arrive through the http2 compatibility API; `req.httpVersion` is `2.0` for h2 clients.
 */
export async function startHttp2Server(key: string, cert: string, options: { allowHTTP1?: boolean } = {}): Promise<TestServer> {
  const server = http2.createSecureServer({ key, cert, allowHTTP1: options.allowHTTP1 ?? true });
  server.on('request', requestHandler() as unknown as (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `https://127.0.0.1:${port}`, port, close: closer(server) };
}

let counter = 0;
export function makeSpec(overrides: Partial<HttpRequestSpec> & { url: string }): HttpRequestSpec {
  return {
    id: `req-${++counter}`,
    method: 'GET',
    headers: [],
    body: { kind: 'none' },
    timeoutMs: 10_000,
    followRedirects: true,
    maxRedirects: 10,
    maxResponseBytes: 50 * 1024 * 1024,
    maxRequestBytes: 50 * 1024 * 1024,
    tls: { rejectUnauthorized: true },
    ...overrides,
  };
}
