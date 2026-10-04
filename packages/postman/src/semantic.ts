import type {
  AuthConfig,
  CollectionBundle,
  ItemNode,
  KeyValueEntry,
  RequestBody,
  RequestDraft,
  RequestExample,
  ScriptEntry,
  VariableEntry,
} from '@aegis/core';
import { isRecord, isSecretAuthParam, stableStringify } from './shared';

export interface CompareOptions {
  /** Do not compare credential values (secret variable values and secret auth parameters). */
  ignoreSecrets?: boolean;
}

/** Collects human-readable differences. Object key order never matters; script source compares exactly. */
class Differ {
  readonly diffs: string[] = [];

  constructor(readonly options: CompareOptions) {}

  eq(path: string, a: unknown, b: unknown): void {
    const sa = typeof a === 'string' ? a : stableStringify(a);
    const sb = typeof b === 'string' ? b : stableStringify(b);
    if (sa !== sb) this.diffs.push(`${path}: ${show(sa)} !== ${show(sb)}`);
  }

  count(path: string, a: readonly unknown[], b: readonly unknown[]): boolean {
    if (a.length === b.length) return true;
    this.diffs.push(`${path}: length ${a.length} !== ${b.length}`);
    return false;
  }
}

function show(text: string): string {
  const flat = text.replace(/\n/g, '\\n');
  return JSON.stringify(flat.length > 120 ? `${flat.slice(0, 120)}…` : flat);
}

/** Saved-response request snapshots carry their own auth block; it is not compared when secrets are ignored. */
function snapshot(d: Differ, original: unknown): unknown {
  if (!d.options.ignoreSecrets || !isRecord(original)) return original ?? null;
  const { auth: _auth, ...rest } = original;
  return rest;
}

function compareKeyValues(d: Differ, path: string, a: readonly KeyValueEntry[], b: readonly KeyValueEntry[]): void {
  d.count(path, a, b);
  a.forEach((x, i) => {
    const y = b[i];
    if (!y) return;
    const at = `${path}[${i}]`;
    d.eq(`${at}.key`, x.key, y.key);
    d.eq(`${at}.value`, x.value, y.value);
    d.eq(`${at}.enabled`, x.enabled, y.enabled);
    d.eq(`${at}.description`, x.description ?? '', y.description ?? '');
  });
}

function compareBody(d: Differ, path: string, a: RequestBody, b: RequestBody): void {
  d.eq(`${path}.mode`, a.mode, b.mode);
  d.eq(`${path}.raw`, a.raw ?? '', b.raw ?? '');
  d.eq(`${path}.rawLanguage`, a.rawLanguage ?? '', b.rawLanguage ?? '');
  d.eq(`${path}.contentType`, a.contentType ?? '', b.contentType ?? '');
  d.eq(`${path}.filePath`, a.filePath ?? '', b.filePath ?? '');
  compareKeyValues(d, `${path}.urlencoded`, a.urlencoded ?? [], b.urlencoded ?? []);
  const fa = a.formData ?? [];
  const fb = b.formData ?? [];
  d.count(`${path}.formData`, fa, fb);
  fa.forEach((x, i) => {
    const y = fb[i];
    if (!y) return;
    const at = `${path}.formData[${i}]`;
    for (const k of ['key', 'type', 'value', 'filePath', 'contentType', 'description'] as const) d.eq(`${at}.${k}`, x[k] ?? '', y[k] ?? '');
    d.eq(`${at}.enabled`, x.enabled, y.enabled);
  });
}

function compareAuth(d: Differ, path: string, a: AuthConfig, b: AuthConfig): void {
  d.eq(`${path}.type`, a.type, b.type);
  const keys = [...new Set([...Object.keys(a.params), ...Object.keys(b.params)])].sort();
  for (const key of keys) {
    if (d.options.ignoreSecrets && isSecretAuthParam(a.type, key)) continue;
    d.eq(`${path}.params.${key}`, a.params[key] ?? null, b.params[key] ?? null);
  }
}

function compareScripts(d: Differ, path: string, a: readonly ScriptEntry[], b: readonly ScriptEntry[]): void {
  d.count(path, a, b);
  a.forEach((x, i) => {
    const y = b[i];
    if (!y) return;
    d.eq(`${path}[${i}].type`, x.type, y.type);
    d.eq(`${path}[${i}].source`, x.source, y.source);
    d.eq(`${path}[${i}].enabled`, x.enabled, y.enabled);
  });
}

function compareVariables(d: Differ, path: string, a: readonly VariableEntry[], b: readonly VariableEntry[]): void {
  d.count(path, a, b);
  a.forEach((x, i) => {
    const y = b[i];
    if (!y) return;
    const at = `${path}[${i}]`;
    d.eq(`${at}.key`, x.key, y.key);
    d.eq(`${at}.isSecret`, x.isSecret, y.isSecret);
    if (!(d.options.ignoreSecrets && (x.isSecret || y.isSecret))) d.eq(`${at}.initialValue`, x.initialValue, y.initialValue);
    d.eq(`${at}.enabled`, x.enabled, y.enabled);
    d.eq(`${at}.description`, x.description ?? '', y.description ?? '');
    d.eq(`${at}.type`, x.type ?? '', y.type ?? '');
  });
}

function compareExamples(d: Differ, path: string, a: readonly RequestExample[], b: readonly RequestExample[]): void {
  d.count(path, a, b);
  a.forEach((x, i) => {
    const y = b[i];
    if (!y) return;
    const at = `${path}[${i}]`;
    d.eq(`${at}.name`, x.name, y.name);
    d.eq(`${at}.status`, x.status, y.status);
    d.eq(`${at}.code`, x.code, y.code);
    d.eq(`${at}.body`, x.body, y.body);
    d.eq(`${at}.language`, x.language ?? '', y.language ?? '');
    compareKeyValues(d, `${at}.headers`, x.headers, y.headers);
    d.eq(`${at}.originalRequest`, snapshot(d, x.originalRequest), snapshot(d, y.originalRequest));
    d.eq(`${at}.metadata`, x.metadata ?? {}, y.metadata ?? {});
  });
}

function compareRequest(d: Differ, path: string, a: RequestDraft, b: RequestDraft): void {
  d.eq(`${path}.name`, a.name, b.name);
  d.eq(`${path}.description`, a.description, b.description);
  d.eq(`${path}.method`, a.method, b.method);
  d.eq(`${path}.url`, a.url, b.url);
  compareKeyValues(d, `${path}.headers`, a.headers, b.headers);
  compareKeyValues(d, `${path}.queryParams`, a.queryParams, b.queryParams);
  compareKeyValues(d, `${path}.pathVariables`, a.pathVariables, b.pathVariables);
  compareBody(d, `${path}.body`, a.body, b.body);
  compareAuth(d, `${path}.auth`, a.auth, b.auth);
  compareScripts(d, `${path}.scripts`, a.scripts, b.scripts);
  compareExamples(d, `${path}.examples`, a.examples, b.examples);
  d.eq(`${path}.settings`, a.settings, b.settings);
  d.eq(`${path}.metadata`, a.metadata, b.metadata);
}

function compareItems(d: Differ, path: string, a: readonly ItemNode[], b: readonly ItemNode[]): void {
  d.count(path, a, b);
  a.forEach((x, i) => {
    const y = b[i];
    if (!y) return;
    const at = `${path}[${i}]`;
    if (x.kind !== y.kind) return void d.diffs.push(`${at}: kind ${x.kind} !== ${y.kind}`);
    if (x.kind === 'request' && y.kind === 'request') return compareRequest(d, `${at}(${x.request.name})`, x.request, y.request);
    if (x.kind === 'folder' && y.kind === 'folder') {
      const fp = `${at}(${x.name})`;
      d.eq(`${fp}.name`, x.name, y.name);
      d.eq(`${fp}.description`, x.description, y.description);
      compareAuth(d, `${fp}.auth`, x.auth, y.auth);
      compareScripts(d, `${fp}.scripts`, x.scripts, y.scripts);
      compareVariables(d, `${fp}.variables`, x.variables, y.variables);
      d.eq(`${fp}.metadata`, x.metadata, y.metadata);
      compareItems(d, `${fp}.items`, x.items, y.items);
    }
  });
}

/** Differences between two bundles; an empty list means they are semantically equal. */
export function compareCollectionBundles(a: CollectionBundle, b: CollectionBundle, options: CompareOptions = {}): string[] {
  const d = new Differ(options);
  d.eq('name', a.name, b.name);
  d.eq('description', a.description, b.description);
  if (a.uid !== undefined) d.eq('uid', a.uid, b.uid ?? '');
  compareVariables(d, 'variables', a.variables, b.variables);
  compareAuth(d, 'auth', a.auth, b.auth);
  compareScripts(d, 'scripts', a.scripts, b.scripts);
  d.eq('sourceMetadata', a.sourceMetadata, b.sourceMetadata);
  compareItems(d, 'items', a.items, b.items);
  return d.diffs;
}
