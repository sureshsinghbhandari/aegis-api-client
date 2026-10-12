import {
  AppError,
  applyPathVariables,
  buildRequestUrl,
  headerValue,
  splitUrl,
  type BodySpec,
  type HeaderPair,
  type HttpRequestSpec,
  type HttpVersionPreference,
  type KeyValueEntry,
  type MultipartPart,
  type ProxyOptions,
  type RawLanguage,
  type RequestBody,
  type RequestDraft,
  type TlsOptions,
} from '@aegis/core';

export const DEFAULT_USER_AGENT = 'AegisApiClient/0.1';

const RAW_CONTENT_TYPES: Record<RawLanguage, string> = {
  json: 'application/json',
  xml: 'application/xml',
  text: 'text/plain',
  html: 'text/html',
  javascript: 'application/javascript',
};

export interface NetworkLimits {
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
}

export interface PrepareOptions {
  id: string;
  limits: NetworkLimits;
  tls: TlsOptions;
  proxy?: ProxyOptions;
  userAgent?: string;
  spillDirectory?: string;
  /** Global default; `draft.settings.httpVersion` wins. */
  httpVersion?: HttpVersionPreference;
  /** Host overrides already filtered by policy (host -> IP). */
  hosts?: Record<string, string>;
  /** Root for relative file paths (Settings -> General -> Working directory). */
  workingDirectory?: string;
}

/**
 * URL built without percent-encoding the query (Postman "Encode URL automatically" off):
 * keys and values are joined as typed. Path variables are still substituted and the
 * fragment is dropped. The WHATWG parser still rejects/escapes what it must (spaces, ...).
 */
export function buildRawRequestUrl(url: string, queryParams: readonly KeyValueEntry[], pathVariables: readonly KeyValueEntry[]): string {
  const withVars = applyPathVariables(url.trim(), pathVariables);
  const { base, query, hash: _hash } = splitUrl(withVars);
  const extra = queryParams
    .filter((e) => e.enabled && e.key !== '')
    .map((e) => (e.value === '' ? e.key : `${e.key}=${e.value}`))
    .join('&');
  const merged = [query, extra].filter(Boolean).join('&');
  const full = base + (merged ? `?${merged}` : '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(full) ? full : `http://${full}`;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Reject header names/values that could split the request (CRLF injection) or are malformed. */
export function assertValidHeader(name: string, value: string): void {
  if (!TOKEN.test(name)) throw new AppError('VALIDATION_FAILED', `Invalid header name "${name.slice(0, 60)}".`);
  if (/[\r\n\0]/.test(value)) throw new AppError('VALIDATION_FAILED', `The value of header "${name}" contains invalid control characters.`);
}

/**
 * Convert a variable-resolved request draft into the wire-level spec.
 * The stored request is never mutated. Authentication is applied afterwards
 * (see {@link applyAuthToSpec}) because signing needs the final URL/body.
 */
export function buildHttpRequestSpec(draft: RequestDraft, options: PrepareOptions): HttpRequestSpec {
  const encodeUrl = draft.settings.encodeUrl !== false;
  const url = encodeUrl ? buildRequestUrl(draft.url, draft.queryParams, draft.pathVariables) : buildRawRequestUrl(draft.url, draft.queryParams, draft.pathVariables);
  try {
    new URL(url);
  } catch (cause) {
    throw new AppError('VALIDATION_FAILED', `The URL is not valid: ${url.slice(0, 200)}`, {}, { cause });
  }

  const headers: HeaderPair[] = [];
  for (const h of draft.headers) {
    if (!h.enabled || !h.key.trim()) continue;
    assertValidHeader(h.key.trim(), h.value);
    headers.push({ name: h.key.trim(), value: h.value });
  }

  const body = toBodySpec(draft);
  if (draft.body.mode === 'raw' && !headerValue(headers, 'content-type')) {
    headers.push({ name: 'Content-Type', value: draft.body.contentType || RAW_CONTENT_TYPES[draft.body.rawLanguage ?? 'text'] });
  }
  if (draft.body.mode === 'graphql' && !headerValue(headers, 'content-type')) {
    headers.push({ name: 'Content-Type', value: draft.body.contentType || 'application/json' });
  }
  if (!headerValue(headers, 'user-agent')) headers.push({ name: 'User-Agent', value: options.userAgent ?? DEFAULT_USER_AGENT });
  if (!headerValue(headers, 'accept')) headers.push({ name: 'Accept', value: '*/*' });
  if (!headerValue(headers, 'accept-encoding')) headers.push({ name: 'Accept-Encoding', value: 'gzip, deflate, br' });

  const settings = draft.settings;
  return {
    id: options.id,
    method: draft.method.trim().toUpperCase() || 'GET',
    url,
    headers,
    body,
    timeoutMs: settings.timeoutMs ?? options.limits.timeoutMs,
    followRedirects: settings.followRedirects ?? options.limits.followRedirects,
    maxRedirects: settings.maxRedirects ?? options.limits.maxRedirects,
    maxResponseBytes: Math.min(settings.maxResponseBytes ?? options.limits.maxResponseBytes, options.limits.maxResponseBytes),
    maxRequestBytes: options.limits.maxRequestBytes,
    tls: options.tls,
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.spillDirectory ? { spillDirectory: options.spillDirectory } : {}),
    httpVersion: settings.httpVersion ?? options.httpVersion ?? 'auto',
    encodeUrl,
    ...(settings.disableCookies ? { disableCookies: true } : {}),
    ...(settings.followOriginalHttpMethod ? { followOriginalHttpMethod: true } : {}),
    ...(settings.followAuthorizationHeader ? { followAuthorizationHeader: true } : {}),
    ...(settings.removeRefererHeaderOnRedirect ? { removeRefererHeaderOnRedirect: true } : {}),
    ...(options.hosts && Object.keys(options.hosts).length ? { hosts: options.hosts } : {}),
    ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
  };
}

function toBodySpec(draft: RequestDraft): BodySpec {
  const b = draft.body;
  switch (b.mode) {
    case 'none':
      return { kind: 'none' };
    case 'raw':
      return { kind: 'text', text: b.raw ?? '' };
    case 'urlencoded':
      return { kind: 'urlencoded', entries: (b.urlencoded ?? []).filter((e) => e.enabled && e.key !== '').map((e) => ({ name: e.key, value: e.value })) };
    case 'formdata': {
      const parts: MultipartPart[] = [];
      for (const f of b.formData ?? []) {
        if (!f.enabled || !f.key) continue;
        if (f.type === 'file') {
          const filePath = f.filePath ?? f.value;
          if (!filePath) throw new AppError('VALIDATION_FAILED', `No file selected for form field "${f.key}".`);
          parts.push({ kind: 'file', name: f.key, path: filePath, ...(f.contentType ? { contentType: f.contentType } : {}) });
        } else {
          parts.push({ kind: 'text', name: f.key, value: f.value, ...(f.contentType ? { contentType: f.contentType } : {}) });
        }
      }
      return { kind: 'multipart', parts };
    }
    case 'binary':
      if (!b.filePath) throw new AppError('VALIDATION_FAILED', 'No file selected for the binary body.');
      return { kind: 'file', path: b.filePath };
    case 'graphql':
      return { kind: 'text', text: graphqlBodyText(b.graphql) };
  }
}

/**
 * JSON document for a GraphQL body: `{ query, variables?, operationName? }`.
 * `variables` is JSON text in the draft; empty text omits the key, invalid JSON is a validation error.
 */
export function graphqlBodyText(graphql: RequestBody['graphql']): string {
  const g = graphql ?? { query: '', variables: '' };
  const doc: { query: string; variables?: unknown; operationName?: string } = { query: g.query };
  const vars = (g.variables ?? '').trim();
  if (vars !== '') {
    try {
      doc.variables = JSON.parse(vars);
    } catch (cause) {
      throw new AppError('VALIDATION_FAILED', 'The GraphQL variables are not valid JSON.', {}, { cause });
    }
  }
  if (g.operationName && g.operationName.trim() !== '') doc.operationName = g.operationName.trim();
  return JSON.stringify(doc);
}

/** Merge an auth result into the spec: auth headers replace same-named headers; query parameters are appended. */
export function applyAuthToSpec(spec: HttpRequestSpec, result: { headers: HeaderPair[]; query: Array<{ name: string; value: string }> }): HttpRequestSpec {
  let headers = spec.headers;
  for (const h of result.headers) {
    assertValidHeader(h.name, h.value);
    headers = [...headers.filter((x) => x.name.toLowerCase() !== h.name.toLowerCase()), h];
  }
  let url = spec.url;
  if (result.query.length) {
    const u = new URL(url);
    for (const q of result.query) u.searchParams.append(q.name, q.value);
    url = u.toString();
  }
  return { ...spec, headers, url };
}
