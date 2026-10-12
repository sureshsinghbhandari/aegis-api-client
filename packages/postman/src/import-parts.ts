/**
 * Converters for the individual parts of a Postman item (URL, body, auth,
 * events, examples ...). Used by import-collection.ts. Every converter reports
 * what it could not map via the WarningCollector and keeps the original data in
 * metadata, so nothing is dropped silently.
 */
import type {
  AuthConfig,
  AuthParamValue,
  FormDataEntry,
  KeyValueEntry,
  RequestBody,
  RequestExample,
  RequestSettings,
  ScriptEntry,
  VariableEntry,
} from '@aegis/core';
import { splitUrl } from '@aegis/core';
import { checkImportedFilePath } from '@aegis/security';
import type { JsonObject } from './shared';
import {
  META,
  UNSAFE_KEYS,
  cloneSafe,
  composeUrlFromParts,
  graphqlToRaw,
  inferParamType,
  isRawLanguage,
  isRecord,
  parseHeaderString,
  parseRawQuery,
  readDescription,
  toInternalAuthType,
  toStr,
} from './shared';
import type { WarningCollector } from './warnings';

export function cloneAt(w: WarningCollector, value: unknown, path: string): unknown {
  return cloneSafe(value, (k) => w.warn(path, `Removed unsafe key "${k}" from imported data (prototype-pollution guard)`));
}

/**
 * Collect the keys of `obj` that are not in `known` into a new object (deep-cloned,
 * unsafe keys dropped) and report each. Keys in `quiet` are reported as INFO; keys in
 * `silent` (pure identifiers that are preserved) are not reported.
 */
export function collectExtras(
  w: WarningCollector,
  obj: JsonObject,
  known: ReadonlySet<string>,
  path: string,
  quiet: ReadonlySet<string> = new Set(),
  silent: ReadonlySet<string> = new Set(),
): JsonObject | undefined {
  const extras: JsonObject = {};
  for (const key of Object.keys(obj)) {
    if (known.has(key)) continue;
    const at = path ? `${path}.${key}` : key;
    if (UNSAFE_KEYS.has(key)) {
      w.warn(at, `Removed unsafe key "${key}" from imported data (prototype-pollution guard)`);
      continue;
    }
    extras[key] = cloneAt(w, obj[key], at);
    if (silent.has(key)) continue;
    w.add(quiet.has(key) ? 'INFO' : 'WARNING', at, `Field "${key}" is not mapped to a native feature; preserved in metadata`, obj[key]);
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

export function setIfDefined(target: JsonObject, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

// ---------- descriptions ----------

export function importDescription(w: WarningCollector, raw: unknown, path: string, meta: JsonObject): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string' && !isRecord(raw)) {
    w.warn(path, 'Description is neither a string nor an object; ignored', raw);
    return '';
  }
  const d = readDescription(raw);
  if (d.type !== undefined) meta[META.descriptionType] = d.type;
  return d.text;
}

// ---------- key/value lists ----------

const KV_KNOWN: ReadonlySet<string> = new Set(['key', 'value', 'disabled', 'description', 'type', 'equals', 'id']);

export function convertKeyValues(w: WarningCollector, raw: unknown, path: string): KeyValueEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    w.warn(path, 'Expected an array; ignored', raw);
    return [];
  }
  const out: KeyValueEntry[] = [];
  raw.forEach((e: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(e)) {
      w.warn(at, 'Entry is not an object; skipped', e);
      return;
    }
    for (const key of Object.keys(e)) if (!KV_KNOWN.has(key)) w.warn(`${at}.${key}`, `Unsupported field "${key}" ignored`, e[key]);
    const entry: KeyValueEntry = { key: toStr(e.key), value: toStr(e.value), enabled: e.disabled !== true };
    const description = readDescription(e.description).text;
    if (description !== '') entry.description = description;
    out.push(entry);
  });
  return out;
}

/** Headers: v2.1 array, or the v2.0 `"A: b\nC: d"` string. */
export function convertHeaders(w: WarningCollector, raw: unknown, path: string): KeyValueEntry[] {
  return typeof raw === 'string' ? parseHeaderString(raw) : convertKeyValues(w, raw, path);
}

// ---------- variables ----------

export function convertVariables(w: WarningCollector, raw: unknown, path: string): VariableEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    w.warn(path, 'Expected an array of variables; ignored', raw);
    return [];
  }
  const out: VariableEntry[] = [];
  raw.forEach((e: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(e)) {
      w.warn(at, 'Variable is not an object; skipped', e);
      return;
    }
    // Legacy exports use `id` as the variable name.
    const key = typeof e.key === 'string' ? e.key : typeof e.id === 'string' ? e.id : undefined;
    if (key === undefined) {
      w.warn(at, 'Variable has no key; skipped', e);
      return;
    }
    if (isRecord(e.value) || Array.isArray(e.value)) w.warn(`${at}.value`, 'Structured variable value stored as JSON text', e.value);
    const type = typeof e.type === 'string' ? e.type : undefined;
    const entry: VariableEntry = { key, initialValue: toStr(e.value), isSecret: type === 'secret', enabled: e.disabled !== true };
    const description = readDescription(e.description).text;
    if (description !== '') entry.description = description;
    if (type !== undefined) entry.type = type;
    out.push(entry);
  });
  return out;
}

// ---------- URL ----------

export interface ImportedUrl {
  url: string;
  queryParams: KeyValueEntry[];
  pathVariables: KeyValueEntry[];
  /** Fragment including the leading `#`. */
  hash?: string;
  extras?: JsonObject;
}

const URL_KNOWN: ReadonlySet<string> = new Set(['raw', 'protocol', 'host', 'path', 'port', 'query', 'variable', 'hash']);

function urlFromString(text: string): ImportedUrl {
  const { base, query, hash } = splitUrl(text);
  const out: ImportedUrl = { url: base, queryParams: parseRawQuery(query), pathVariables: [] };
  if (hash) out.hash = hash;
  return out;
}

export function convertUrl(w: WarningCollector, raw: unknown, path: string): ImportedUrl {
  if (raw === undefined || raw === null) return { url: '', queryParams: [], pathVariables: [] };
  if (typeof raw === 'string') return urlFromString(raw.trim());
  if (!isRecord(raw)) {
    w.warn(path, 'URL is neither a string nor an object; ignored', raw);
    return { url: '', queryParams: [], pathVariables: [] };
  }
  const rawText = typeof raw.raw === 'string' ? raw.raw.trim() : '';
  const fromRaw = urlFromString(rawText !== '' ? rawText : composeUrlFromParts(raw));
  const out: ImportedUrl = { ...fromRaw, pathVariables: convertKeyValues(w, raw.variable, `${path}.variable`) };
  if (Array.isArray(raw.query)) out.queryParams = convertKeyValues(w, raw.query, `${path}.query`);
  if (!out.hash && typeof raw.hash === 'string' && raw.hash !== '') out.hash = `#${raw.hash}`;
  const extras = collectExtras(w, raw, URL_KNOWN, path);
  if (extras) out.extras = extras;
  return out;
}

// ---------- body ----------

const BODY_MODE_FIELDS: ReadonlySet<string> = new Set(['raw', 'urlencoded', 'formdata', 'file', 'graphql']);
const FORMDATA_KNOWN: ReadonlySet<string> = new Set(['key', 'value', 'type', 'src', 'contentType', 'disabled', 'description']);

/** Validate a file reference found in an imported document; unsafe paths are NOT stored. */
function safeFilePath(w: WarningCollector, src: unknown, path: string): string | undefined {
  if (src === undefined || src === null || src === '') return undefined;
  let value = src;
  if (Array.isArray(src)) {
    if (src.length === 0) return undefined;
    if (src.length > 1) w.warn(path, 'Multiple files are not supported; only the first one is imported', src);
    value = src[0];
  }
  if (typeof value !== 'string') {
    w.warn(path, 'File reference is not a string; ignored', value);
    return undefined;
  }
  const verdict = checkImportedFilePath(value);
  if (!verdict.safe) {
    w.warn(path, `Unsafe file path rejected (${verdict.reason}); the path was not imported`, value);
    return undefined;
  }
  return value;
}

function convertFormData(w: WarningCollector, raw: unknown, path: string): FormDataEntry[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) w.warn(path, 'Expected an array; ignored', raw);
    return [];
  }
  const out: FormDataEntry[] = [];
  raw.forEach((e: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(e)) {
      w.warn(at, 'Form-data entry is not an object; skipped', e);
      return;
    }
    for (const key of Object.keys(e)) if (!FORMDATA_KNOWN.has(key)) w.warn(`${at}.${key}`, `Unsupported field "${key}" ignored`, e[key]);
    const isFile = e.type === 'file';
    const entry: FormDataEntry = { key: toStr(e.key), type: isFile ? 'file' : 'text', value: isFile ? '' : toStr(e.value), enabled: e.disabled !== true };
    if (isFile) {
      const filePath = safeFilePath(w, e.src, `${at}.src`);
      if (filePath !== undefined) entry.filePath = filePath;
    }
    if (typeof e.contentType === 'string' && e.contentType !== '') entry.contentType = e.contentType;
    const description = readDescription(e.description).text;
    if (description !== '') entry.description = description;
    out.push(entry);
  });
  return out;
}

function convertRawBody(w: WarningCollector, body: JsonObject, path: string, meta: JsonObject): RequestBody {
  const out: RequestBody = { mode: 'raw', raw: toStr(body.raw) };
  const options = body.options;
  if (options === undefined || options === null) return out;
  if (!isRecord(options)) {
    w.warn(`${path}.options`, 'Body options are not an object; preserved in metadata', options);
    meta[META.bodyOptions] = cloneAt(w, options, `${path}.options`);
    return out;
  }
  const rawOptions = isRecord(options.raw) ? options.raw : {};
  const language = rawOptions.language;
  let keep = Object.keys(options).some((k) => k !== 'raw') || Object.keys(rawOptions).some((k) => k !== 'language');
  if (isRawLanguage(language)) out.rawLanguage = language;
  else if (language !== undefined) {
    out.rawLanguage = 'text';
    keep = true;
    w.info(`${path}.options.raw.language`, `Unknown raw body language "${toStr(language)}" imported as plain text; original kept in metadata`, language);
  }
  if (keep) meta[META.bodyOptions] = cloneAt(w, options, `${path}.options`);
  return out;
}

function convertGraphQlBody(w: WarningCollector, body: JsonObject, path: string, meta: JsonObject): RequestBody {
  w.warn(`${path}.graphql`, 'GraphQL bodies are imported as a raw JSON body ({query, variables}); the original is preserved for export', body.graphql);
  meta[META.originalBodyMode] = 'graphql';
  meta[META.graphqlBody] = cloneAt(w, body.graphql, `${path}.graphql`);
  return { mode: 'raw', raw: graphqlToRaw(body.graphql), rawLanguage: 'json' };
}

function convertBodyByMode(w: WarningCollector, mode: string, body: JsonObject, path: string, meta: JsonObject): RequestBody | undefined {
  switch (mode) {
    case 'none':
      return { mode: 'none' };
    case 'raw':
      return convertRawBody(w, body, path, meta);
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: convertKeyValues(w, body.urlencoded, `${path}.urlencoded`) };
    case 'formdata':
      return { mode: 'formdata', formData: convertFormData(w, body.formdata, `${path}.formdata`) };
    case 'file': {
      const file = body.file;
      const src = isRecord(file) ? file.src : file;
      if (isRecord(file) && file.content !== undefined) w.warn(`${path}.file.content`, 'Inline file content is not supported and was ignored');
      const filePath = safeFilePath(w, src, `${path}.file.src`);
      return filePath === undefined ? { mode: 'binary' } : { mode: 'binary', filePath };
    }
    case 'graphql':
      return convertGraphQlBody(w, body, path, meta);
    default:
      return undefined;
  }
}

export function convertBody(w: WarningCollector, raw: unknown, path: string, meta: JsonObject): RequestBody {
  if (raw === undefined || raw === null) return { mode: 'none' };
  if (!isRecord(raw)) {
    w.warn(path, 'Body is not an object; ignored and preserved in metadata', raw);
    meta[META.bodyOriginal] = cloneAt(w, raw, path);
    return { mode: 'none' };
  }
  if (raw.disabled === true) {
    w.warn(path, 'Disabled body imported as "no body"; the original is preserved for export', raw);
    meta[META.bodyOriginal] = cloneAt(w, raw, path);
    return { mode: 'none' };
  }
  const mode = typeof raw.mode === 'string' ? raw.mode : typeof raw.raw === 'string' ? 'raw' : 'none';
  const body = convertBodyByMode(w, mode, raw, path, meta);
  if (!body) {
    w.warn(`${path}.mode`, `Unsupported body mode "${mode}"; imported as "no body" and preserved in metadata`, raw);
    meta[META.bodyOriginal] = cloneAt(w, raw, path);
    return { mode: 'none' };
  }
  if (mode !== 'raw' && isRecord(raw.options)) meta[META.bodyOptions] = cloneAt(w, raw.options, `${path}.options`);
  const handled = new Set(['mode', 'options', 'disabled', mode]);
  const extras = collectExtras(w, raw, handled, path, BODY_MODE_FIELDS);
  if (extras) meta[META.bodyExtra] = extras;
  return body;
}

// ---------- auth ----------

/** Info needed to re-emit an auth block exactly as it was read. */
export interface AuthMeta {
  /** Original per-parameter `type` labels that differ from what the value implies. */
  paramTypes?: Record<string, string>;
  /** Parameters whose structured (array/object) value is stored as JSON text. */
  jsonParams?: string[];
  /** Unknown keys next to `type` and the type's parameter list. */
  extras?: JsonObject;
}

export type AuthLevel = 'collection' | 'folder' | 'request';

export interface ImportedAuth {
  auth: AuthConfig;
  meta?: AuthMeta;
}

const AUTH_TYPE_KEYS: ReadonlySet<string> = new Set(['basic', 'bearer', 'apikey', 'oauth2', 'oauth1', 'awsv4', 'jwt', 'digest', 'hawk', 'ntlm', 'edgegrid', 'asap', 'akamai']);

function inheritedAuth(level: AuthLevel): ImportedAuth {
  return { auth: { type: level === 'collection' ? 'none' : 'inherit', params: {} } };
}

function paramEntries(w: WarningCollector, section: unknown, path: string): Array<{ key: string; value: unknown; type?: string }> {
  if (Array.isArray(section)) {
    const out: Array<{ key: string; value: unknown; type?: string }> = [];
    section.forEach((e: unknown, i) => {
      if (isRecord(e) && typeof e.key === 'string') out.push({ key: e.key, value: e.value, ...(typeof e.type === 'string' ? { type: e.type } : {}) });
      else w.warn(`${path}[${i}]`, 'Auth parameter without a key skipped', e);
    });
    return out;
  }
  if (isRecord(section)) return Object.keys(section).filter((k) => !UNSAFE_KEYS.has(k)).map((key) => ({ key, value: section[key] }));
  if (section !== undefined && section !== null) w.warn(path, 'Auth parameters are neither an array nor an object; ignored', section);
  return [];
}

function readAuthParams(w: WarningCollector, section: unknown, path: string, meta: AuthMeta): Record<string, AuthParamValue> {
  const params: Record<string, AuthParamValue> = {};
  for (const { key, value, type } of paramEntries(w, section, path)) {
    let stored: AuthParamValue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') stored = value;
    else if (value === undefined || value === null) stored = '';
    else {
      stored = JSON.stringify(cloneAt(w, value, `${path}.${key}`));
      (meta.jsonParams ??= []).push(key);
      const empty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
      w.add(empty ? 'INFO' : 'WARNING', `${path}.${key}`, `Structured auth parameter "${key}" stored as JSON text`, value);
    }
    params[key] = stored;
    if (type !== undefined && type !== inferParamType(stored)) (meta.paramTypes ??= {})[key] = type;
  }
  return params;
}

function metaOrUndefined(meta: AuthMeta): AuthMeta | undefined {
  return meta.paramTypes || meta.jsonParams || meta.extras ? meta : undefined;
}

export function convertAuth(w: WarningCollector, raw: unknown, path: string, level: AuthLevel): ImportedAuth {
  if (raw === undefined || raw === null) return inheritedAuth(level);
  if (!isRecord(raw)) {
    w.warn(path, 'Auth is not an object; ignored', raw);
    return inheritedAuth(level);
  }
  const type = typeof raw.type === 'string' ? raw.type : Object.keys(raw).find((k) => AUTH_TYPE_KEYS.has(k));
  if (type === undefined) {
    w.warn(path, 'Auth has no type; ignored', raw);
    return inheritedAuth(level);
  }
  if (type === 'inherit') return inheritedAuth(level);
  const internal = toInternalAuthType(type);
  const meta: AuthMeta = {};
  const extras = collectExtras(w, raw, new Set(['type', type]), path, AUTH_TYPE_KEYS);
  if (extras) meta.extras = extras;
  if (internal === 'none') return { auth: { type: 'none', params: {} }, ...(meta.extras ? { meta } : {}) };
  let params = readAuthParams(w, raw[type], `${path}.${type}`, meta);
  if (internal === 'custom') {
    w.warn(path, `Auth type "${type}" is not natively supported; imported as a custom provider and preserved for export`, { type });
    params = { providerId: type, ...params };
  }
  const result: ImportedAuth = { auth: { type: internal, params } };
  const kept = metaOrUndefined(meta);
  if (kept) result.meta = kept;
  return result;
}

// ---------- events (scripts) ----------

export interface ImportedEvents {
  scripts: ScriptEntry[];
  /** Parallel to `scripts`: id/name and other keys of the event and its script object. */
  scriptExtras?: Array<{ event?: JsonObject; script?: JsonObject }>;
  /** Events that could not be mapped (unknown `listen`, external `src`), kept verbatim. */
  eventExtras?: unknown[];
}

const EVENT_KNOWN: ReadonlySet<string> = new Set(['listen', 'script', 'disabled']);
const SCRIPT_KNOWN: ReadonlySet<string> = new Set(['exec']);
const IDENTIFIER_KEYS: ReadonlySet<string> = new Set(['id', 'name']);
const SCRIPT_QUIET: ReadonlySet<string> = new Set(['src', 'type']);
const NO_KEYS: ReadonlySet<string> = new Set();

function execToSource(exec: unknown): string | undefined {
  if (Array.isArray(exec)) return exec.map(toStr).join('\n');
  return typeof exec === 'string' ? exec : undefined;
}

export function convertEvents(w: WarningCollector, raw: unknown, path: string): ImportedEvents {
  const result: ImportedEvents = { scripts: [] };
  if (raw === undefined || raw === null) return result;
  if (!Array.isArray(raw)) {
    w.warn(path, 'Expected an array of events; ignored', raw);
    return result;
  }
  const extras: Array<{ event?: JsonObject; script?: JsonObject }> = [];
  raw.forEach((ev: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(ev)) {
      w.warn(at, 'Event is not an object; skipped', ev);
      return;
    }
    const keepVerbatim = (message: string): void => {
      w.warn(at, message, ev);
      (result.eventExtras ??= []).push(cloneAt(w, ev, at));
    };
    const { listen, script } = ev;
    if (listen !== 'prerequest' && listen !== 'test') return keepVerbatim(`Unsupported event type "${toStr(listen)}"; preserved in metadata and not executed`);
    if (!isRecord(script)) return keepVerbatim('Event has no script object; preserved in metadata');
    const source = execToSource(script.exec);
    if (source === undefined) {
      return keepVerbatim(script.src !== undefined ? 'External script (src) is not fetched; preserved in metadata and not executed' : 'Event script has no exec; preserved in metadata');
    }
    const scriptType = script.type;
    if (scriptType !== undefined && scriptType !== 'text/javascript') w.warn(`${at}.script.type`, `Script type "${toStr(scriptType)}" is treated as JavaScript; original type preserved`, scriptType);
    const scriptKnown = scriptType === 'text/javascript' ? new Set([...SCRIPT_KNOWN, 'type']) : SCRIPT_KNOWN;
    const eventExtra = collectExtras(w, ev, EVENT_KNOWN, at, NO_KEYS, IDENTIFIER_KEYS);
    const scriptExtra = collectExtras(w, script, scriptKnown, `${at}.script`, SCRIPT_QUIET, IDENTIFIER_KEYS);
    result.scripts.push({ type: listen, language: 'javascript', source, enabled: ev.disabled !== true });
    extras.push({ ...(eventExtra ? { event: eventExtra } : {}), ...(scriptExtra ? { script: scriptExtra } : {}) });
  });
  if (extras.some((e) => e.event || e.script)) result.scriptExtras = extras;
  return result;
}

/** Store the non-script parts of an events conversion into `meta`. */
export function applyEventMeta(meta: JsonObject, events: ImportedEvents): void {
  if (events.scriptExtras) meta[META.scriptExtras] = events.scriptExtras;
  if (events.eventExtras) meta[META.eventExtras] = events.eventExtras;
}

// ---------- examples ----------

const EXAMPLE_KNOWN: ReadonlySet<string> = new Set(['id', 'name', 'originalRequest', 'status', 'code', '_postman_previewlanguage', 'header', 'cookie', 'body']);
const EXAMPLE_QUIET: ReadonlySet<string> = new Set(['responseTime', 'timings']);

export function convertExamples(w: WarningCollector, raw: unknown, path: string): RequestExample[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    w.warn(path, 'Expected an array of responses; ignored', raw);
    return [];
  }
  const out: RequestExample[] = [];
  raw.forEach((r: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(r)) {
      w.warn(at, 'Saved response is not an object; skipped', r);
      return;
    }
    const code = typeof r.code === 'number' ? r.code : Number(r.code ?? 0);
    if (!Number.isFinite(code)) w.warn(`${at}.code`, 'Invalid status code; using 0', r.code);
    const metadata: JsonObject = {};
    if (typeof r.id === 'string') metadata.id = r.id;
    if (r.cookie !== undefined) metadata.cookie = cloneAt(w, r.cookie, `${at}.cookie`);
    const extras = collectExtras(w, r, EXAMPLE_KNOWN, at, EXAMPLE_QUIET);
    for (const [k, v] of Object.entries(extras ?? {})) if (!(k in metadata)) metadata[k] = v;
    const example: RequestExample = {
      name: typeof r.name === 'string' ? r.name : 'Example',
      status: toStr(r.status),
      code: Number.isFinite(code) ? code : 0,
      headers: typeof r.header === 'string' ? parseHeaderString(r.header) : convertKeyValues(w, r.header, `${at}.header`),
      body: toStr(r.body),
    };
    if (typeof r._postman_previewlanguage === 'string') example.language = r._postman_previewlanguage;
    if (r.originalRequest !== undefined) example.originalRequest = cloneAt(w, r.originalRequest, `${at}.originalRequest`);
    if (Object.keys(metadata).length > 0) example.metadata = metadata;
    out.push(example);
  });
  return out;
}

// ---------- protocolProfileBehavior ----------

export function convertProtocolProfile(w: WarningCollector, raw: unknown, path: string): { settings: RequestSettings; remainder?: JsonObject } {
  const settings: RequestSettings = {};
  if (raw === undefined || raw === null) return { settings };
  if (!isRecord(raw)) {
    w.warn(path, 'protocolProfileBehavior is not an object; ignored', raw);
    return { settings };
  }
  const remainder: JsonObject = {};
  for (const [key, value] of Object.entries(raw)) {
    if (UNSAFE_KEYS.has(key)) {
      w.warn(`${path}.${key}`, `Removed unsafe key "${key}" from imported data (prototype-pollution guard)`);
    } else if (key === 'followRedirects' && typeof value === 'boolean') settings.followRedirects = value;
    else if (key === 'maxRedirects' && typeof value === 'number') settings.maxRedirects = value;
    else if (key === 'strictSSL' && typeof value === 'boolean') settings.verifyTls = value;
    else if (key === 'disableCookies' && typeof value === 'boolean') settings.disableCookies = value;
    else if (key === 'disableUrlEncoding' && typeof value === 'boolean') settings.encodeUrl = !value;
    else if (key === 'followOriginalHttpMethod' && typeof value === 'boolean') settings.followOriginalHttpMethod = value;
    else if (key === 'followAuthorizationHeader' && typeof value === 'boolean') settings.followAuthorizationHeader = value;
    else if (key === 'removeRefererHeaderOnRedirect' && typeof value === 'boolean') settings.removeRefererHeaderOnRedirect = value;
    else {
      remainder[key] = cloneAt(w, value, `${path}.${key}`);
      w.info(`${path}.${key}`, `protocolProfileBehavior "${key}" is not supported by the request engine; preserved in metadata`, value);
    }
  }
  return Object.keys(remainder).length > 0 ? { settings, remainder } : { settings };
}
