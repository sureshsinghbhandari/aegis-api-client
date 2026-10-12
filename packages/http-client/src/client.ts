import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Agent, ProxyAgent, request as undiciRequest, type Dispatcher } from 'undici';
import {
  AppError,
  newId,
  headerValue,
  type CookieJarHook,
  type HeaderPair,
  type HttpRequestSpec,
  type HttpResponse,
  type ProtocolClient,
  type RedirectHop,
} from '@aegis/core';
import { encodeBody } from './body';
import { createTimedConnector, type ObservedConnection } from './connector';
import { shouldBypassProxy } from './proxy';

const DEFAULT_SPILL_BYTES = 8 * 1024 * 1024;
const PREVIEW_BYTES = 1024 * 1024;

export interface HttpClientHooks {
  cookies?: CookieJarHook;
  /** Called before each hop; throw to block (policy: blocked hosts, local-only, ...). */
  beforeRequest?(url: URL): void | Promise<void>;
}

/** Per-send state shared between hops: dispatchers per origin/proxy and every connection they opened. */
interface SendState {
  dispatchers: Map<string, Dispatcher>;
  connections: ObservedConnection[];
}

export class HttpProtocolClient implements ProtocolClient<HttpRequestSpec, HttpResponse> {
  readonly protocol = 'http';
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly hooks: HttpClientHooks = {}) {}

  async cancel(requestId: string): Promise<void> {
    this.inflight.get(requestId)?.abort(new AppError('REQUEST_CANCELLED', 'The request was cancelled.'));
  }

  isInflight(requestId: string): boolean {
    return this.inflight.has(requestId);
  }

  /** `perCall` hooks (cookie jar of the active workspace, policy checks) are merged over the constructor hooks. */
  async send(spec: HttpRequestSpec, perCall: HttpClientHooks = {}): Promise<HttpResponse> {
    const hooks: HttpClientHooks = { ...this.hooks, ...perCall };
    const controller = new AbortController();
    this.inflight.set(spec.id, controller);
    const timer = setTimeout(() => controller.abort(new AppError('REQUEST_TIMEOUT', `The request timed out after ${spec.timeoutMs} ms.`, { timeoutMs: spec.timeoutMs })), spec.timeoutMs);
    const state: SendState = { dispatchers: new Map(), connections: [] };
    try {
      return await this.execute(spec, controller.signal, state, hooks);
    } catch (error) {
      throw this.mapError(error, controller.signal, spec);
    } finally {
      clearTimeout(timer);
      this.inflight.delete(spec.id);
      await Promise.all([...state.dispatchers.values()].map((d) => d.close().catch(() => undefined)));
    }
  }

  // ------------------------------------------------------------------ internals

  private dispatcherFor(spec: HttpRequestSpec, url: URL, state: SendState, notes: string[]): Dispatcher {
    const proxy = spec.proxy && !shouldBypassProxy(url.href, spec.proxy.noProxy) ? spec.proxy : undefined;
    const key = `${url.origin}|${proxy?.url ?? ''}`;
    const existing = state.dispatchers.get(key);
    if (existing) return existing;
    const tls = spec.tls;
    const tlsOptions: Record<string, unknown> = { rejectUnauthorized: tls.rejectUnauthorized };
    if (tls.ca?.length) tlsOptions.ca = tls.ca;
    const cc = tls.clientCertificate;
    if (cc?.pfxBase64) {
      tlsOptions.pfx = Buffer.from(cc.pfxBase64, 'base64');
      if (cc.passphrase) tlsOptions.passphrase = cc.passphrase;
    } else if (cc?.cert && cc.key) {
      tlsOptions.cert = cc.cert;
      tlsOptions.key = cc.key;
      if (cc.passphrase) tlsOptions.passphrase = cc.passphrase;
    }
    if (!tls.rejectUnauthorized) notes.push('WARNING: TLS certificate validation is disabled for this request.');
    if (cc && url.protocol === 'https:') notes.push(`Client certificate attached${cc.pfxBase64 ? ' (PKCS#12)' : ''}.`);
    const version = spec.httpVersion ?? 'auto';
    const allowH2 = version !== '1.1';
    let dispatcher: Dispatcher;
    if (proxy) {
      const token = proxy.username ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}` : undefined;
      dispatcher = new ProxyAgent({
        uri: proxy.url,
        ...(token ? { token } : {}),
        allowH2,
        requestTls: { ...tlsOptions, allowH2 },
        proxyTls: { rejectUnauthorized: tls.rejectUnauthorized, ...(tls.ca?.length ? { ca: tls.ca } : {}) },
      });
      notes.push(`Via proxy ${new URL(proxy.url).host}.`);
      if (spec.hosts && Object.keys(spec.hosts).length) notes.push('Hosts overrides do not apply to proxied requests (the proxy resolves the name).');
    } else {
      const connect = createTimedConnector({
        tls: tlsOptions,
        allowH2,
        ...(version === '2' ? { preferH2: true } : {}),
        ...(spec.hosts ? { hosts: spec.hosts } : {}),
        onConnection: (info) => state.connections.push(info),
      });
      dispatcher = new Agent({ connect, allowH2, keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });
    }
    state.dispatchers.set(key, dispatcher);
    return dispatcher;
  }

  private async execute(spec: HttpRequestSpec, signal: AbortSignal, state: SendState, hooks: HttpClientHooks): Promise<HttpResponse> {
    const startedAt = Date.now();
    const t0 = performance.now();
    const redirects: RedirectHop[] = [];
    const notes: string[] = [];
    const cookies = spec.disableCookies ? undefined : hooks.cookies;
    if (spec.disableCookies && hooks.cookies) notes.push('Cookie jar disabled for this request (request settings).');
    let method = spec.method.toUpperCase();
    let url = new URL(spec.url);
    let headers: HeaderPair[] = spec.headers.map((h) => ({ ...h }));
    let bodySpec = spec.body;
    let requestSize = 0;

    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new AppError('VALIDATION_FAILED', `Unsupported URL scheme "${url.protocol}". Only http and https are supported.`);
      }
      await hooks.beforeRequest?.(url);
      signal.throwIfAborted();

      const encoded = await encodeBody(bodySpec, spec.maxRequestBytes, spec.workingDirectory ? { workingDirectory: spec.workingDirectory } : {});
      const hopHeaders = headers.filter((h) => !['content-length', 'host'].includes(h.name.toLowerCase()));
      if (encoded.contentType && !headerValue(hopHeaders, 'content-type')) hopHeaders.push({ name: 'Content-Type', value: encoded.contentType });
      const jarCookie = await cookies?.getCookieHeader(url.href);
      if (jarCookie) {
        const explicit = hopHeaders.find((h) => h.name.toLowerCase() === 'cookie');
        if (explicit) explicit.value = `${explicit.value}; ${jarCookie}`;
        else hopHeaders.push({ name: 'Cookie', value: jarCookie });
      }
      const sendsBody = bodySpec.kind !== 'none';
      if (sendsBody) hopHeaders.push({ name: 'Content-Length', value: String(encoded.length) });
      else if (['POST', 'PUT', 'PATCH'].includes(method)) hopHeaders.push({ name: 'Content-Length', value: '0' });

      const flat: string[] = [];
      for (const h of hopHeaders) flat.push(h.name, h.value);
      requestSize += Buffer.byteLength(`${method} ${url.pathname}${url.search} HTTP/1.1\r\n${hopHeaders.map((h) => `${h.name}: ${h.value}`).join('\r\n')}\r\n\r\n`) + (sendsBody ? encoded.length : 0);

      const dispatcher = this.dispatcherFor(spec, url, state, notes);
      const connectionsBefore = state.connections.length;
      const sentAt = performance.now();
      const res = await undiciRequest(url, {
        method: method as Dispatcher.HttpMethod,
        headers: flat,
        ...(sendsBody ? { body: encoded.open() as Buffer | Readable } : {}),
        dispatcher,
        signal,
        headersTimeout: spec.timeoutMs,
        bodyTimeout: spec.timeoutMs,
      });
      const headersAt = performance.now();

      const responseHeaders: HeaderPair[] = [];
      const setCookies: string[] = [];
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) responseHeaders.push({ name, value: v });
          if (name === 'set-cookie') setCookies.push(...value);
        } else {
          responseHeaders.push({ name, value: String(value) });
          if (name === 'set-cookie') setCookies.push(String(value));
        }
      }
      if (setCookies.length) await cookies?.storeSetCookies(url.href, setCookies);

      const status = res.statusCode;
      const location = headerValue(responseHeaders, 'location');
      if (spec.followRedirects && location && [301, 302, 303, 307, 308].includes(status)) {
        res.body.on('error', () => undefined); // discarding the redirect body
        res.body.destroy();
        if (hop >= spec.maxRedirects) throw new AppError('TOO_MANY_REDIRECTS', `Stopped after ${spec.maxRedirects} redirects.`, { max: spec.maxRedirects });
        const next = new URL(location, url);
        redirects.push({ url: url.href, status, location: next.href });
        if (next.origin !== url.origin) {
          const keepAuth = spec.followAuthorizationHeader === true && headers.some((h) => h.name.toLowerCase() === 'authorization');
          headers = headers.filter((h) => !['cookie', 'proxy-authorization'].includes(h.name.toLowerCase()) && (keepAuth || h.name.toLowerCase() !== 'authorization'));
          if (keepAuth) notes.push(`WARNING: the Authorization header was forwarded to a different origin (${next.origin}) because "Follow Authorization header" is enabled for this request.`);
          else notes.push(`Redirect to a different origin (${next.origin}): credentials were not forwarded.`);
        }
        if (spec.removeRefererHeaderOnRedirect && headers.some((h) => h.name.toLowerCase() === 'referer')) {
          headers = headers.filter((h) => h.name.toLowerCase() !== 'referer');
          notes.push('Referer header removed on redirect (request settings).');
        }
        const switchToGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
        if (switchToGet && !spec.followOriginalHttpMethod) {
          if (method !== 'HEAD') method = 'GET';
          bodySpec = { kind: 'none' };
          headers = headers.filter((h) => !['content-type', 'content-length', 'content-encoding'].includes(h.name.toLowerCase()));
        } else if (switchToGet) {
          notes.push(`Kept ${method} and the request body on a ${status} redirect ("Follow original HTTP method" is enabled).`);
        }
        url = next;
        continue;
      }

      // ----- read body (decompressed, size-limited, spilling to disk when large)
      const hasBody = method !== 'HEAD' && status !== 204 && status !== 304 && !(status >= 100 && status < 200);
      const read = hasBody ? await readBody(res.body, headerValue(responseHeaders, 'content-encoding'), spec, signal) : { body: Buffer.alloc(0), size: 0 };
      const doneAt = performance.now();

      const conn = finalConnection(state.connections, connectionsBefore, url);
      if (conn?.connection.hostOverride) notes.push(`${url.hostname} resolved via hosts override to ${conn.connection.hostOverride}.`);
      if (spec.httpVersion === '2' && conn && conn.httpVersion !== 'HTTP/2') {
        notes.push(url.protocol === 'https:' ? 'HTTP/2 was requested but the server only offered HTTP/1.1.' : 'HTTP/2 was requested but is only negotiated over TLS (https); plain http uses HTTP/1.1.');
      }

      return {
        status,
        statusText: STATUS_CODES[status] ?? '',
        httpVersion: conn?.httpVersion ?? 'HTTP/1.1',
        headers: responseHeaders,
        body: read.body,
        size: read.size,
        truncated: !!read.filePath,
        ...(read.filePath ? { bodyFilePath: read.filePath } : {}),
        url: url.href,
        redirects,
        timings: {
          startedAt,
          waitingMs: Math.round(headersAt - sentAt),
          downloadMs: Math.round(doneAt - headersAt),
          totalMs: Math.round(doneAt - t0),
          ...(conn ? { dnsMs: conn.connection.reused ? 0 : conn.dnsMs, connectMs: conn.connection.reused ? 0 : conn.connectMs, tlsMs: conn.connection.reused ? 0 : conn.tlsMs } : {}),
        },
        requestSize,
        setCookies,
        notes,
        ...(conn?.tls ? { tls: conn.tls } : {}),
        ...(conn ? { connection: conn.connection } : {}),
      };
    }
  }

  private mapError(error: unknown, signal: AbortSignal, spec: HttpRequestSpec): AppError {
    if (error instanceof AppError) return error;
    if (signal.aborted && signal.reason instanceof AppError) return signal.reason;
    const e = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    const code = e.code ?? e.cause?.code ?? '';
    const tlsCodes = [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'CERT_UNTRUSTED',
      'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
    ];
    if (tlsCodes.includes(code) || /certificate|self.signed|tls|ssl/i.test(e.message ?? '') && /CERT|SSL|TLS/.test(code)) {
      return new AppError('TLS_ERROR', `TLS error: ${tlsHint(code)}`, { code, ...(spec.tls.rejectUnauthorized ? { hint: 'Add the issuing CA in Settings → Certificates, or ask your administrator.' } : {}) }, { cause: error });
    }
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new AppError('REQUEST_TIMEOUT', `The request timed out after ${spec.timeoutMs} ms.`, { timeoutMs: spec.timeoutMs, code });
    }
    const friendly: Record<string, string> = {
      ENOTFOUND: 'The host name could not be resolved.',
      ECONNREFUSED: 'The connection was refused.',
      ECONNRESET: 'The connection was reset by the server.',
      EAI_AGAIN: 'Temporary DNS failure.',
      EHOSTUNREACH: 'The host is unreachable.',
      ENETUNREACH: 'The network is unreachable.',
      UND_ERR_SOCKET: 'The connection was closed unexpectedly.',
    };
    return new AppError('NETWORK_ERROR', friendly[code] ?? `Network error${code ? ` (${code})` : ''}.`, { code }, { cause: error });
  }
}

/**
 * The connection that served the final hop: a connection opened during that hop, or (keep-alive)
 * the most recent one to the same host, flagged as reused with zero connect timings.
 */
function finalConnection(connections: ObservedConnection[], openedBefore: number, url: URL): ObservedConnection | undefined {
  const fresh = connections.slice(openedBefore);
  const sameHost = (c: ObservedConnection) => c.origin.startsWith(`${url.protocol}//${url.hostname}:`);
  const own = fresh.filter(sameHost).at(-1) ?? fresh.at(-1);
  if (own) return own;
  const previous = connections.filter(sameHost).at(-1);
  return previous ? { ...previous, dnsMs: 0, connectMs: 0, tlsMs: 0, connection: { ...previous.connection, reused: true } } : undefined;
}

function tlsHint(code: string): string {
  const map: Record<string, string> = {
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the server certificate could not be verified (missing intermediate certificate).',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'the issuing certificate authority is not trusted.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'the server uses a self-signed certificate.',
    SELF_SIGNED_CERT_IN_CHAIN: 'a self-signed certificate is in the chain.',
    CERT_HAS_EXPIRED: 'the server certificate has expired.',
    CERT_NOT_YET_VALID: 'the server certificate is not yet valid.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'the certificate does not match the host name.',
  };
  return map[code] ?? `the secure connection failed${code ? ` (${code})` : ''}.`;
}

interface BodyRead {
  body: Buffer;
  size: number;
  filePath?: string;
}

function decompressors(encoding: string | undefined) {
  const list = (encoding ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'identity');
  return list.reverse().map((enc) => {
    if (enc === 'gzip' || enc === 'x-gzip') return createGunzip();
    if (enc === 'deflate') return createInflate();
    if (enc === 'br') return createBrotliDecompress();
    throw new AppError('NETWORK_ERROR', `Unsupported content-encoding "${enc}".`);
  });
}

async function readBody(source: Readable, encoding: string | undefined, spec: HttpRequestSpec, signal: AbortSignal): Promise<BodyRead> {
  const stages = decompressors(encoding);
  let stream: Readable = source;
  for (const stage of stages) {
    stream.on('error', (e) => stage.destroy(e));
    stream = stream.pipe(stage);
  }
  const spillAt = spec.spillThresholdBytes ?? DEFAULT_SPILL_BYTES;
  let chunks: Buffer[] = [];
  let preview: Buffer | undefined;
  let size = 0;
  let file: { path: string; stream: ReturnType<typeof createWriteStream> } | undefined;
  const abort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer;
      size += chunk.length;
      if (size > spec.maxResponseBytes) {
        // Applies to the DECOMPRESSED size, so decompression bombs are stopped here.
        throw new AppError('RESPONSE_TOO_LARGE', 'The response exceeded the configured maximum size and was aborted.', { limit: spec.maxResponseBytes });
      }
      if (!file && size > spillAt) {
        const dir = spec.spillDirectory ?? path.join(os.tmpdir(), 'aegis-responses');
        await mkdir(dir, { recursive: true });
        const filePath = path.join(dir, `${newId()}.body`);
        file = { path: filePath, stream: createWriteStream(filePath, { flags: 'wx', mode: 0o600 }) };
        for (const c of chunks) file.stream.write(c);
        preview = Buffer.concat(chunks).subarray(0, PREVIEW_BYTES);
        chunks = [];
      }
      if (file) {
        if (!file.stream.write(chunk)) await new Promise<void>((resolve) => file!.stream.once('drain', resolve));
      } else {
        chunks.push(chunk);
      }
    }
    if (file) {
      await new Promise<void>((resolve, reject) => file!.stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve())));
      return { body: preview ?? Buffer.alloc(0), size, filePath: file.path };
    }
    return { body: Buffer.concat(chunks), size };
  } catch (error) {
    if (file) {
      file.stream.destroy();
      await rm(file.path, { force: true });
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
