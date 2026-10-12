import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AppError, headerValue } from '@aegis/core';
import { bool, emptyResult, str, type AuthContext, type AuthProvider } from './types';

/**
 * Hawk 1.1 HTTP holder-of-key authentication (https://github.com/mozilla/hawk, header version 1):
 * `Authorization: Hawk id="...", ts="...", nonce="...", [hash="..."], [ext="..."], mac="...", [app="...", [dlg="..."]]`.
 * The MAC is an HMAC (sha256 or sha1) over the normalized string
 * `hawk.1.header\n{ts}\n{nonce}\n{METHOD}\n{resource}\n{host}\n{port}\n{hash}\n{ext}\n[{app}\n{dlg}\n]`.
 * The optional payload hash is `base64(H("hawk.1.payload\n{content-type}\n{body}\n"))`.
 */

export const HAWK_ALGORITHMS = ['sha256', 'sha1'];

export interface HawkInputs {
  id: string;
  key: string;
  algorithm: string;
  method: string;
  url: string;
  ts: number;
  nonce: string;
  ext?: string;
  app?: string;
  dlg?: string;
  /** When present a `hash` is included (payload validation). */
  payload?: { contentType: string; body: string | Buffer };
}

export interface HawkHeader {
  value: string;
  mac: string;
  hash?: string;
  normalized: string;
}

function parseContentType(header: string): string {
  return header.split(';')[0]!.trim().toLowerCase();
}

function assertAlgorithm(algorithm: string): string {
  const a = algorithm.toLowerCase();
  if (!HAWK_ALGORITHMS.includes(a)) throw new AppError('AUTH_FAILED', `Unsupported Hawk algorithm "${algorithm}". Supported: ${HAWK_ALGORITHMS.join(', ')}.`);
  return a;
}

/** `base64(H("hawk.1.payload\n{content-type}\n{body}\n"))`. */
export function hawkPayloadHash(algorithm: string, contentType: string, body: string | Buffer): string {
  const h = createHash(assertAlgorithm(algorithm));
  h.update(`hawk.1.payload\n${parseContentType(contentType)}\n`);
  h.update(body);
  h.update('\n');
  return h.digest('base64');
}

/** Build the Hawk Authorization header. Exported for tests with a fixed timestamp/nonce. */
export function buildHawkHeader(inputs: HawkInputs): HawkHeader {
  const algorithm = assertAlgorithm(inputs.algorithm);
  if (!inputs.id || !inputs.key) throw new AppError('AUTH_FAILED', 'Hawk requires an auth id and an auth key.');
  const url = new URL(inputs.url);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const hash = inputs.payload ? hawkPayloadHash(algorithm, inputs.payload.contentType, inputs.payload.body) : undefined;
  const ext = inputs.ext ?? '';
  let normalized = `hawk.1.header\n${inputs.ts}\n${inputs.nonce}\n${inputs.method.toUpperCase()}\n${url.pathname}${url.search}\n${url.hostname.toLowerCase()}\n${port}\n${hash ?? ''}\n`;
  normalized += ext.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  normalized += '\n';
  if (inputs.app) normalized += `${inputs.app}\n${inputs.dlg ?? ''}\n`;
  const mac = createHmac(algorithm, inputs.key).update(normalized).digest('base64');

  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let value = `Hawk id="${esc(inputs.id)}", ts="${inputs.ts}", nonce="${esc(inputs.nonce)}"`;
  if (hash) value += `, hash="${hash}"`;
  if (ext) value += `, ext="${esc(ext)}"`;
  value += `, mac="${mac}"`;
  if (inputs.app) {
    value += `, app="${esc(inputs.app)}"`;
    if (inputs.dlg) value += `, dlg="${esc(inputs.dlg)}"`;
  }
  return { value, mac, ...(hash ? { hash } : {}), normalized };
}

function payloadOf(context: AuthContext): { contentType: string; body: string } | undefined {
  const contentType = headerValue([...context.headers], 'content-type') ?? '';
  if (context.body.kind === 'none') return { contentType, body: '' };
  if (context.body.kind === 'text') return { contentType, body: context.body.text };
  if (context.body.kind === 'urlencoded') {
    return { contentType: contentType || 'application/x-www-form-urlencoded', body: new URLSearchParams(context.body.entries.map((e) => [e.name, e.value] as [string, string])).toString() };
  }
  return undefined;
}

/** Postman-compatible parameter names: authId, authKey, algorithm, user, nonce, extraData, app, delegation, timestamp, includePayloadHash. */
export const hawkProvider: AuthProvider = {
  type: 'hawk',
  apply(params, context) {
    const id = str(params, 'authId');
    const key = str(params, 'authKey');
    if (!id || !key) throw new AppError('AUTH_FAILED', 'Hawk requires an auth id and an auth key.');
    const ts = Number.parseInt(str(params, 'timestamp'), 10);
    const result = emptyResult();
    let payload: { contentType: string; body: string } | undefined;
    if (bool(params, 'includePayloadHash')) {
      payload = payloadOf(context);
      if (!payload) result.notes.push('WARNING: Hawk payload hash skipped: the request body cannot be hashed (file or multipart).');
    }
    const ext = str(params, 'extraData');
    const app = str(params, 'app');
    const dlg = str(params, 'delegation');
    const header = buildHawkHeader({
      id,
      key,
      algorithm: str(params, 'algorithm') || 'sha256',
      method: context.method,
      url: context.url,
      ts: Number.isFinite(ts) && ts > 0 ? ts : Math.floor(context.now() / 1000),
      nonce: str(params, 'nonce') || randomBytes(6).toString('base64url').slice(0, 8),
      ...(ext ? { ext } : {}),
      ...(app ? { app } : {}),
      ...(dlg ? { dlg } : {}),
      ...(payload ? { payload } : {}),
    });
    result.headers.push({ name: 'Authorization', value: header.value });
    result.notes.push(`Hawk ${str(params, 'algorithm') || 'sha256'}${header.hash ? ' with payload hash' : ''}.`);
    return result;
  },
};
