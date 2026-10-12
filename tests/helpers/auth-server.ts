/**
 * Local HTTP server for authentication tests. It verifies Digest and Hawk credentials with its own,
 * independent implementation of the specs (so the providers are checked against the spec, not
 * against themselves) and plays an RFC 8628 device-flow identity provider.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AuthTestServer {
  url: string;
  /** Parsed `Authorization` fields of every verified Digest request (no password). */
  digestRequests: Array<Record<string, string>>;
  /** Bodies posted to the device endpoints. */
  deviceRequests: Array<{ path: string; body: URLSearchParams; authorization?: string }>;
  resetDevice(): void;
  close(): Promise<void>;
}

export const DIGEST_USER = 'admin';
export const DIGEST_PASSWORD = 'digest-password-literal';
export const DIGEST_REALM = 'metrics';
export const HAWK_ID = 'dh37fgj492je';
export const HAWK_KEY = 'hawk-key-literal-9981';
export const DEVICE_TOKEN = 'DEVICE-AT-1';

function parseAuthParams(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)=(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) out[m[1]!.toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]!;
  return out;
}

/** Independent RFC 7616 response computation (plain loops, no shared code with the provider). */
function digestResponse(p: Record<string, string>, method: string, body: Buffer): string | undefined {
  const algo = (p.algorithm ?? 'MD5').toUpperCase();
  const base = algo.replace(/-SESS$/, '');
  const hashName = base === 'MD5' ? 'md5' : base === 'SHA-256' ? 'sha256' : base === 'SHA-512-256' ? 'sha512-256' : undefined;
  if (!hashName) return undefined;
  const H = (s: string | Buffer) => createHash(hashName).update(s).digest('hex');
  let a1 = H(`${DIGEST_USER}:${DIGEST_REALM}:${DIGEST_PASSWORD}`);
  if (algo.endsWith('-SESS')) a1 = H(`${a1}:${p.nonce}:${p.cnonce}`);
  const a2 = p.qop === 'auth-int' ? H(`${method}:${p.uri}:${H(body)}`) : H(`${method}:${p.uri}`);
  if (p.qop) return H(`${a1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${a2}`);
  return H(`${a1}:${p.nonce}:${a2}`);
}

/** Independent Hawk 1.1 MAC computation. */
function hawkMac(p: Record<string, string>, method: string, path: string, host: string, port: string): string {
  const lines = ['hawk.1.header', p.ts, p.nonce, method.toUpperCase(), path, host.toLowerCase(), port, p.hash ?? '', p.ext ?? ''];
  let normalized = `${lines.join('\n')}\n`;
  if (p.app) normalized += `${p.app}\n${p.dlg ?? ''}\n`;
  return createHmac('sha256', HAWK_KEY).update(normalized).digest('base64');
}

function hawkPayloadHash(contentType: string, body: Buffer): string {
  return createHash('sha256').update(`hawk.1.payload\n${contentType.split(';')[0]!.trim().toLowerCase()}\n`).update(body).update('\n').digest('base64');
}

async function readAll(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startAuthTestServer(): Promise<AuthTestServer> {
  const digestRequests: Array<Record<string, string>> = [];
  const deviceRequests: AuthTestServer['deviceRequests'] = [];
  let devicePolls = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readAll(req);
    const json = (status: number, value: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // ---------------------------------------------------------------- Digest
    if (path.startsWith('/digest/') || path === '/admin/metrics') {
      const variant = path === '/admin/metrics' ? 'md5' : path.split('/')[2]!;
      const nonce = variant === 'fixed' ? 'fixed-nonce-1' : randomBytes(12).toString('hex');
      const opaque = 'opaque-value-9';
      const challenges: Record<string, string | string[]> = {
        md5: `Digest realm="${DIGEST_REALM}", qop="auth", nonce="${nonce}", opaque="${opaque}", algorithm=MD5`,
        // Preferred algorithm first (RFC 7616 section 3.3), MD5 fallback second, in ONE header value.
        sha256: `Digest realm="${DIGEST_REALM}", qop="auth", nonce="${nonce}", algorithm=SHA-256, Digest realm="${DIGEST_REALM}", qop="auth", nonce="${nonce}", algorithm=MD5`,
        sess: `Digest realm="${DIGEST_REALM}", qop="auth", nonce="${nonce}", algorithm=SHA-256-sess`,
        'auth-int': `Digest realm="${DIGEST_REALM}", qop="auth-int", nonce="${nonce}", algorithm=MD5`,
        legacy: `Digest realm="${DIGEST_REALM}", nonce="${nonce}"`,
        fixed: `Digest realm="${DIGEST_REALM}", qop="auth", nonce="${nonce}", algorithm=MD5`,
        basic: `Basic realm="${DIGEST_REALM}"`,
        // Two header lines: Basic first, Digest second.
        mixed: [`Basic realm="${DIGEST_REALM}"`, `Digest realm="${DIGEST_REALM}", qop="auth", nonce="${nonce}", algorithm=SHA-256`],
      };
      const challenge = challenges[variant];
      if (!challenge) return json(404, { error: 'unknown digest variant' });
      const auth = req.headers.authorization;
      if (!auth || !/^digest /i.test(auth)) return json(401, { error: 'auth required' }, { 'WWW-Authenticate': challenge });
      const p = parseAuthParams(auth.slice(7));
      digestRequests.push(p);
      const expected = digestResponse(p, method, body);
      const ok = expected !== undefined && p.username === DIGEST_USER && p.realm === DIGEST_REALM && p.response === expected && (variant !== 'fixed' || p.nonce === 'fixed-nonce-1') && (variant === 'legacy' || !!p.cnonce);
      if (!ok) return json(401, { error: 'bad credentials' }, { 'WWW-Authenticate': challenge });
      return json(200, { ok: true, user: p.username, algorithm: p.algorithm ?? 'MD5', qop: p.qop ?? null, nc: p.nc ?? null, body: body.toString('utf8') });
    }

    // ---------------------------------------------------------------- Hawk
    if (path.startsWith('/hawk/') || path === '/admin/audit') {
      const auth = req.headers.authorization;
      if (!auth || !/^hawk /i.test(auth)) return json(401, { error: 'hawk required' }, { 'WWW-Authenticate': 'Hawk' });
      const p = parseAuthParams(auth.slice(5));
      const hostHeader = req.headers.host ?? '';
      const [host, port] = hostHeader.split(':');
      const mac = hawkMac(p, method, url.pathname + url.search, host!, port ?? '80');
      if (p.id !== HAWK_ID || p.mac !== mac) return json(401, { error: 'bad mac' });
      if (p.hash !== undefined && p.hash !== hawkPayloadHash(req.headers['content-type'] ?? '', body)) return json(401, { error: 'bad payload hash' });
      return json(200, { ok: true, id: p.id, hash: p.hash ?? null, ext: p.ext ?? null, app: p.app ?? null, dlg: p.dlg ?? null });
    }

    // ---------------------------------------------------------------- Device flow (RFC 8628)
    if (path.startsWith('/device/')) {
      const form = new URLSearchParams(body.toString('utf8'));
      deviceRequests.push({ path, body: form, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
      if (path === '/device/code') {
        if (!form.get('client_id')) return json(400, { error: 'invalid_request', error_description: 'client_id missing' });
        return json(200, { device_code: 'DC-secret-1', user_code: 'ABCD-EFGH', verification_uri: 'https://idp.test/device', verification_uri_complete: 'https://idp.test/device?user_code=ABCD-EFGH', expires_in: 600, interval: 1 });
      }
      if (path === '/device/token') {
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code' || form.get('device_code') !== 'DC-secret-1') return json(400, { error: 'invalid_grant' });
        devicePolls += 1;
        if (devicePolls === 1) return json(400, { error: 'authorization_pending' });
        if (devicePolls === 2) return json(400, { error: 'slow_down' });
        return json(200, { access_token: DEVICE_TOKEN, refresh_token: 'DEVICE-RT-1', token_type: 'Bearer', expires_in: 3600, scope: 'read' });
      }
      if (path === '/device/token-denied') return json(400, { error: 'access_denied' });
      if (path === '/device/token-expired') return json(400, { error: 'expired_token' });
      return json(404, { error: 'not found' });
    }

    if (path === '/echo') return json(200, { method, path: url.pathname + url.search, headers: req.headers, body: body.toString('utf8') });
    return json(404, { error: 'not found' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    digestRequests,
    deviceRequests,
    resetDevice: () => {
      devicePolls = 0;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
