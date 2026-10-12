/**
 * HAR 1.2 (HTTP Archive) -> CollectionBundle. One request per `log.entries[]`
 * entry, one folder per `log.pages[]` page (entries without a page stay at the
 * top level), the recorded response becomes a saved example.
 *
 * Credentials are never imported literally: the values of Authorization,
 * Cookie, Set-Cookie, API-key style headers, query and form parameters are
 * replaced with `{{placeholder}}` variables (see CredentialPlaceholders).
 */
import type { CollectionBundle, FolderNode, FormDataEntry, ImportStats, ImportWarningModel, ItemNode, KeyValueEntry, RequestBody, RequestDraft, RequestExample } from '@aegis/core';
import {
  CredentialPlaceholders,
  DEFAULT_MAX_EXAMPLE_BODY_BYTES,
  PROGRESS_EVERY,
  assertItemCount,
  baseMimeType,
  clampName,
  convertNamedRows,
  emitProgress,
  guardImport,
  isCredentialKey,
  isTextualMime,
  newDraft,
  newStats,
  parseUrlencodedBody,
  rawLanguageFromMime,
  requestNameFromUrl,
  resolveLimits,
  safeFilePath,
  splitRequestUrl,
  stripUrlCredentials,
} from './import-common';
import type { ImportLimitOptions, ResolvedLimits } from './import-common';
import type { JsonObject } from './shared';
import { META, failImport, isRecord, parseJsonInput, toStr } from './shared';
import { WarningCollector } from './warnings';

export interface ParseHarOptions extends ImportLimitOptions {
  /** Collection name; defaults to the first page title or "HAR import". */
  name?: string;
  /** Largest response body copied into an example (default 1 MiB); larger bodies are dropped with a warning. */
  maxExampleBodyBytes?: number;
}

export interface ParseHarResult {
  bundle: CollectionBundle;
  warnings: ImportWarningModel[];
  stats: ImportStats;
  format: 'har-1.2';
}

/** Request headers the engine computes itself; importing them would send stale values. */
const COMPUTED_REQUEST_HEADERS: ReadonlySet<string> = new Set(['content-length', 'host']);

interface Dropped {
  pseudoHeaders: number;
  computedHeaders: number;
  cookies: number;
  timings: number;
}

interface Ctx {
  w: WarningCollector;
  stats: ImportStats;
  limits: ResolvedLimits;
  placeholders: CredentialPlaceholders;
  dropped: Dropped;
  maxBodyBytes: number;
  total: number;
  done: number;
}

// ---------- headers ----------

function convertHeaders(ctx: Ctx, raw: unknown, path: string, kind: 'request' | 'response'): KeyValueEntry[] {
  const { w } = ctx;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    w.warn(path, 'Headers are not an array; ignored', raw);
    return [];
  }
  const out: KeyValueEntry[] = [];
  raw.forEach((h: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(h)) {
      w.warn(at, 'Header is not an object; skipped', h);
      return;
    }
    const name = toStr(h.name);
    if (name === '') {
      w.warn(at, 'Header without a name skipped', h);
      return;
    }
    if (name.startsWith(':')) {
      ctx.dropped.pseudoHeaders += 1;
      return;
    }
    if (kind === 'request' && COMPUTED_REQUEST_HEADERS.has(name.toLowerCase())) {
      ctx.dropped.computedHeaders += 1;
      return;
    }
    const row: KeyValueEntry = { key: name, value: toStr(h.value), enabled: true };
    if (typeof h.comment === 'string' && h.comment !== '') row.description = h.comment;
    out.push(row);
  });
  return ctx.placeholders.scrubRows('header', out, path);
}

// ---------- body ----------

function convertFormParams(ctx: Ctx, params: unknown[], path: string): FormDataEntry[] {
  const out: FormDataEntry[] = [];
  params.forEach((p: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(p)) {
      ctx.w.warn(at, 'Form parameter is not an object; skipped', p);
      return;
    }
    const key = toStr(p.name);
    const isFile = p.fileName !== undefined && p.fileName !== null && p.fileName !== '';
    const entry: FormDataEntry = { key, type: isFile ? 'file' : 'text', value: '', enabled: true };
    if (isFile) {
      const filePath = safeFilePath(ctx.w, p.fileName, `${at}.fileName`);
      if (filePath !== undefined) entry.filePath = filePath;
    } else {
      const value = toStr(p.value);
      entry.value = isCredentialKey(key) ? ctx.placeholders.replace('form', key, value, `${at}.value`) : value;
    }
    if (typeof p.contentType === 'string' && p.contentType !== '') entry.contentType = p.contentType;
    if (typeof p.comment === 'string' && p.comment !== '') entry.description = p.comment;
    out.push(entry);
  });
  return out;
}

function convertPostData(ctx: Ctx, raw: unknown, path: string): RequestBody {
  const { w } = ctx;
  if (raw === undefined || raw === null) return { mode: 'none' };
  if (!isRecord(raw)) {
    w.warn(path, 'postData is not an object; ignored', raw);
    return { mode: 'none' };
  }
  const mime = baseMimeType(raw.mimeType);
  const params = Array.isArray(raw.params) ? raw.params : undefined;
  const text = typeof raw.text === 'string' ? raw.text : undefined;

  if (mime === 'application/x-www-form-urlencoded') {
    const rows = params && params.length > 0 ? convertNamedRows(w, params, `${path}.params`) : text !== undefined ? parseUrlencodedBody(text) : [];
    return { mode: 'urlencoded', urlencoded: ctx.placeholders.scrubRows('form', rows, params && params.length > 0 ? `${path}.params` : `${path}.text`) };
  }
  if (mime === 'multipart/form-data') {
    if (params && params.length > 0) return { mode: 'formdata', formData: convertFormParams(ctx, params, `${path}.params`) };
    if (text !== undefined && text !== '') {
      w.warn(`${path}.text`, 'multipart/form-data body without parsed params is imported as raw text; review before sending');
      return { mode: 'raw', raw: text };
    }
    return { mode: 'formdata', formData: [] };
  }
  if (text === undefined || text === '') {
    if (params && params.length > 0) {
      w.info(`${path}.params`, `Parameters of a "${mime || 'unknown'}" body imported as urlencoded rows`);
      return { mode: 'urlencoded', urlencoded: ctx.placeholders.scrubRows('form', convertNamedRows(w, params, `${path}.params`), `${path}.params`) };
    }
    return { mode: 'none' };
  }
  const language = rawLanguageFromMime(mime);
  const body: RequestBody = { mode: 'raw', raw: language === 'json' ? ctx.placeholders.scrubJson(text, `${path}.text`) : text };
  if (language) body.rawLanguage = language;
  else if (mime !== '' && !isTextualMime(mime)) w.warn(`${path}.mimeType`, `Body of type "${mime}" imported as raw text`, mime);
  return body;
}

// ---------- response -> example ----------

function responseBody(ctx: Ctx, content: JsonObject, mime: string, path: string): string {
  const text = typeof content.text === 'string' ? content.text : '';
  if (text === '') return '';
  let body = text;
  if (content.encoding === 'base64') {
    if (!isTextualMime(mime)) {
      ctx.w.info(`${path}.text`, `Binary response body (${mime || 'unknown type'}) not imported`);
      return '';
    }
    try {
      body = Buffer.from(text, 'base64').toString('utf8');
    } catch {
      ctx.w.warn(`${path}.text`, 'Response body could not be base64-decoded; not imported');
      return '';
    }
  } else if (content.encoding !== undefined && content.encoding !== null && content.encoding !== '') {
    ctx.w.warn(`${path}.encoding`, `Unknown response body encoding "${toStr(content.encoding)}"; body not imported`);
    return '';
  }
  if (Buffer.byteLength(body, 'utf8') > ctx.maxBodyBytes) {
    ctx.w.warn(`${path}.text`, `Response body larger than ${Math.floor(ctx.maxBodyBytes / 1024)} KiB not imported`);
    return '';
  }
  return rawLanguageFromMime(mime) === 'json' ? ctx.placeholders.scrubJson(body, `${path}.text`) : body;
}

function convertResponse(ctx: Ctx, raw: unknown, path: string): RequestExample | undefined {
  const { w } = ctx;
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    w.warn(path, 'Response is not an object; ignored', raw);
    return undefined;
  }
  const code = typeof raw.status === 'number' ? raw.status : Number(raw.status ?? 0);
  if (!Number.isFinite(code) || code <= 0) {
    w.info(`${path}.status`, 'No response was recorded for this entry (status 0); no example created');
    return undefined;
  }
  const statusText = toStr(raw.statusText);
  const headers = convertHeaders(ctx, raw.headers, `${path}.headers`, 'response');
  if (Array.isArray(raw.cookies) && raw.cookies.length > 0) ctx.dropped.cookies += raw.cookies.length;
  const content = isRecord(raw.content) ? raw.content : {};
  const mime = baseMimeType(content.mimeType);
  const example: RequestExample = {
    name: clampName(`${code} ${statusText}`, `Response ${code}`),
    status: statusText,
    code,
    headers,
    body: responseBody(ctx, content, mime, `${path}.content`),
    metadata: { cookie: [] },
  };
  const language = rawLanguageFromMime(mime);
  if (language) example.language = language;
  return example;
}

// ---------- entries ----------

function convertEntry(ctx: Ctx, raw: unknown, path: string): RequestDraft | undefined {
  const { w } = ctx;
  if (!isRecord(raw)) {
    w.warn(path, 'Entry is not an object; skipped', raw);
    return undefined;
  }
  if (!isRecord(raw.request)) {
    w.warn(`${path}.request`, 'Entry has no request object; skipped', raw.request);
    return undefined;
  }
  const req = raw.request;
  const method = typeof req.method === 'string' && req.method.trim() !== '' ? req.method.trim().toUpperCase() : 'GET';
  if (typeof req.url !== 'string') w.warn(`${path}.request.url`, 'Request URL is missing; imported with an empty URL', req.url);
  const urlText = stripUrlCredentials(w, typeof req.url === 'string' ? req.url : '', `${path}.request.url`);
  const split = splitRequestUrl(urlText);
  const meta: JsonObject = {};
  if (split.hash) meta[META.urlHash] = split.hash;

  let queryParams = split.queryParams;
  if (queryParams.length === 0 && Array.isArray(req.queryString) && req.queryString.length > 0) queryParams = convertNamedRows(w, req.queryString, `${path}.request.queryString`);
  queryParams = ctx.placeholders.scrubRows('query', queryParams, `${path}.request.queryString`);
  if (Array.isArray(req.cookies) && req.cookies.length > 0) ctx.dropped.cookies += req.cookies.length;
  if (raw.timings !== undefined || raw.time !== undefined || raw.cache !== undefined) ctx.dropped.timings += 1;

  const draft = newDraft({
    name: requestNameFromUrl(method, split.url),
    method,
    url: split.url,
    headers: convertHeaders(ctx, req.headers, `${path}.request.headers`, 'request'),
    queryParams,
    body: convertPostData(ctx, req.postData, `${path}.request.postData`),
    metadata: meta,
  });
  if (typeof raw.comment === 'string' && raw.comment !== '') draft.description = raw.comment;
  const example = convertResponse(ctx, raw.response, `${path}.response`);
  if (example) {
    draft.examples.push(example);
    ctx.stats.examples += 1;
  }
  ctx.stats.requests += 1;
  ctx.done += 1;
  if (ctx.done % PROGRESS_EVERY === 0) emitProgress(ctx.limits, 'Importing', ctx.done, ctx.total);
  return draft;
}

// ---------- pages -> folders ----------

function convertPages(ctx: Ctx, raw: unknown): Map<string, FolderNode> {
  const folders = new Map<string, FolderNode>();
  if (raw === undefined || raw === null) return folders;
  if (!Array.isArray(raw)) {
    ctx.w.warn('log.pages', 'pages is not an array; ignored', raw);
    return folders;
  }
  raw.forEach((p: unknown, i) => {
    const at = `log.pages[${i}]`;
    if (!isRecord(p) || typeof p.id !== 'string' || p.id === '') {
      ctx.w.warn(at, 'Page without a string id skipped', p);
      return;
    }
    if (folders.has(p.id)) {
      ctx.w.warn(`${at}.id`, `Duplicate page id "${p.id}"; entries are merged into the first page`, p.id);
      return;
    }
    const title = typeof p.title === 'string' ? p.title : '';
    folders.set(p.id, {
      kind: 'folder',
      name: clampName(title, p.id),
      description: typeof p.comment === 'string' ? p.comment : '',
      auth: { type: 'inherit', params: {} },
      scripts: [],
      variables: [],
      metadata: {},
      items: [],
    });
  });
  return folders;
}

// ---------- document ----------

function validate(w: WarningCollector, doc: unknown): JsonObject {
  if (!isRecord(doc)) failImport(w, '', 'This is not a HAR file: the top-level JSON value must be an object.');
  if (!isRecord(doc.log)) failImport(w, 'log', 'This is not a HAR file: the "log" object is missing.');
  if (!Array.isArray(doc.log.entries)) failImport(w, 'log.entries', 'This is not a HAR file: "log.entries" is missing or not an array.');
  const version = doc.log.version;
  if (version !== '1.2') w.info('log.version', `HAR version "${toStr(version)}" is treated as 1.2`, version);
  return doc.log;
}

function describeSource(log: JsonObject, entries: number): string {
  const creator = isRecord(log.creator) ? `${toStr(log.creator.name)} ${toStr(log.creator.version)}`.trim() : '';
  const browser = isRecord(log.browser) ? `${toStr(log.browser.name)} ${toStr(log.browser.version)}`.trim() : '';
  const parts = [creator && `recorded by ${creator}`, browser && browser !== creator && `browser ${browser}`].filter((s): s is string => typeof s === 'string' && s !== '');
  return `Imported from a HAR 1.2 archive (${entries} ${entries === 1 ? 'entry' : 'entries'}${parts.length ? `, ${parts.join(', ')}` : ''}).`;
}

function run(input: string | object, options: ParseHarOptions): ParseHarResult {
  const w = new WarningCollector();
  const limits = resolveLimits(options);

  emitProgress(limits, 'Parsing', 0, 1);
  const doc = parseJsonInput(input, limits.maxBytes, w);
  emitProgress(limits, 'Parsing', 1, 1);

  emitProgress(limits, 'Validating', 0, 1);
  const log = validate(w, doc);
  const entries = log.entries as unknown[];
  const pageCount = Array.isArray(log.pages) ? log.pages.length : 0;
  assertItemCount(entries.length + pageCount, limits, 'entries and pages');
  emitProgress(limits, 'Validating', 1, 1);

  const ctx: Ctx = {
    w,
    stats: newStats(),
    limits,
    placeholders: new CredentialPlaceholders(w, 'har', 'HAR file'),
    dropped: { pseudoHeaders: 0, computedHeaders: 0, cookies: 0, timings: 0 },
    maxBodyBytes: options.maxExampleBodyBytes ?? DEFAULT_MAX_EXAMPLE_BODY_BYTES,
    total: entries.length,
    done: 0,
  };
  emitProgress(limits, 'Importing', 0, entries.length);
  const folders = convertPages(ctx, log.pages);
  const items: ItemNode[] = [...folders.values()];
  entries.forEach((entry, i) => {
    const path = `log.entries[${i}]`;
    const draft = convertEntry(ctx, entry, path);
    if (!draft) return;
    const pageref = isRecord(entry) ? entry.pageref : undefined;
    const folder = typeof pageref === 'string' ? folders.get(pageref) : undefined;
    if (typeof pageref === 'string' && pageref !== '' && !folder) w.info(`${path}.pageref`, `Unknown page "${pageref}"; request placed at the top level`, pageref);
    (folder ? folder.items : items).push({ kind: 'request', request: draft });
  });
  emitProgress(limits, 'Importing', ctx.done, entries.length);

  emitProgress(limits, 'Finalizing', 0, 1);
  const { dropped } = ctx;
  if (dropped.pseudoHeaders > 0) w.info('log.entries', `${dropped.pseudoHeaders} HTTP/2 pseudo-header(s) (":method", ":path" ...) were not imported`);
  if (dropped.computedHeaders > 0) w.info('log.entries', `${dropped.computedHeaders} Host/Content-Length header(s) were not imported (computed at send time)`);
  if (dropped.cookies > 0) w.info('log.entries', `${dropped.cookies} recorded cookie(s) were not imported; use the Cookie header placeholder variables instead`);
  if (dropped.timings > 0) w.info('log.entries', `Timing, cache and size information of ${dropped.timings} entries is not imported`);
  const variables = ctx.placeholders.variables;
  ctx.stats.folders = folders.size;
  ctx.stats.variables = variables.length;
  const firstPage = folders.values().next().value;
  const bundle: CollectionBundle = {
    name: clampName(options.name ?? (firstPage ? firstPage.name : ''), 'HAR import'),
    description: describeSource(log, entries.length),
    postmanSchemaVersion: '2.1.0',
    variables,
    auth: { type: 'none', params: {} },
    scripts: [],
    sourceMetadata: {},
    items,
  };
  const warnings = w.toArray();
  emitProgress(limits, 'Finalizing', 1, 1);
  return { bundle, warnings, stats: ctx.stats, format: 'har-1.2' };
}

/**
 * Convert a HAR 1.2 archive (JSON text or parsed object) into a
 * {@link CollectionBundle}. Synchronous; throws `AppError`
 * (`IMPORT_INVALID`, `IMPORT_TOO_LARGE`). Credentials are replaced with
 * placeholders and never imported literally.
 */
export function parseHar(input: string | object, options: ParseHarOptions = {}): ParseHarResult {
  return guardImport(() => run(input, options));
}
