/**
 * Postman Collection v1 (`{ id, name, order[], folders[], requests[] }`) ->
 * CollectionBundle. Requests are placed by `order` / `folders_order`; auth
 * comes from the v2-style `auth` block or the legacy `currentHelper` +
 * `helperAttributes`; scripts from `events` or the `preRequestScript` /
 * `tests` strings; `responses` become examples.
 */
import type { AuthConfig, AuthParamValue, CollectionBundle, FolderNode, FormDataEntry, ImportStats, ImportWarningModel, ItemNode, KeyValueEntry, RequestBody, RequestDraft, RequestExample, ScriptEntry } from '@aegis/core';
import {
  PROGRESS_EVERY,
  assertDepth,
  assertItemCount,
  baseMimeType,
  clampName,
  convertNamedRows,
  countScripts,
  emitProgress,
  guardImport,
  newDraft,
  newStats,
  rawLanguageFromMime,
  resolveLimits,
  safeFilePath,
  splitRequestUrl,
  stripUrlCredentials,
} from './import-common';
import type { ImportLimitOptions, ResolvedLimits } from './import-common';
import { applyEventMeta, cloneAt, convertAuth, convertEvents, convertProtocolProfile, convertVariables } from './import-parts';
import type { JsonObject } from './shared';
import { META, UNSAFE_KEYS, failImport, graphqlToRaw, isRawLanguage, isRecord, parseHeaderString, parseJsonInput, toInternalAuthType, toStr } from './shared';
import { WarningCollector } from './warnings';

export interface ParseV1Result {
  bundle: CollectionBundle;
  warnings: ImportWarningModel[];
  stats: ImportStats;
  format: 'collection-v1';
}

interface Ctx {
  w: WarningCollector;
  stats: ImportStats;
  limits: ResolvedLimits;
  requests: Map<string, { raw: JsonObject; path: string }>;
  folders: Map<string, { raw: JsonObject; path: string }>;
  folderNodes: Map<string, FolderNode>;
  placedRequests: Set<string>;
  placedFolders: Set<string>;
  total: number;
  done: number;
}

const REQUEST_KNOWN: ReadonlySet<string> = new Set([
  'id', 'name', 'url', 'method', 'headers', 'headerData', 'queryParams', 'pathVariables', 'pathVariableData', 'data', 'dataMode', 'rawModeData', 'dataOptions', 'graphqlModeData',
  'description', 'descriptionFormat', 'preRequestScript', 'tests', 'events', 'currentHelper', 'helperAttributes', 'auth', 'responses', 'folder', 'collectionId', 'collection', 'protocolProfileBehavior',
]);
const REQUEST_QUIET: ReadonlySet<string> = new Set(['time', 'responses_order', 'isFromCollection', 'write', 'version', 'dataDisabled', 'collection_id', 'owner', 'lastUpdatedBy', 'createdAt', 'updatedAt', 'timestamp', 'uid', '_postman_id']);
const FOLDER_KNOWN: ReadonlySet<string> = new Set(['id', 'name', 'description', 'order', 'folders_order', 'folder', 'collection_id', 'collection', 'auth', 'events', 'variables', 'protocolProfileBehavior']);
const COLLECTION_KNOWN: ReadonlySet<string> = new Set(['id', 'name', 'description', 'order', 'folders_order', 'folders', 'requests', 'variables', 'auth', 'events', 'protocolProfileBehavior']);
const TOP_QUIET: ReadonlySet<string> = new Set(['timestamp', 'owner', 'public', 'remote_id', 'remoteLink', 'hasRequests', 'publishedId', 'synced', 'createdAt', 'updatedAt', 'lastUpdatedBy', 'uid', 'collection_id']);
const HELPER_QUIET: ReadonlySet<string> = new Set(['id', 'saveHelperData', 'showPassword']);

/** `currentHelper` -> Postman auth type. Parameter names of v1 helpers already match v2 (basic username/password, bearer token, awsSigV4 accessKey ...). */
const HELPER_TYPES: Record<string, string> = {
  basicAuth: 'basic',
  bearerAuth: 'bearer',
  digestAuth: 'digest',
  awsSigV4: 'awsv4',
  oAuth1: 'oauth1',
  oAuth2: 'oauth2',
  hawkAuth: 'hawk',
  ntlmAuth: 'ntlm',
  apikeyAuth: 'apikey',
};

function reportUnknown(w: WarningCollector, obj: JsonObject, known: ReadonlySet<string>, quiet: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(obj)) {
    if (known.has(key) || quiet.has(key)) continue;
    if (UNSAFE_KEYS.has(key)) w.warn(`${path}.${key}`, `Removed unsafe key "${key}" from imported data (prototype-pollution guard)`);
    else w.info(`${path}.${key}`, `Field "${key}" of the v1 document is not imported`, obj[key]);
  }
}

function descriptionType(w: WarningCollector, format: unknown, path: string, meta: JsonObject): void {
  if (format === undefined || format === null || format === '') return;
  if (format === 'html') meta[META.descriptionType] = 'text/html';
  else if (format === 'markdown') meta[META.descriptionType] = 'text/markdown';
  else if (format === 'plain' || format === 'text') meta[META.descriptionType] = 'text/plain';
  else w.info(path, `Unknown descriptionFormat "${toStr(format)}" ignored`, format);
}

// ---------- auth ----------

function helperAuth(ctx: Ctx, raw: JsonObject, path: string): AuthConfig {
  const { w } = ctx;
  const helper = typeof raw.currentHelper === 'string' ? raw.currentHelper : '';
  const attrs = isRecord(raw.helperAttributes) ? raw.helperAttributes : undefined;
  if (helper === '' || helper === 'normal' || helper === 'noAuth' || !attrs) {
    if (helper !== '' && helper !== 'normal' && helper !== 'noAuth') w.warn(`${path}.currentHelper`, `Auth helper "${helper}" has no helperAttributes; the request inherits authentication`, helper);
    return { type: 'inherit', params: {} };
  }
  const postmanType = HELPER_TYPES[helper] ?? (typeof attrs.id === 'string' ? attrs.id : helper);
  const internal = toInternalAuthType(postmanType);
  const params: Record<string, AuthParamValue> = {};
  if (internal === 'custom') {
    w.warn(`${path}.currentHelper`, `Auth helper "${helper}" is not natively supported; imported as a custom provider and preserved for export (not executable)`, { currentHelper: helper });
    params.providerId = postmanType;
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (HELPER_QUIET.has(k) || UNSAFE_KEYS.has(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v;
    else if (v !== null && v !== undefined) w.info(`${path}.helperAttributes.${k}`, `Structured auth attribute "${k}" ignored`, v);
  }
  return { type: internal, params };
}

function requestAuth(ctx: Ctx, raw: JsonObject, path: string, meta: JsonObject): AuthConfig {
  if (isRecord(raw.auth)) {
    const imported = convertAuth(ctx.w, raw.auth, `${path}.auth`, 'request');
    if (imported.meta) meta[META.authMeta] = imported.meta;
    return imported.auth;
  }
  if (raw.auth === null && raw.currentHelper === undefined) return { type: 'inherit', params: {} };
  return helperAuth(ctx, raw, path);
}

// ---------- scripts ----------

function requestScripts(ctx: Ctx, raw: JsonObject, path: string, meta: JsonObject): ScriptEntry[] {
  if (Array.isArray(raw.events) && raw.events.length > 0) {
    const events = convertEvents(ctx.w, raw.events, `${path}.events`);
    applyEventMeta(meta, events);
    return events.scripts;
  }
  const out: ScriptEntry[] = [];
  if (typeof raw.preRequestScript === 'string' && raw.preRequestScript.trim() !== '') out.push({ type: 'prerequest', language: 'javascript', source: raw.preRequestScript, enabled: true });
  if (typeof raw.tests === 'string' && raw.tests.trim() !== '') out.push({ type: 'test', language: 'javascript', source: raw.tests, enabled: true });
  return out;
}

// ---------- body ----------

function convertData(ctx: Ctx, raw: unknown, path: string): { form: FormDataEntry[]; rows: KeyValueEntry[] } {
  const form: FormDataEntry[] = [];
  const rows: KeyValueEntry[] = [];
  if (raw === undefined || raw === null) return { form, rows };
  if (!Array.isArray(raw)) {
    ctx.w.warn(path, 'Body data is not an array; ignored', raw);
    return { form, rows };
  }
  raw.forEach((e: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(e)) {
      ctx.w.warn(at, 'Body entry is not an object; skipped', e);
      return;
    }
    const key = toStr(e.key);
    const enabled = e.enabled !== false && e.disabled !== true;
    const description = typeof e.description === 'string' ? e.description : '';
    const isFile = e.type === 'file';
    const entry: FormDataEntry = { key, type: isFile ? 'file' : 'text', value: isFile ? '' : toStr(e.value), enabled };
    if (isFile) {
      const filePath = safeFilePath(ctx.w, e.value, `${at}.value`);
      if (filePath !== undefined) entry.filePath = filePath;
    }
    if (typeof e.contentType === 'string' && e.contentType !== '') entry.contentType = e.contentType;
    if (description !== '') entry.description = description;
    form.push(entry);
    const row: KeyValueEntry = { key, value: toStr(e.value), enabled };
    if (description !== '') row.description = description;
    rows.push(row);
  });
  return { form, rows };
}

function contentTypeOf(headers: readonly KeyValueEntry[]): string {
  const h = headers.find((x) => x.key.toLowerCase() === 'content-type');
  return h ? baseMimeType(h.value) : '';
}

function convertBody(ctx: Ctx, raw: JsonObject, path: string, meta: JsonObject, headers: readonly KeyValueEntry[]): RequestBody {
  const { w } = ctx;
  const mode = typeof raw.dataMode === 'string' ? raw.dataMode : '';
  const rawText = raw.rawModeData === undefined || raw.rawModeData === null ? '' : Array.isArray(raw.rawModeData) ? raw.rawModeData.map(toStr).join('') : toStr(raw.rawModeData);
  switch (mode) {
    case 'raw':
    case '': {
      if (mode === '' && rawText === '') return { mode: 'none' };
      const body: RequestBody = { mode: 'raw', raw: rawText };
      const options = isRecord(raw.dataOptions) && isRecord(raw.dataOptions.raw) ? raw.dataOptions.raw.language : undefined;
      const language = isRawLanguage(options) ? options : rawLanguageFromMime(contentTypeOf(headers));
      if (language) body.rawLanguage = language;
      else if (options !== undefined) w.info(`${path}.dataOptions.raw.language`, `Unknown raw body language "${toStr(options)}" imported as plain text`, options);
      return body;
    }
    case 'params':
      return { mode: 'formdata', formData: convertData(ctx, raw.data, `${path}.data`).form };
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: convertData(ctx, raw.data, `${path}.data`).rows };
    case 'binary': {
      const filePath = safeFilePath(w, typeof raw.rawModeData === 'string' ? raw.rawModeData : undefined, `${path}.rawModeData`);
      if (filePath === undefined) w.info(`${path}.dataMode`, 'Binary body has no usable file reference; select the file again before sending');
      return filePath === undefined ? { mode: 'binary' } : { mode: 'binary', filePath };
    }
    case 'graphql': {
      const src = isRecord(raw.graphqlModeData) ? raw.graphqlModeData : {};
      const graphql: JsonObject = { query: toStr(src.query), variables: typeof src.variables === 'string' ? src.variables : src.variables === undefined || src.variables === null ? '' : JSON.stringify(src.variables) };
      w.warn(`${path}.graphqlModeData`, 'GraphQL bodies are imported as a raw JSON body ({query, variables}); the original is preserved for export', src);
      meta[META.originalBodyMode] = 'graphql';
      meta[META.graphqlBody] = graphql;
      return { mode: 'raw', raw: graphqlToRaw(graphql), rawLanguage: 'json' };
    }
    default:
      w.warn(`${path}.dataMode`, `Unsupported dataMode "${mode}"; imported as "no body"`, mode);
      return { mode: 'none' };
  }
}

// ---------- responses -> examples ----------

function convertResponses(ctx: Ctx, raw: unknown, path: string): RequestExample[] {
  const { w } = ctx;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    w.warn(path, 'responses is not an array; ignored', raw);
    return [];
  }
  const out: RequestExample[] = [];
  raw.forEach((r: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(r)) {
      w.warn(at, 'Saved response is not an object; skipped', r);
      return;
    }
    const rc = isRecord(r.responseCode) ? r.responseCode : {};
    const code = typeof rc.code === 'number' ? rc.code : Number(rc.code ?? r.code ?? 0);
    const status = typeof rc.name === 'string' ? rc.name : toStr(r.status);
    const headers = convertNamedRows(w, r.headers, `${at}.headers`);
    const metadata: JsonObject = { cookie: [] };
    if (typeof r.id === 'string') metadata.id = r.id;
    const example: RequestExample = {
      name: typeof r.name === 'string' && r.name !== '' ? r.name : 'Example',
      status,
      code: Number.isFinite(code) ? code : 0,
      headers,
      body: toStr(r.text),
      metadata,
    };
    if (typeof r.language === 'string' && r.language !== '') example.language = r.language;
    out.push(example);
  });
  return out;
}

// ---------- requests ----------

function convertRequest(ctx: Ctx, raw: JsonObject, path: string): RequestDraft {
  const { w } = ctx;
  const meta: JsonObject = {};
  if (typeof raw.id === 'string') meta[META.postmanId] = raw.id;
  reportUnknown(w, raw, REQUEST_KNOWN, REQUEST_QUIET, path);
  const method = typeof raw.method === 'string' && raw.method.trim() !== '' ? raw.method.trim() : 'GET';
  const urlText = stripUrlCredentials(w, toStr(raw.url), `${path}.url`);
  const split = splitRequestUrl(urlText);
  if (split.hash) meta[META.urlHash] = split.hash;

  const queryParams = Array.isArray(raw.queryParams) ? convertNamedRows(w, raw.queryParams, `${path}.queryParams`) : split.queryParams;
  let pathVariables: KeyValueEntry[] = [];
  if (Array.isArray(raw.pathVariableData)) pathVariables = convertNamedRows(w, raw.pathVariableData, `${path}.pathVariableData`);
  else if (isRecord(raw.pathVariables)) pathVariables = Object.entries(raw.pathVariables).filter(([k]) => !UNSAFE_KEYS.has(k)).map(([key, value]) => ({ key, value: toStr(value), enabled: true }));

  const headers = Array.isArray(raw.headerData) ? convertNamedRows(w, raw.headerData, `${path}.headerData`) : typeof raw.headers === 'string' ? parseHeaderString(raw.headers) : [];
  if (raw.headers !== undefined && raw.headers !== null && typeof raw.headers !== 'string' && !Array.isArray(raw.headerData)) w.warn(`${path}.headers`, 'headers is not a string; ignored', raw.headers);

  const description = typeof raw.description === 'string' ? raw.description : '';
  if (description !== '') descriptionType(w, raw.descriptionFormat, `${path}.descriptionFormat`, meta);
  const scripts = requestScripts(ctx, raw, path, meta);
  const examples = convertResponses(ctx, raw.responses, `${path}.responses`);
  const profile = convertProtocolProfile(w, raw.protocolProfileBehavior, `${path}.protocolProfileBehavior`);
  if (profile.remainder) meta[META.protocolProfileBehavior] = profile.remainder;

  const draft = newDraft({
    name: clampName(toStr(raw.name), 'Untitled Request'),
    method,
    url: split.url,
    description,
    headers,
    queryParams,
    pathVariables,
    body: convertBody(ctx, raw, path, meta, headers),
    auth: requestAuth(ctx, raw, path, meta),
    scripts,
    examples,
    settings: profile.settings,
    metadata: meta,
  });
  if (typeof raw.name !== 'string') w.info(`${path}.name`, 'Request has no name; using "Untitled Request"');
  ctx.stats.requests += 1;
  ctx.stats.scripts += countScripts(scripts);
  ctx.stats.examples += examples.length;
  ctx.done += 1;
  if (ctx.done % PROGRESS_EVERY === 0) emitProgress(ctx.limits, 'Importing', ctx.done, ctx.total);
  return draft;
}

// ---------- placement ----------

function idList(w: WarningCollector, raw: unknown, path: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    w.warn(path, 'Expected an array of ids; ignored', raw);
    return [];
  }
  return raw.filter((id): id is string => typeof id === 'string');
}

function placeRequest(ctx: Ctx, id: string, into: ItemNode[], path: string): void {
  const entry = ctx.requests.get(id);
  if (!entry) {
    ctx.w.warn(path, `Order references unknown request id "${id}"`, id);
    return;
  }
  if (ctx.placedRequests.has(id)) {
    ctx.w.warn(path, `Request "${id}" is referenced more than once; later references are ignored`, id);
    return;
  }
  ctx.placedRequests.add(id);
  into.push({ kind: 'request', request: convertRequest(ctx, entry.raw, entry.path) });
}

function buildFolder(ctx: Ctx, id: string, depth: number, path: string): FolderNode | undefined {
  const { w } = ctx;
  const entry = ctx.folders.get(id);
  if (!entry) {
    w.warn(path, `folders_order references unknown folder id "${id}"`, id);
    return undefined;
  }
  if (ctx.placedFolders.has(id)) {
    w.warn(path, `Folder "${id}" is referenced more than once; later references are ignored`, id);
    return undefined;
  }
  ctx.placedFolders.add(id);
  assertDepth(depth, ctx.limits, w, entry.path);
  const { raw } = entry;
  const metadata: JsonObject = { [META.postmanId]: id };
  reportUnknown(w, raw, FOLDER_KNOWN, REQUEST_QUIET, entry.path);
  const auth = convertAuth(w, raw.auth, `${entry.path}.auth`, 'folder');
  if (auth.meta) metadata[META.authMeta] = auth.meta;
  const events = convertEvents(w, raw.events, `${entry.path}.events`);
  applyEventMeta(metadata, events);
  const variables = convertVariables(w, raw.variables, `${entry.path}.variables`);
  if (isRecord(raw.protocolProfileBehavior)) metadata[META.protocolProfileBehavior] = cloneAt(w, raw.protocolProfileBehavior, `${entry.path}.protocolProfileBehavior`);
  const folder: FolderNode = {
    kind: 'folder',
    name: clampName(toStr(raw.name), 'Untitled folder'),
    description: typeof raw.description === 'string' ? raw.description : '',
    auth: auth.auth,
    scripts: events.scripts,
    variables,
    metadata,
    items: [],
  };
  ctx.folderNodes.set(id, folder);
  ctx.stats.folders += 1;
  ctx.stats.variables += variables.length;
  ctx.stats.scripts += countScripts(events.scripts);
  for (const childId of idList(w, raw.folders_order, `${entry.path}.folders_order`)) {
    const child = buildFolder(ctx, childId, depth + 1, `${entry.path}.folders_order`);
    if (child) folder.items.push(child);
  }
  for (const reqId of idList(w, raw.order, `${entry.path}.order`)) placeRequest(ctx, reqId, folder.items, `${entry.path}.order`);
  return folder;
}

function placeLeftovers(ctx: Ctx, items: ItemNode[]): void {
  const { w } = ctx;
  for (const [id, entry] of ctx.folders) {
    if (ctx.placedFolders.has(id)) continue;
    const parent = typeof entry.raw.folder === 'string' ? ctx.folderNodes.get(entry.raw.folder) : undefined;
    w.info(entry.path, `Folder "${toStr(entry.raw.name)}" is not referenced by any folders_order; appended ${parent ? `to "${parent.name}"` : 'at the top level'}`);
    const node = buildFolder(ctx, id, parent ? 2 : 1, entry.path);
    if (node) (parent ? parent.items : items).push(node);
  }
  for (const [id, entry] of ctx.requests) {
    if (ctx.placedRequests.has(id)) continue;
    const parent = typeof entry.raw.folder === 'string' ? ctx.folderNodes.get(entry.raw.folder) : undefined;
    w.info(entry.path, `Request "${toStr(entry.raw.name)}" is not referenced by any order list; appended ${parent ? `to "${parent.name}"` : 'at the top level'}`);
    placeRequest(ctx, id, parent ? parent.items : items, entry.path);
  }
}

// ---------- document ----------

function validate(w: WarningCollector, doc: unknown): JsonObject {
  if (!isRecord(doc)) failImport(w, '', 'This is not a Postman v1 collection: the top-level JSON value must be an object.');
  if (isRecord(doc.info) && Array.isArray(doc.item)) failImport(w, 'info', 'This is a Postman Collection v2 file; use the v2 importer instead.');
  if (!Array.isArray(doc.requests)) failImport(w, 'requests', 'This is not a Postman v1 collection: the "requests" array is missing.');
  if (doc.folders !== undefined && doc.folders !== null && !Array.isArray(doc.folders)) failImport(w, 'folders', 'This is not a Postman v1 collection: "folders" must be an array.');
  return doc;
}

function indexRecords(ctx: Ctx, list: unknown[], path: string, into: Map<string, { raw: JsonObject; path: string }>): void {
  list.forEach((raw, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(raw)) {
      ctx.w.warn(at, 'Entry is not an object; skipped', raw);
      return;
    }
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `__anon_${path}_${i}`;
    if (typeof raw.id !== 'string' || raw.id === '') ctx.w.warn(`${at}.id`, 'Entry has no id; a generated one is used', raw.id);
    if (into.has(id)) {
      ctx.w.warn(`${at}.id`, `Duplicate id "${id}"; this entry is skipped`, id);
      return;
    }
    into.set(id, { raw, path: at });
  });
}

function run(input: string | object, options: ImportLimitOptions): ParseV1Result {
  const w = new WarningCollector();
  const limits = resolveLimits(options);

  emitProgress(limits, 'Parsing', 0, 1);
  const parsed = parseJsonInput(input, limits.maxBytes, w);
  emitProgress(limits, 'Parsing', 1, 1);

  emitProgress(limits, 'Validating', 0, 1);
  const doc = validate(w, parsed);
  const requests = doc.requests as unknown[];
  const folders = Array.isArray(doc.folders) ? doc.folders : [];
  assertItemCount(requests.length + folders.length, limits, 'requests and folders');
  const ctx: Ctx = {
    w,
    stats: newStats(),
    limits,
    requests: new Map(),
    folders: new Map(),
    folderNodes: new Map(),
    placedRequests: new Set(),
    placedFolders: new Set(),
    total: requests.length,
    done: 0,
  };
  indexRecords(ctx, requests, 'requests', ctx.requests);
  indexRecords(ctx, folders, 'folders', ctx.folders);
  emitProgress(limits, 'Validating', 1, 1);

  emitProgress(limits, 'Importing', 0, ctx.total);
  const sourceMetadata: JsonObject = {};
  reportUnknown(w, doc, COLLECTION_KNOWN, TOP_QUIET, '');
  if (typeof doc.name !== 'string' || doc.name.trim() === '') w.warn('name', 'Collection has no name; using "Imported collection"');
  const auth = convertAuth(w, doc.auth, 'auth', 'collection');
  if (auth.meta) sourceMetadata[META.authMeta] = auth.meta;
  const events = convertEvents(w, doc.events, 'events');
  applyEventMeta(sourceMetadata, events);
  const variables = convertVariables(w, doc.variables, 'variables');
  ctx.stats.variables += variables.length;
  ctx.stats.scripts += countScripts(events.scripts);

  const items: ItemNode[] = [];
  const rootFolders = Array.isArray(doc.folders_order) ? idList(w, doc.folders_order, 'folders_order') : [...ctx.folders.entries()].filter(([, f]) => typeof f.raw.folder !== 'string').map(([id]) => id);
  for (const id of rootFolders) {
    const node = buildFolder(ctx, id, 1, 'folders_order');
    if (node) items.push(node);
  }
  for (const id of idList(w, doc.order, 'order')) placeRequest(ctx, id, items, 'order');
  placeLeftovers(ctx, items);
  emitProgress(limits, 'Importing', ctx.done, ctx.total);

  emitProgress(limits, 'Finalizing', 0, 1);
  w.info('', 'Postman Collection v1 imported; it is exported as Collection v2.1');
  const bundle: CollectionBundle = {
    name: clampName(toStr(doc.name), 'Imported collection'),
    description: typeof doc.description === 'string' ? doc.description : '',
    postmanSchemaVersion: '1.0.0',
    variables,
    auth: auth.auth,
    scripts: events.scripts,
    sourceMetadata,
    items,
  };
  if (typeof doc.id === 'string' && doc.id !== '') bundle.uid = doc.id;
  const warnings = w.toArray();
  emitProgress(limits, 'Finalizing', 1, 1);
  return { bundle, warnings, stats: ctx.stats, format: 'collection-v1' };
}

/**
 * Convert a legacy Postman Collection v1 document (JSON text or parsed object)
 * into a {@link CollectionBundle}. Synchronous; throws `AppError`
 * (`IMPORT_INVALID`, `IMPORT_TOO_LARGE`).
 */
export function parsePostmanV1(input: string | object, options: ImportLimitOptions = {}): ParseV1Result {
  return guardImport(() => run(input, options));
}
