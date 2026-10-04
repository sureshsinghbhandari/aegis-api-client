/**
 * Helpers and constants shared by the Postman importer, exporter, validator and
 * semantic comparison. Anything that has to be the exact inverse on import and
 * export (URL decomposition, auth parameter rules, GraphQL <-> raw) lives here.
 */
import { createHash } from 'node:crypto';
import { AppError, AUTH_SECRET_PARAMS, isVariableReferenceOnly } from '@aegis/core';
import type { AuthConfig, AuthParamValue, AuthType, KeyValueEntry, RawLanguage } from '@aegis/core';
import { isSensitiveKey } from '@aegis/security';
import type { WarningCollector } from './warnings';

export type JsonObject = Record<string, unknown>;

export const SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
export const SCHEMA_V20 = 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json';

/** Keys that must never be copied from an untrusted document into an object (prototype pollution). */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Keys used inside `metadata` / `sourceMetadata` to round-trip data the internal model has no field for. */
export const META = {
  postmanId: 'postmanId',
  itemExtras: 'itemExtras',
  requestExtras: 'requestExtras',
  eventExtras: 'eventExtras',
  scriptExtras: 'scriptExtras',
  protocolProfileBehavior: 'protocolProfileBehavior',
  bodyExtra: 'bodyExtra',
  bodyOptions: 'bodyOptions',
  bodyOriginal: 'bodyOriginal',
  originalBodyMode: 'originalBodyMode',
  graphqlBody: 'graphqlBody',
  descriptionType: '_descriptionType',
  descriptionAt: '_descriptionAt',
  authMeta: 'authMeta',
  urlExtras: 'urlExtras',
  urlHash: 'urlHash',
  info: 'info',
  extra: 'extra',
} as const;

export const RAW_LANGUAGES: readonly RawLanguage[] = ['json', 'xml', 'text', 'html', 'javascript'];

export function isRawLanguage(value: unknown): value is RawLanguage {
  return typeof value === 'string' && (RAW_LANGUAGES as readonly string[]).includes(value);
}

// ---------- generic JSON helpers ----------

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stringify a scalar the way Postman would show it; objects/arrays become JSON. */
export function toStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

const MAX_CLONE_DEPTH = 500;

/**
 * Deep-clone untrusted JSON, dropping prototype-pollution keys at every level.
 * `onUnsafeKey` is called for each dropped key.
 */
export function cloneSafe(value: unknown, onUnsafeKey?: (key: string) => void, depth = 0): unknown {
  if (depth > MAX_CLONE_DEPTH) throw new AppError('IMPORT_INVALID', 'The document contains data nested too deeply.');
  if (Array.isArray(value)) return value.map((v) => cloneSafe(v, onUnsafeKey, depth + 1));
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(k)) {
        onUnsafeKey?.(k);
        continue;
      }
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      out[k] = cloneSafe(v, onUnsafeKey, depth + 1);
    }
    return out;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  return value;
}

/** Copy `extras` into `target` without overwriting existing keys or copying unsafe keys. */
export function mergeExtras(target: JsonObject, extras: unknown): void {
  if (!isRecord(extras)) return;
  for (const [k, v] of Object.entries(extras)) {
    if (UNSAFE_KEYS.has(k) || k in target) continue;
    target[k] = cloneSafe(v);
  }
}

/** Deterministic JSON text with sorted object keys (used for comparison, not output). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** uuid-shaped (version 5 style) id derived from `name`; stable across runs and machines. */
export function uuidFromName(name: string): string {
  const hex = createHash('sha1').update(name, 'utf8').digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

// ---------- import input ----------

export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** Throw IMPORT_INVALID carrying an ERROR-severity warning. */
export function failImport(w: WarningCollector, path: string, message: string): never {
  w.error(path, message);
  throw new AppError('IMPORT_INVALID', message, { warnings: w.toArray() });
}

/** Accept a JSON string (size-limited) or an already parsed value. */
export function parseJsonInput(input: unknown, maxBytes: number, w: WarningCollector): unknown {
  if (typeof input !== 'string') return input;
  if (input.length > maxBytes) {
    throw new AppError('IMPORT_TOO_LARGE', `The file is larger than the import limit of ${Math.floor(maxBytes / (1024 * 1024))} MiB.`, { maxBytes });
  }
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    return failImport(w, '', `The file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- descriptions ----------

export interface DescriptionValue {
  text: string;
  type?: string;
}

/** Postman descriptions are a string or `{ content, type }`. */
export function readDescription(raw: unknown): DescriptionValue {
  if (typeof raw === 'string') return { text: raw };
  if (isRecord(raw)) {
    const text = typeof raw.content === 'string' ? raw.content : '';
    return typeof raw.type === 'string' ? { text, type: raw.type } : { text };
  }
  return { text: '' };
}

export function writeDescription(text: string, type: unknown): string | JsonObject | undefined {
  if (text === '') return undefined;
  return typeof type === 'string' ? { content: text, type } : text;
}

// ---------- key/value lists ----------

/** Parse the Postman v2.0 header string form `"A: b\nC: d"`. */
export function parseHeaderString(text: string): KeyValueEntry[] {
  const out: KeyValueEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) out.push({ key: line.trim(), value: '', enabled: true });
    else out.push({ key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim(), enabled: true });
  }
  return out;
}

/** Query strings are kept exactly as written (no percent-decoding), so `{{vars}}` and `+`/`%XX` survive. */
export function parseRawQuery(query: string): KeyValueEntry[] {
  if (!query) return [];
  return query
    .split('&')
    .filter((p) => p.length > 0)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1 ? { key: pair, value: '', enabled: true } : { key: pair.slice(0, eq), value: pair.slice(eq + 1), enabled: true };
    });
}

export function serializeRawQuery(entries: readonly KeyValueEntry[]): string {
  return entries
    .filter((e) => e.enabled && !(e.key === '' && e.value === ''))
    .map((e) => `${e.key}=${e.value}`)
    .join('&');
}

// ---------- URL decomposition ----------

/** Index of the first `ch` that is not inside a `{{variable}}`; -1 if none. */
export function indexOfOutsideBraces(s: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' && s[i + 1] === '{') {
      depth++;
      i++;
    } else if (s[i] === '}' && s[i + 1] === '}' && depth > 0) {
      depth--;
      i++;
    } else if (s[i] === ch && depth === 0) return i;
  }
  return -1;
}

export function splitOutsideBraces(s: string, ch: string): string[] {
  const parts: string[] = [];
  let rest = s;
  for (;;) {
    const i = indexOfOutsideBraces(rest, ch);
    if (i === -1) break;
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  parts.push(rest);
  return parts;
}

export interface UrlParts {
  protocol?: string;
  host: string[];
  port?: string;
  path: string[];
}

/** Split a query-less URL into the pieces of a Postman url object. */
export function decomposeUrl(base: string): UrlParts {
  const m = /^(\{\{[^{}]+\}\}|[a-zA-Z][a-zA-Z0-9+.-]*):\/\/([\s\S]*)$/.exec(base);
  const rest = m ? m[2]! : base;
  const slash = indexOfOutsideBraces(rest, '/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const parts: UrlParts = { host: [], path: slash === -1 ? [] : splitOutsideBraces(rest.slice(slash + 1), '/') };
  if (m) parts.protocol = m[1]!;
  const pm = /^([\s\S]*):(\d+)$/.exec(authority);
  const hostText = pm ? pm[1]! : authority;
  if (pm) parts.port = pm[2]!;
  if (hostText !== '') parts.host = splitOutsideBraces(hostText, '.');
  return parts;
}

/** Inverse of {@link decomposeUrl}; tolerant of Postman's `string | string[]` / `{type,value}` shapes. */
export function composeUrlFromParts(parts: { protocol?: unknown; host?: unknown; port?: unknown; path?: unknown }): string {
  const text = (v: unknown): string => (isRecord(v) ? toStr(v.value) : toStr(v));
  let base = '';
  if (typeof parts.protocol === 'string' && parts.protocol) base += `${parts.protocol}://`;
  if (Array.isArray(parts.host)) base += parts.host.map(text).join('.');
  else if (typeof parts.host === 'string') base += parts.host;
  if (parts.port !== undefined && parts.port !== null && parts.port !== '') base += `:${toStr(parts.port)}`;
  if (Array.isArray(parts.path)) base += `/${parts.path.map(text).join('/')}`;
  else if (typeof parts.path === 'string' && parts.path) base += parts.path.startsWith('/') ? parts.path : `/${parts.path}`;
  return base;
}

// ---------- auth ----------

/** Auth types the internal model understands natively (same names as Postman). */
export const NATIVE_AUTH_TYPES: readonly string[] = ['basic', 'bearer', 'apikey', 'oauth2', 'oauth1', 'awsv4', 'jwt'];

/** Auth types that Postman Collection v2.1 (and newer Postman releases) can contain. */
export const KNOWN_POSTMAN_AUTH_TYPES: ReadonlySet<string> = new Set([
  'noauth',
  ...NATIVE_AUTH_TYPES,
  'digest',
  'hawk',
  'ntlm',
  'edgegrid',
  'asap',
  'akamai',
]);

export function toInternalAuthType(postmanType: string): AuthType {
  if (postmanType === 'noauth') return 'none';
  return NATIVE_AUTH_TYPES.includes(postmanType) ? (postmanType as AuthType) : 'custom';
}

/** Postman's `type` label for a parameter value. */
export function inferParamType(value: AuthParamValue): 'string' | 'boolean' | 'number' {
  return typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string';
}

/** True when `key` of an auth of internal `type` holds a credential. */
export function isSecretAuthParam(type: AuthType, key: string): boolean {
  if (key === 'providerId') return false;
  if (type === 'custom') return isSensitiveKey(key) || /^auth[-_]?key$/i.test(key);
  return AUTH_SECRET_PARAMS[type]?.includes(key) ?? false;
}

/** A credential parameter is blanked unless it is empty or only a `{{variable}}` reference. */
export function shouldBlankAuthParam(type: AuthType, key: string, value: unknown): boolean {
  if (!isSecretAuthParam(type, key)) return false;
  return !(typeof value === 'string' && (value === '' || isVariableReferenceOnly(value)));
}

/** Copy of `auth` with credentials blanked (variable references like `{{token}}` are kept). */
export function blankAuthSecrets(auth: AuthConfig): AuthConfig {
  const params: Record<string, AuthParamValue> = {};
  for (const [key, value] of Object.entries(auth.params)) params[key] = shouldBlankAuthParam(auth.type, key, value) ? '' : value;
  return { type: auth.type, params };
}

// ---------- GraphQL <-> raw ----------

/** The raw JSON body we store for a Postman `graphql` body. */
export function graphqlToRaw(graphql: unknown): string {
  const src = isRecord(graphql) ? graphql : {};
  const out: JsonObject = { query: typeof src.query === 'string' ? src.query : '' };
  const vars = src.variables;
  if (typeof vars === 'string') {
    if (vars.trim() !== '') {
      try {
        out.variables = JSON.parse(vars) as unknown;
      } catch {
        out.variables = vars;
      }
    }
  } else if (vars !== undefined && vars !== null) out.variables = vars;
  return JSON.stringify(out);
}

/** Best-effort inverse of {@link graphqlToRaw} for bodies edited after import. */
export function rawToGraphql(raw: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { query: raw };
  }
  if (!isRecord(parsed)) return { query: raw };
  const out: JsonObject = { query: typeof parsed.query === 'string' ? parsed.query : '' };
  if (parsed.variables !== undefined) out.variables = typeof parsed.variables === 'string' ? parsed.variables : JSON.stringify(parsed.variables, null, 2);
  return out;
}
