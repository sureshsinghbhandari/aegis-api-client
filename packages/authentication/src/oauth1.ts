import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AppError, headerValue } from '@aegis/core';
import { bool, emptyResult, str, type AuthContext, type AuthParams, type AuthProvider } from './types';

/** RFC 3986 percent-encoding as required by RFC 5849. */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function collectBodyParams(context: AuthContext): Array<[string, string]> {
  const ct = headerValue([...context.headers], 'content-type') ?? '';
  if (context.body.kind === 'urlencoded') return context.body.entries.map((e) => [e.name, e.value]);
  if (context.body.kind === 'text' && ct.toLowerCase().includes('application/x-www-form-urlencoded')) {
    return [...new URLSearchParams(context.body.text).entries()];
  }
  return [];
}

/** Build the OAuth 1.0 signature base string and signature (exported for tests). */
export function oauth1Sign(params: AuthParams, context: AuthContext, fixed?: { nonce?: string; timestamp?: string }) {
  const method = str(params, 'signatureMethod', 'HMAC-SHA1').toUpperCase();
  const consumerKey = str(params, 'consumerKey');
  const consumerSecret = str(params, 'consumerSecret');
  const token = str(params, 'token');
  const tokenSecret = str(params, 'tokenSecret');
  if (!consumerKey) throw new AppError('AUTH_FAILED', 'OAuth 1.0 requires a consumer key.');

  const oauth: Array<[string, string]> = [
    ['oauth_consumer_key', consumerKey],
    ['oauth_signature_method', method],
    ['oauth_timestamp', fixed?.timestamp ?? str(params, 'timestamp') ?? String(Math.floor(context.now() / 1000))],
    ['oauth_nonce', fixed?.nonce ?? (str(params, 'nonce') || randomBytes(12).toString('hex'))],
    ['oauth_version', str(params, 'version', '1.0')],
  ];
  if (!oauth[2]![1]) oauth[2]![1] = String(Math.floor(context.now() / 1000));
  if (token) oauth.push(['oauth_token', token]);
  const callback = str(params, 'callback');
  if (callback) oauth.push(['oauth_callback', callback]);
  const verifier = str(params, 'verifier');
  if (verifier) oauth.push(['oauth_verifier', verifier]);
  if (bool(params, 'includeBodyHash') && context.body.kind === 'text') {
    oauth.push(['oauth_body_hash', createHash('sha1').update(context.body.text).digest('base64')]);
  }

  const url = new URL(context.url);
  const queryPairs: Array<[string, string]> = [...url.searchParams.entries()];
  const all = [...queryPairs, ...collectBodyParams(context), ...oauth].map(([k, v]) => [rfc3986(k), rfc3986(v)] as [string, string]);
  all.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const paramString = all.map(([k, v]) => `${k}=${v}`).join('&');

  const defaultPort = (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80');
  const base = `${url.protocol}//${url.hostname.toLowerCase()}${url.port && !defaultPort ? `:${url.port}` : ''}${url.pathname}`;
  const baseString = [context.method.toUpperCase(), rfc3986(base), rfc3986(paramString)].join('&');
  const signingKey = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`;

  let signature: string;
  if (method === 'HMAC-SHA1') signature = createHmac('sha1', signingKey).update(baseString).digest('base64');
  else if (method === 'HMAC-SHA256') signature = createHmac('sha256', signingKey).update(baseString).digest('base64');
  else if (method === 'PLAINTEXT') signature = signingKey;
  else throw new AppError('AUTH_FAILED', `Unsupported OAuth 1.0 signature method "${method}". Supported: HMAC-SHA1, HMAC-SHA256, PLAINTEXT.`);

  return { oauth, signature, baseString };
}

export const oauth1Provider: AuthProvider = {
  type: 'oauth1',
  apply(params, context) {
    const { oauth, signature } = oauth1Sign(params, context);
    const entries = [...oauth, ['oauth_signature', signature] as [string, string]];
    const result = emptyResult();
    if (bool(params, 'addParamsToHeader', true)) {
      const realm = str(params, 'realm');
      const parts = entries.filter(([, v]) => v !== '' || bool(params, 'addEmptyParamsToSign')).map(([k, v]) => `${rfc3986(k)}="${rfc3986(v)}"`);
      result.headers.push({ name: 'Authorization', value: `OAuth ${realm ? `realm="${realm}", ` : ''}${parts.join(', ')}` });
    } else {
      for (const [k, v] of entries) result.query.push({ name: k, value: v });
    }
    return result;
  },
};
