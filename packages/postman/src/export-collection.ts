import type {
  AuthConfig,
  AuthParamValue,
  CollectionBundle,
  FolderNode,
  FormDataEntry,
  ItemNode,
  KeyValueEntry,
  RawLanguage,
  RequestDraft,
  RequestExample,
  RequestSettings,
  ScriptEntry,
  VariableEntry,
} from '@aegis/core';
import type { AuthMeta } from './import-parts';
import type { JsonObject } from './shared';
import {
  META,
  SCHEMA_V21,
  blankAuthSecrets,
  cloneSafe,
  decomposeUrl,
  graphqlToRaw,
  inferParamType,
  isRawLanguage,
  isRecord,
  mergeExtras,
  rawToGraphql,
  serializeRawQuery,
  shouldBlankAuthParam,
  toInternalAuthType,
  uuidFromName,
  writeDescription,
} from './shared';

export interface ExportOptions {
  /** Emit credentials as stored. Default false: secrets are blanked. */
  includeSecrets?: boolean;
}

/** A plain, JSON-serialisable Postman Collection v2.1 document. */
export interface PostmanCollectionV21 {
  info: JsonObject;
  item: JsonObject[];
  [key: string]: unknown;
}

/** Deterministic JSON text: 2-space indent and a trailing newline. */
export function serializePostmanJson(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

type Level = 'collection' | 'folder' | 'request';

function clone<T>(value: T): T {
  return cloneSafe(value) as T;
}

function strOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ---------- key/value lists ----------

function withCommon(o: JsonObject, e: { enabled: boolean; description?: string }): JsonObject {
  if (e.description) o.description = e.description;
  if (!e.enabled) o.disabled = true;
  return o;
}

function exportHeader(e: KeyValueEntry): JsonObject {
  return withCommon({ key: e.key, value: e.value, type: 'text' }, e);
}

function exportKeyValue(e: KeyValueEntry): JsonObject {
  return withCommon({ key: e.key, value: e.value }, e);
}

// ---------- URL ----------

function exportUrl(r: RequestDraft): JsonObject {
  const hash = strOrUndefined(r.metadata[META.urlHash]) ?? '';
  const query = serializeRawQuery(r.queryParams);
  const url: JsonObject = { raw: `${r.url}${query ? `?${query}` : ''}${hash}` };
  const parts = decomposeUrl(r.url);
  if (parts.protocol) url.protocol = parts.protocol;
  if (parts.host.length > 0) url.host = parts.host;
  if (parts.port) url.port = parts.port;
  if (parts.path.length > 0) url.path = parts.path;
  if (r.queryParams.length > 0) url.query = r.queryParams.map(exportKeyValue);
  if (r.pathVariables.length > 0) url.variable = r.pathVariables.map(exportKeyValue);
  if (hash) url.hash = hash.slice(1);
  mergeExtras(url, r.metadata[META.urlExtras]);
  return url;
}

// ---------- body ----------

function rawOptions(language: RawLanguage | undefined, stored: unknown): JsonObject | undefined {
  const options: JsonObject = isRecord(stored) ? clone(stored) : {};
  const rawPart: JsonObject = isRecord(options.raw) ? options.raw : {};
  const original = rawPart.language;
  // An unknown source language was imported as 'text'; keep the original unless the user changed it.
  const keepOriginal = typeof original === 'string' && !isRawLanguage(original) && (language === undefined || language === 'text');
  if (language !== undefined && !keepOriginal) rawPart.language = language;
  if (Object.keys(rawPart).length > 0) options.raw = rawPart;
  return Object.keys(options).length > 0 ? options : undefined;
}

function exportFormData(e: FormDataEntry): JsonObject {
  const o: JsonObject = { key: e.key };
  if (e.type === 'file') {
    o.type = 'file';
    o.src = e.filePath ?? null;
  } else {
    // `variable` entries reference a variable by name; Postman expresses that as {{name}}.
    o.value = e.type === 'variable' ? `{{${e.value}}}` : e.value;
    o.type = 'text';
  }
  if (e.contentType) o.contentType = e.contentType;
  return withCommon(o, e);
}

function exportGraphQl(r: RequestDraft): JsonObject {
  const original = r.metadata[META.graphqlBody];
  const raw = r.body.raw ?? '';
  return { mode: 'graphql', graphql: isRecord(original) && graphqlToRaw(original) === raw ? clone(original) : rawToGraphql(raw) };
}

function exportBody(r: RequestDraft): JsonObject | undefined {
  const { body, metadata } = r;
  if (body.mode === 'none') {
    const original = metadata[META.bodyOriginal];
    return isRecord(original) ? clone(original) : undefined;
  }
  let out: JsonObject;
  if (body.mode === 'raw') {
    if (metadata[META.originalBodyMode] === 'graphql') out = exportGraphQl(r);
    else {
      out = { mode: 'raw', raw: body.raw ?? '' };
      const options = rawOptions(body.rawLanguage, metadata[META.bodyOptions]);
      if (options) out.options = options;
    }
  } else if (body.mode === 'graphql') {
    const g = body.graphql ?? { query: '', variables: '' };
    out = { mode: 'graphql', graphql: { query: g.query, variables: g.variables, ...(g.operationName ? { operationName: g.operationName } : {}) } };
    if (isRecord(metadata[META.bodyOptions])) out.options = clone(metadata[META.bodyOptions]);
  } else {
    if (body.mode === 'urlencoded') out = { mode: 'urlencoded', urlencoded: (body.urlencoded ?? []).map((e) => withCommon({ key: e.key, value: e.value, type: 'text' }, e)) };
    else if (body.mode === 'formdata') out = { mode: 'formdata', formdata: (body.formData ?? []).map(exportFormData) };
    else out = { mode: 'file', file: body.filePath ? { src: body.filePath } : {} };
    if (isRecord(metadata[META.bodyOptions])) out.options = clone(metadata[META.bodyOptions]);
  }
  mergeExtras(out, metadata[META.bodyExtra]);
  return out;
}

// ---------- auth ----------

function readAuthMeta(meta: JsonObject): AuthMeta {
  const raw = meta[META.authMeta];
  if (!isRecord(raw)) return {};
  const out: AuthMeta = {};
  if (isRecord(raw.paramTypes)) out.paramTypes = raw.paramTypes as Record<string, string>;
  if (Array.isArray(raw.jsonParams)) out.jsonParams = raw.jsonParams.filter((k): k is string => typeof k === 'string');
  if (isRecord(raw.extras)) out.extras = raw.extras;
  return out;
}

function authParamValue(value: AuthParamValue, key: string, meta: AuthMeta): unknown {
  if (!meta.jsonParams?.includes(key) || typeof value !== 'string' || value === '') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function exportAuth(auth: AuthConfig, metadata: JsonObject, level: Level, includeSecrets: boolean): JsonObject | undefined {
  if (auth.type === 'inherit') return undefined;
  const meta = readAuthMeta(metadata);
  if (auth.type === 'none') {
    if (level === 'collection' && !meta.extras) return undefined;
    return { type: 'noauth', ...(meta.extras ? clone(meta.extras) : {}) };
  }
  const effective = includeSecrets ? auth : blankAuthSecrets(auth);
  let type: string = effective.type;
  let params = effective.params;
  if (effective.type === 'custom') {
    const providerId = params.providerId;
    if (typeof providerId !== 'string' || providerId === '') return undefined;
    type = providerId;
    params = Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'providerId'));
  }
  const entries = Object.entries(params).map(([key, value]) => ({
    key,
    value: authParamValue(value, key, meta),
    type: meta.paramTypes?.[key] ?? inferParamType(value),
  }));
  const out: JsonObject = { type, [type]: entries };
  mergeExtras(out, meta.extras);
  return out;
}

/** Blank credentials inside a raw Postman auth object (used for saved-response `originalRequest`s). */
function blankPostmanAuth(auth: JsonObject): JsonObject {
  const type = strOrUndefined(auth.type);
  if (!type) return auth;
  const internal = toInternalAuthType(type);
  const section = auth[type];
  if (Array.isArray(section)) {
    auth[type] = section.map((e: unknown) =>
      isRecord(e) && typeof e.key === 'string' && shouldBlankAuthParam(internal, e.key, e.value) ? { ...e, value: '' } : e,
    );
  } else if (isRecord(section)) {
    for (const key of Object.keys(section)) if (shouldBlankAuthParam(internal, key, section[key])) section[key] = '';
  }
  return auth;
}

// ---------- scripts ----------

function exportEvents(scripts: readonly ScriptEntry[], meta: JsonObject): JsonObject[] {
  const stored = meta[META.scriptExtras];
  const extras = Array.isArray(stored) && stored.length === scripts.length ? stored : [];
  const events = scripts.map((s, i): JsonObject => {
    const extra: unknown = extras[i];
    const eventExtra = isRecord(extra) && isRecord(extra.event) ? extra.event : {};
    const scriptExtra = isRecord(extra) && isRecord(extra.script) ? extra.script : {};
    const script: JsonObject = {};
    if ('id' in scriptExtra) script.id = scriptExtra.id;
    script.type = strOrUndefined(scriptExtra.type) ?? 'text/javascript';
    script.exec = s.source.split('\n');
    mergeExtras(script, scriptExtra);
    const ev: JsonObject = {};
    if ('id' in eventExtra) ev.id = eventExtra.id;
    ev.listen = s.type;
    ev.script = script;
    if (!s.enabled) ev.disabled = true;
    mergeExtras(ev, eventExtra);
    return ev;
  });
  const unmapped = meta[META.eventExtras];
  if (Array.isArray(unmapped)) for (const ev of unmapped) events.push(clone(ev) as JsonObject);
  return events;
}

// ---------- variables ----------

function exportVariable(v: VariableEntry, includeSecrets: boolean): JsonObject {
  const out: JsonObject = { key: v.key, value: v.isSecret && !includeSecrets ? '' : v.initialValue };
  const type = v.isSecret ? 'secret' : v.type;
  if (type !== undefined) out.type = type;
  return withCommon(out, v);
}

// ---------- examples ----------

function exportExample(e: RequestExample, includeSecrets: boolean): JsonObject {
  const md = e.metadata ?? {};
  const out: JsonObject = {};
  if (typeof md.id === 'string') out.id = md.id;
  out.name = e.name;
  if (e.originalRequest !== undefined) {
    const original = clone(e.originalRequest);
    if (!includeSecrets && isRecord(original) && isRecord(original.auth)) original.auth = blankPostmanAuth(original.auth);
    out.originalRequest = original;
  }
  out.status = e.status;
  out.code = e.code;
  if (e.language !== undefined) out._postman_previewlanguage = e.language;
  out.header = e.headers.map(exportKeyValue);
  out.cookie = md.cookie === undefined ? [] : clone(md.cookie);
  out.body = e.body;
  const rest = Object.fromEntries(Object.entries(md).filter(([k]) => k !== 'id' && k !== 'cookie'));
  mergeExtras(out, rest);
  return out;
}

// ---------- items ----------

function exportProfile(settings: RequestSettings, meta: JsonObject): JsonObject | undefined {
  const out: JsonObject = {};
  if (settings.followRedirects !== undefined) out.followRedirects = settings.followRedirects;
  if (settings.maxRedirects !== undefined) out.maxRedirects = settings.maxRedirects;
  if (settings.verifyTls !== undefined) out.strictSSL = settings.verifyTls;
  if (settings.disableCookies !== undefined) out.disableCookies = settings.disableCookies;
  if (settings.encodeUrl !== undefined) out.disableUrlEncoding = !settings.encodeUrl;
  if (settings.followOriginalHttpMethod !== undefined) out.followOriginalHttpMethod = settings.followOriginalHttpMethod;
  if (settings.followAuthorizationHeader !== undefined) out.followAuthorizationHeader = settings.followAuthorizationHeader;
  if (settings.removeRefererHeaderOnRedirect !== undefined) out.removeRefererHeaderOnRedirect = settings.removeRefererHeaderOnRedirect;
  mergeExtras(out, meta[META.protocolProfileBehavior]);
  return Object.keys(out).length > 0 ? out : undefined;
}

function exportRequest(r: RequestDraft, includeSecrets: boolean): JsonObject {
  const req: JsonObject = {};
  const auth = exportAuth(r.auth, r.metadata, 'request', includeSecrets);
  if (auth) req.auth = auth;
  req.method = r.method;
  req.header = r.headers.map(exportHeader);
  const body = exportBody(r);
  if (body) req.body = body;
  req.url = exportUrl(r);
  const description = writeDescription(r.description, r.metadata[META.descriptionType]);
  if (description !== undefined && r.metadata[META.descriptionAt] !== 'item') req.description = description;
  mergeExtras(req, r.metadata[META.requestExtras]);
  return req;
}

function exportRequestItem(r: RequestDraft, includeSecrets: boolean): JsonObject {
  const m = r.metadata;
  const item: JsonObject = {};
  if (typeof m[META.postmanId] === 'string') item.id = m[META.postmanId];
  item.name = r.name;
  const description = writeDescription(r.description, m[META.descriptionType]);
  if (description !== undefined && m[META.descriptionAt] === 'item') item.description = description;
  const events = exportEvents(r.scripts, m);
  if (events.length > 0) item.event = events;
  item.request = exportRequest(r, includeSecrets);
  item.response = r.examples.map((e) => exportExample(e, includeSecrets));
  const profile = exportProfile(r.settings, m);
  if (profile) item.protocolProfileBehavior = profile;
  mergeExtras(item, m[META.itemExtras]);
  return item;
}

function exportFolder(f: FolderNode, includeSecrets: boolean): JsonObject {
  const m = f.metadata;
  const out: JsonObject = {};
  if (typeof m[META.postmanId] === 'string') out.id = m[META.postmanId];
  out.name = f.name;
  const description = writeDescription(f.description, m[META.descriptionType]);
  if (description !== undefined) out.description = description;
  out.item = f.items.map((i) => exportItem(i, includeSecrets));
  const events = exportEvents(f.scripts, m);
  if (events.length > 0) out.event = events;
  if (f.variables.length > 0) out.variable = f.variables.map((v) => exportVariable(v, includeSecrets));
  const auth = exportAuth(f.auth, m, 'folder', includeSecrets);
  if (auth) out.auth = auth;
  if (isRecord(m[META.protocolProfileBehavior])) out.protocolProfileBehavior = clone(m[META.protocolProfileBehavior]);
  mergeExtras(out, m[META.itemExtras]);
  return out;
}

function exportItem(node: ItemNode, includeSecrets: boolean): JsonObject {
  return node.kind === 'folder' ? exportFolder(node, includeSecrets) : exportRequestItem(node.request, includeSecrets);
}

// ---------- collection ----------

function exportInfo(bundle: CollectionBundle): JsonObject {
  const sm = bundle.sourceMetadata;
  const info: JsonObject = { _postman_id: bundle.uid ?? uuidFromName(bundle.name), name: bundle.name };
  const description = writeDescription(bundle.description, sm[META.descriptionType]);
  if (description !== undefined) info.description = description;
  info.schema = SCHEMA_V21;
  mergeExtras(info, sm[META.info]);
  return info;
}

/**
 * Export a bundle as a Postman Collection v2.1 document. Deterministic: no
 * timestamps, stable key order. Secrets are blanked unless `includeSecrets`.
 */
export function exportPostmanCollection(bundle: CollectionBundle, options: ExportOptions = {}): PostmanCollectionV21 {
  const includeSecrets = options.includeSecrets === true;
  const sm = bundle.sourceMetadata;
  const doc: PostmanCollectionV21 = { info: exportInfo(bundle), item: bundle.items.map((i) => exportItem(i, includeSecrets)) };
  const events = exportEvents(bundle.scripts, sm);
  if (events.length > 0) doc.event = events;
  if (bundle.variables.length > 0) doc.variable = bundle.variables.map((v) => exportVariable(v, includeSecrets));
  const auth = exportAuth(bundle.auth, sm, 'collection', includeSecrets);
  if (auth) doc.auth = auth;
  if (isRecord(sm[META.protocolProfileBehavior])) doc.protocolProfileBehavior = clone(sm[META.protocolProfileBehavior]);
  mergeExtras(doc, sm[META.extra]);
  return doc;
}
