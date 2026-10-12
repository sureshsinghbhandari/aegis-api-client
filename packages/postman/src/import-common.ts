/**
 * Helpers shared by the non-Postman-v2 importers (HAR, Insomnia, Postman v1,
 * Postman data dump). They enforce the same safety rules as the v2 importer:
 * size/item/depth limits, prototype-pollution-safe copying, validated file
 * references (never stored when unsafe) and credential placeholders.
 */
import { AppError } from '@aegis/core';
import type { ImportProgress, ImportStage, ImportStats, KeyValueEntry, RawLanguage, RequestDraft, VariableEntry } from '@aegis/core';
import { splitUrl } from '@aegis/core';
import { checkImportedFilePath, isSensitiveKey } from '@aegis/security';
import type { JsonObject } from './shared';
import { DEFAULT_MAX_BYTES, failImport, isRecord, parseRawQuery, toStr } from './shared';
import type { WarningCollector } from './warnings';

export interface ImportLimitOptions {
  /** Maximum size of a JSON string input (default 256 MiB). */
  maxBytes?: number;
  /** Maximum number of importable records (entries, resources, requests + folders; default 200000). */
  maxItems?: number;
  /** Maximum folder nesting (default 64). */
  maxDepth?: number;
  onProgress?: (progress: ImportProgress) => void;
}

export interface ResolvedLimits {
  maxBytes: number;
  maxItems: number;
  maxDepth: number;
  onProgress?: (progress: ImportProgress) => void;
}

export const DEFAULT_MAX_ITEMS = 200_000;
export const DEFAULT_MAX_DEPTH = 64;
export const PROGRESS_EVERY = 50;
/** Largest saved-response body (bytes of text) copied into an example. */
export const DEFAULT_MAX_EXAMPLE_BODY_BYTES = 1024 * 1024;

export function resolveLimits(options: ImportLimitOptions): ResolvedLimits {
  const out: ResolvedLimits = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxItems: options.maxItems ?? DEFAULT_MAX_ITEMS,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  if (options.onProgress) out.onProgress = options.onProgress;
  return out;
}

export function emitProgress(limits: Pick<ResolvedLimits, 'onProgress'>, stage: ImportStage, current: number, total: number): void {
  limits.onProgress?.({ stage, current, total });
}

export function newStats(): ImportStats {
  return { folders: 0, requests: 0, variables: 0, scripts: 0, examples: 0 };
}

export function addStats(target: ImportStats, extra: ImportStats): void {
  target.folders += extra.folders;
  target.requests += extra.requests;
  target.variables += extra.variables;
  target.scripts += extra.scripts;
  target.examples += extra.examples;
}

export function countScripts(scripts: ReadonlyArray<{ source: string }>): number {
  return scripts.filter((s) => s.source.trim() !== '').length;
}

/** Throw IMPORT_TOO_LARGE when `count` exceeds the item limit. */
export function assertItemCount(count: number, limits: ResolvedLimits, what: string): void {
  if (count > limits.maxItems) {
    throw new AppError('IMPORT_TOO_LARGE', `The file contains more than ${limits.maxItems} ${what}.`, { maxItems: limits.maxItems });
  }
}

/** Fail with IMPORT_INVALID when a folder tree is deeper than the limit. */
export function assertDepth(depth: number, limits: ResolvedLimits, w: WarningCollector, path: string): void {
  if (depth > limits.maxDepth) failImport(w, path, `Folders are nested deeper than the supported limit of ${limits.maxDepth} levels.`);
}

/** Run an importer, mapping stack overflows (hostile nesting) to IMPORT_INVALID like the v2 importer does. */
export function guardImport<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RangeError) throw new AppError('IMPORT_INVALID', 'The document is nested too deeply to import.', {}, { cause: e });
    throw e;
  }
}

// ---------- requests ----------

export function newDraft(init: Pick<RequestDraft, 'name' | 'method' | 'url'> & Partial<RequestDraft>): RequestDraft {
  return {
    description: '',
    headers: [],
    queryParams: [],
    pathVariables: [],
    body: { mode: 'none' },
    auth: { type: 'inherit', params: {} },
    scripts: [],
    examples: [],
    settings: {},
    metadata: {},
    ...init,
  };
}

export const MAX_NAME_LENGTH = 120;

export function clampName(name: string, fallback: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return fallback;
  return trimmed.length > MAX_NAME_LENGTH ? `${trimmed.slice(0, MAX_NAME_LENGTH - 1)}…` : trimmed;
}

/** Request name in the style of Postman's HAR import: `GET /v1/users`. */
export function requestNameFromUrl(method: string, url: string): string {
  let target = url;
  try {
    const parsed = new URL(url);
    target = parsed.pathname || '/';
  } catch {
    const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*(\/[^?#]*)?/.exec(url);
    if (m) target = m[1] ?? '/';
  }
  return clampName(`${method} ${target}`, method);
}

export interface SplitUrlResult {
  url: string;
  queryParams: KeyValueEntry[];
  /** Fragment including the leading `#`. */
  hash?: string;
}

/** Split a URL string into the base (stored in `RequestDraft.url`), the query rows and the fragment. */
export function splitRequestUrl(text: string): SplitUrlResult {
  const { base, query, hash } = splitUrl(text.trim());
  const out: SplitUrlResult = { url: base, queryParams: parseRawQuery(query) };
  if (hash) out.hash = hash;
  return out;
}

/** Remove `user:password@` from a URL; the credentials are never stored. */
export function stripUrlCredentials(w: WarningCollector, url: string, path: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#@]+)@/.exec(url);
  if (!m) return url;
  w.warn(path, 'Credentials embedded in the URL (user:password@host) were removed and not imported');
  return `${m[1]}${url.slice(m[0].length)}`;
}

// ---------- bodies ----------

const TEXTUAL_MIME = /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson|ld\+json|problem\+json)|application\/[\w.+-]*\+(json|xml)$)/i;

/** Media type without parameters, lower-cased. */
export function baseMimeType(value: unknown): string {
  return toStr(value).split(';')[0]!.trim().toLowerCase();
}

export function isTextualMime(mime: string): boolean {
  return mime === '' || TEXTUAL_MIME.test(mime);
}

/** Postman raw-body language for a media type; undefined when the type is not textual or unknown. */
export function rawLanguageFromMime(mime: string): RawLanguage | undefined {
  if (mime === '') return undefined;
  if (/json$/.test(mime)) return 'json';
  if (/xml$/.test(mime)) return 'xml';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (/javascript$|ecmascript$/.test(mime)) return 'javascript';
  if (mime.startsWith('text/')) return 'text';
  return undefined;
}

/** `a=1&b=hello+world` of a form body into decoded rows (the request engine re-encodes them). */
export function parseUrlencodedBody(text: string): KeyValueEntry[] {
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      return s;
    }
  };
  return parseRawQuery(text.trim()).map((e) => ({ key: decode(e.key), value: decode(e.value), enabled: true }));
}

/** Validate a file reference found in an imported document; unsafe paths are NOT stored. */
export function safeFilePath(w: WarningCollector, src: unknown, path: string): string | undefined {
  if (src === undefined || src === null || src === '') return undefined;
  if (typeof src !== 'string') {
    w.warn(path, 'File reference is not a string; ignored', src);
    return undefined;
  }
  const verdict = checkImportedFilePath(src);
  if (!verdict.safe) {
    w.warn(path, `Unsafe file path rejected (${verdict.reason}); the path was not imported`, src);
    return undefined;
  }
  return src;
}

// ---------- key/value rows ----------

/** Read `{ name|key, value, disabled?, enabled?, description? }` rows (HAR, Insomnia, v1 shapes). */
export function convertNamedRows(w: WarningCollector, raw: unknown, path: string): KeyValueEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    w.warn(path, 'Expected an array; ignored', raw);
    return [];
  }
  const out: KeyValueEntry[] = [];
  raw.forEach((e: unknown, i) => {
    if (!isRecord(e)) {
      w.warn(`${path}[${i}]`, 'Entry is not an object; skipped', e);
      return;
    }
    const key = typeof e.name === 'string' ? e.name : toStr(e.key);
    const entry: KeyValueEntry = { key, value: toStr(e.value), enabled: e.disabled !== true && e.enabled !== false };
    const description = typeof e.description === 'string' ? e.description : '';
    if (description !== '') entry.description = description;
    out.push(entry);
  });
  return out;
}

// ---------- credentials ----------

export type CredentialKind = 'header' | 'query' | 'form' | 'cookie' | 'body';

const KIND_LABEL: Record<CredentialKind, string> = { header: 'header', query: 'query parameter', form: 'form field', cookie: 'cookie', body: 'JSON body field' };

const MAX_SCRUB_DEPTH = 64;

/** Is this header/parameter name one that carries a credential? */
export function isCredentialKey(name: string): boolean {
  return isSensitiveKey(name);
}

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s === '' ? 'value' : s;
}

/**
 * Replaces credential-bearing values (Authorization, Cookie, Set-Cookie, API
 * keys ...) with `{{variable}}` placeholders and records one secret-flagged,
 * EMPTY collection variable per distinct credential. The literal value is never
 * stored anywhere in the bundle or the warnings.
 */
export class CredentialPlaceholders {
  readonly variables: VariableEntry[] = [];
  private readonly byValue = new Map<string, string>();
  private readonly used = new Set<string>();

  constructor(
    private readonly w: WarningCollector,
    private readonly prefix: string,
    private readonly sourceLabel: string,
  ) {}

  private uniqueKey(base: string): string {
    let key = base;
    for (let n = 2; this.used.has(key); n++) key = `${base}_${n}`;
    this.used.add(key);
    return key;
  }

  /** Placeholder text for `value`; `''` stays `''` (nothing to protect). */
  replace(kind: CredentialKind, name: string, value: string, path: string): string {
    if (value === '') return '';
    const id = `${kind}\0${name.toLowerCase()}\0${value}`;
    let key = this.byValue.get(id);
    if (key === undefined) {
      key = this.uniqueKey(`${this.prefix}_${slug(name)}`);
      this.byValue.set(id, key);
      this.variables.push({
        key,
        initialValue: '',
        isSecret: true,
        enabled: true,
        type: 'secret',
        description: `Value of the "${name}" ${KIND_LABEL[kind]} captured in the ${this.sourceLabel}; the credential was not imported. Fill it in before sending.`,
      });
    }
    this.w.info(path, `Credential value of ${KIND_LABEL[kind]} "${name}" replaced with {{${key}}}; the literal value was not imported`);
    return `{{${key}}}`;
  }

  /** Apply {@link replace} to every row whose key looks like a credential. */
  scrubRows(kind: CredentialKind, rows: KeyValueEntry[], path: string): KeyValueEntry[] {
    return rows.map((row, i) => (isCredentialKey(row.key) ? { ...row, value: this.replace(kind, row.key, row.value, `${path}[${i}].value`) } : row));
  }

  /**
   * JSON text whose string values under credential-looking keys are replaced
   * with placeholders. Returns the text unchanged when it is not JSON or holds
   * no credential (so formatting is only normalised when something changed).
   */
  scrubJson(text: string, path: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    let changed = false;
    const stack: Array<{ value: unknown; at: string; depth: number }> = [{ value: parsed, at: path, depth: 0 }];
    for (let frame = stack.pop(); frame; frame = stack.pop()) {
      if (frame.depth > MAX_SCRUB_DEPTH) continue;
      const { value } = frame;
      if (Array.isArray(value)) {
        value.forEach((v, i) => stack.push({ value: v, at: `${frame.at}[${i}]`, depth: frame.depth + 1 }));
      } else if (isRecord(value)) {
        for (const key of Object.keys(value)) {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          const v = value[key];
          if (typeof v === 'string' && isCredentialKey(key)) {
            const replaced = this.replace('body', key, v, `${frame.at}.${key}`);
            if (replaced !== v) {
              value[key] = replaced;
              changed = true;
            }
          } else if (typeof v === 'object' && v !== null) stack.push({ value: v, at: `${frame.at}.${key}`, depth: frame.depth + 1 });
        }
      }
    }
    return changed ? JSON.stringify(parsed) : text;
  }
}

// ---------- variables ----------

export interface FlatVariable {
  key: string;
  value: string;
}

/** Flatten a nested `{ a: { b: 1 } }` object into `a.b` keys; unsafe keys are dropped and reported. */
export function flattenVariables(w: WarningCollector, data: JsonObject, path: string): FlatVariable[] {
  const out: FlatVariable[] = [];
  const stack: Array<{ obj: JsonObject; prefix: string; at: string; depth: number }> = [{ obj: data, prefix: '', at: path, depth: 0 }];
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    for (const [k, v] of Object.entries(frame.obj)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        w.warn(`${frame.at}.${k}`, `Removed unsafe key "${k}" from imported data (prototype-pollution guard)`);
        continue;
      }
      const key = frame.prefix ? `${frame.prefix}.${k}` : k;
      const at = `${frame.at}.${k}`;
      if (isRecord(v)) {
        if (frame.depth >= 16) {
          w.warn(at, 'Variable object nested too deeply; stored as JSON text', v);
          out.push({ key, value: toStr(v) });
        } else stack.push({ obj: v, prefix: key, at, depth: frame.depth + 1 });
        continue;
      }
      if (Array.isArray(v)) w.info(at, 'Array variable value stored as JSON text', v);
      out.push({ key, value: toStr(v) });
    }
  }
  return out;
}

/** Build a variable row; names that look like credentials are flagged secret (vaulted on save). */
export function variableEntry(key: string, value: string, options: { secret?: boolean; description?: string; enabled?: boolean } = {}): VariableEntry {
  const secret = options.secret ?? isCredentialKey(key);
  const entry: VariableEntry = { key, initialValue: value, isSecret: secret, enabled: options.enabled ?? true };
  if (secret) entry.type = 'secret';
  if (options.description) entry.description = options.description;
  return entry;
}
