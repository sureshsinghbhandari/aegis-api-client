import { createHash, createHmac, randomUUID } from 'node:crypto';
import { AppError, headerValue } from '@aegis/core';
import { emptyResult, str, type AuthContext, type AuthProvider } from './types';

/**
 * Akamai EdgeGrid request signing (EG1-HMAC-SHA256), as documented at
 * https://techdocs.akamai.com/developer/docs/authenticate-with-edgegrid:
 *
 *   auth = "EG1-HMAC-SHA256 client_token=..;access_token=..;timestamp=..;nonce=..;"
 *   signing_key = base64(HMAC-SHA256(key = client_secret, data = timestamp))
 *   data = METHOD \t scheme \t host \t path?query \t canonical_headers \t content_hash \t auth
 *   signature = base64(HMAC-SHA256(key = signing_key, data))
 *   Authorization: auth + "signature=" + signature
 *
 * `canonical_headers` is `name:value` (lower-cased name, value trimmed with runs of whitespace
 * collapsed) for every header in `headersToSign` that is present, joined by tabs (empty when none).
 * `content_hash` is `base64(SHA-256(body))` for POST requests only, with the body truncated to
 * `maxBody` bytes (default 131072) before hashing; empty for every other method.
 */

export const EDGEGRID_DEFAULT_MAX_BODY = 131072;

export interface EdgeGridInputs {
  clientToken: string;
  clientSecret: string;
  accessToken: string;
  method: string;
  url: string;
  /** Optional host override (Postman "Base URL"); the request host is used when absent. */
  baseUrl?: string;
  timestamp: string;
  nonce: string;
  headers: ReadonlyArray<{ name: string; value: string }>;
  headersToSign: readonly string[];
  body?: string | Buffer;
  maxBody?: number;
}

export interface EdgeGridHeader {
  value: string;
  dataToSign: string;
  signature: string;
}

/** `yyyyMMddTHH:mm:ss+0000` (always UTC). */
export function edgeGridTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}+0000`;
}

const b64hmac = (key: string | Buffer, data: string): string => createHmac('sha256', key).update(data).digest('base64');

/** Build the EdgeGrid Authorization header. Exported for tests with a fixed timestamp/nonce. */
export function buildEdgeGridHeader(inputs: EdgeGridInputs): EdgeGridHeader {
  if (!inputs.clientToken || !inputs.clientSecret || !inputs.accessToken) throw new AppError('AUTH_FAILED', 'EdgeGrid requires a client token, a client secret and an access token.');
  const url = new URL(inputs.url);
  const host = inputs.baseUrl ? new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(inputs.baseUrl) ? inputs.baseUrl : `https://${inputs.baseUrl}`).host : url.host;
  const method = inputs.method.toUpperCase();
  const auth = `EG1-HMAC-SHA256 client_token=${inputs.clientToken};access_token=${inputs.accessToken};timestamp=${inputs.timestamp};nonce=${inputs.nonce};`;

  const canonicalHeaders = inputs.headersToSign
    .map((name) => {
      const value = headerValue([...inputs.headers], name);
      return value === undefined ? undefined : `${name.toLowerCase()}:${value.trim().replace(/\s+/g, ' ')}`;
    })
    .filter((h): h is string => h !== undefined)
    .join('\t');

  let contentHash = '';
  if (method === 'POST' && inputs.body !== undefined && inputs.body.length > 0) {
    const max = inputs.maxBody ?? EDGEGRID_DEFAULT_MAX_BODY;
    const raw = Buffer.isBuffer(inputs.body) ? inputs.body : Buffer.from(inputs.body, 'utf8');
    contentHash = createHash('sha256').update(raw.subarray(0, max)).digest('base64');
  }

  const dataToSign = [method, url.protocol.replace(':', ''), host, `${url.pathname}${url.search}`, canonicalHeaders, contentHash, auth].join('\t');
  const signingKey = b64hmac(inputs.clientSecret, inputs.timestamp);
  const signature = b64hmac(signingKey, dataToSign);
  return { value: `${auth}signature=${signature}`, dataToSign, signature };
}

function bodyOf(context: AuthContext): string | undefined {
  if (context.body.kind === 'text') return context.body.text;
  if (context.body.kind === 'urlencoded') return new URLSearchParams(context.body.entries.map((e) => [e.name, e.value] as [string, string])).toString();
  if (context.body.kind === 'none') return '';
  return undefined;
}

/** Postman-compatible parameter names: accessToken, clientToken, clientSecret, baseURL, nonce, timestamp, headersToSign, maxBodySize. */
export const edgeGridProvider: AuthProvider = {
  type: 'edgegrid',
  apply(params, context) {
    const body = bodyOf(context);
    const result = emptyResult();
    if (body === undefined && context.method.toUpperCase() === 'POST') result.notes.push('WARNING: EdgeGrid content hash skipped: the request body cannot be hashed (file or multipart).');
    const maxBody = Number(str(params, 'maxBodySize'));
    const baseUrl = str(params, 'baseURL') || str(params, 'baseUrl');
    const header = buildEdgeGridHeader({
      clientToken: str(params, 'clientToken'),
      clientSecret: str(params, 'clientSecret'),
      accessToken: str(params, 'accessToken'),
      method: context.method,
      url: context.url,
      ...(baseUrl ? { baseUrl } : {}),
      timestamp: str(params, 'timestamp') || edgeGridTimestamp(new Date(context.now())),
      nonce: str(params, 'nonce') || randomUUID(),
      headers: context.headers,
      headersToSign: str(params, 'headersToSign')
        .split(/[,\s]+/)
        .map((h) => h.trim())
        .filter(Boolean),
      ...(body !== undefined ? { body } : {}),
      ...(Number.isFinite(maxBody) && maxBody > 0 ? { maxBody } : {}),
    });
    result.headers.push({ name: 'Authorization', value: header.value });
    result.notes.push('Akamai EdgeGrid EG1-HMAC-SHA256.');
    return result;
  },
};
