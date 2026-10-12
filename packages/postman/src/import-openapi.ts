/**
 * OpenAPI 3.0 / 3.1 -> CollectionBundle.
 *
 * Mapping: one folder per tag, one request per operation, `servers[0]` ->
 * collection variable `baseUrl`, path parameters -> `:name` path variables,
 * query/header parameters -> rows (enabled only when required), request bodies
 * -> generated examples (depth and size limited), responses -> examples,
 * `securitySchemes` -> collection/request auth with `{{placeholder}}` variables.
 *
 * `$ref` resolution is strictly local (`#/...` JSON pointers inside this
 * document). External references are NEVER fetched: they become WARNINGs.
 */
import { AppError } from '@aegis/core';
import type {
  AuthConfig,
  AuthParamValue,
  CollectionBundle,
  FolderNode,
  FormDataEntry,
  ImportProgress,
  ImportStats,
  ImportWarningModel,
  ItemNode,
  KeyValueEntry,
  RequestBody,
  RequestDraft,
  RequestExample,
  VariableEntry,
} from '@aegis/core';
import { cloneAt } from './import-parts';
import { parseImportText } from './parse-input';
import type { JsonObject } from './shared';
import { DEFAULT_MAX_BYTES, UNSAFE_KEYS, failImport, isRecord, toStr } from './shared';
import { WarningCollector } from './warnings';

export interface ParseOpenApiOptions {
  /** Maximum size of a text input (default 256 MiB; YAML is capped at 64 MiB). */
  maxBytes?: number;
  /** Maximum number of operations (default 200000). */
  maxItems?: number;
  /** Maximum nesting depth when generating example bodies from schemas (default 8). */
  maxExampleDepth?: number;
  /** Maximum number of values generated per example (default 2000). */
  maxExampleNodes?: number;
  /** File name, used to pick the YAML parser for `.yaml`/`.yml` inputs. */
  fileName?: string;
  onProgress?: (progress: ImportProgress) => void;
}

export interface ParseOpenApiResult {
  bundle: CollectionBundle;
  warnings: ImportWarningModel[];
  stats: ImportStats;
  format: 'openapi' | 'swagger';
  /** `openapi` field (3.0.x / 3.1.x) or `2.0` for Swagger. */
  version: string;
}

const DEFAULT_MAX_ITEMS = 200_000;
const DEFAULT_MAX_EXAMPLE_DEPTH = 8;
const DEFAULT_MAX_EXAMPLE_NODES = 2000;
const MAX_EXAMPLES_PER_REQUEST = 10;
const MAX_PROPERTIES_PER_OBJECT = 200;
const MAX_REF_DEPTH = 64;
const HTTP_METHODS: ReadonlySet<string> = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 412: 'Precondition Failed',
  415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

interface Ctx {
  w: WarningCollector;
  doc: JsonObject;
  stats: ImportStats;
  variables: Map<string, VariableEntry>;
  maxExampleDepth: number;
  maxExampleNodes: number;
  /** External / unresolvable refs already reported (one warning each). */
  reportedRefs: Set<string>;
  depthWarned: boolean;
  budgetWarned: boolean;
  totalOps: number;
  doneOps: number;
  onProgress?: (p: ImportProgress) => void;
}

// ---------- $ref resolution (local only) ----------

function decodePointerSegment(seg: string): string {
  let s = seg;
  try {
    s = decodeURIComponent(seg);
  } catch {
    /* keep raw */
  }
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Resolve `#/a/b/c` inside the document. Returns undefined (and warns once) for external or dangling refs. */
function resolveRef(ctx: Ctx, ref: string, path: string): unknown {
  if (!ref.startsWith('#')) {
    if (!ctx.reportedRefs.has(ref)) {
      ctx.reportedRefs.add(ref);
      ctx.w.warn(path, `External $ref "${ref}" is not fetched (local-only import); the referenced part is left empty`, ref);
    }
    return undefined;
  }
  const pointer = ref.slice(1);
  if (pointer !== '' && !pointer.startsWith('/')) return reportDangling(ctx, ref, path);
  let cur: unknown = ctx.doc;
  for (const raw of pointer.split('/').slice(1)) {
    const seg = decodePointerSegment(raw);
    if (UNSAFE_KEYS.has(seg)) return reportDangling(ctx, ref, path);
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) && i >= 0 ? cur[i] : undefined;
    } else if (isRecord(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg];
    else cur = undefined;
    if (cur === undefined) return reportDangling(ctx, ref, path);
  }
  return cur;
}

function reportDangling(ctx: Ctx, ref: string, path: string): undefined {
  if (!ctx.reportedRefs.has(ref)) {
    ctx.reportedRefs.add(ref);
    ctx.w.warn(path, `$ref "${ref}" does not resolve inside the document; the referenced part is left empty`, ref);
  }
  return undefined;
}

interface Deref {
  value: JsonObject | undefined;
  /** Ref chain so far (cycle detection). */
  stack: readonly string[];
  cyclic: boolean;
}

/** Follow `$ref` chains to a concrete object. */
function deref(ctx: Ctx, value: unknown, path: string, stack: readonly string[] = []): Deref {
  let cur = value;
  let chain = stack;
  for (let i = 0; i < MAX_REF_DEPTH; i++) {
    if (!isRecord(cur)) return { value: undefined, stack: chain, cyclic: false };
    if (typeof cur.$ref !== 'string') return { value: cur, stack: chain, cyclic: false };
    const ref = cur.$ref;
    if (chain.includes(ref)) return { value: undefined, stack: chain, cyclic: true };
    chain = [...chain, ref];
    const target = resolveRef(ctx, ref, path);
    if (target === undefined) return { value: undefined, stack: chain, cyclic: false };
    // OpenAPI 3.1 allows siblings next to $ref (description, summary); they do not change the target.
    cur = target;
  }
  ctx.w.warn(path, 'The $ref chain is longer than the supported limit; the referenced part is left empty');
  return { value: undefined, stack: chain, cyclic: false };
}

// ---------- example generation from schemas ----------

interface Budget {
  nodes: number;
}

function firstType(schema: JsonObject): string | undefined {
  const t = schema.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.find((x) => typeof x === 'string' && x !== 'null') as string | undefined;
  if (isRecord(schema.properties)) return 'object';
  if (schema.items !== undefined) return 'array';
  return undefined;
}

function stringExample(schema: JsonObject): string {
  const format = typeof schema.format === 'string' ? schema.format : '';
  switch (format) {
    case 'date-time':
      return '2024-01-01T00:00:00Z';
    case 'date':
      return '2024-01-01';
    case 'time':
      return '00:00:00Z';
    case 'email':
      return 'user@example.com';
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';
    case 'uri':
    case 'url':
      return 'https://example.com';
    case 'hostname':
      return 'example.com';
    case 'ipv4':
      return '192.0.2.1';
    case 'ipv6':
      return '2001:db8::1';
    case 'byte':
      return 'c3RyaW5n';
    case 'binary':
      return '';
    case 'password':
      return '';
    default:
      return 'string';
  }
}

/**
 * Build an example value for a schema: explicit `example`/`examples`/`default`/`enum`
 * win, otherwise one value per type. Depth- and node-limited; `$ref` cycles end
 * the branch (an array of self-references becomes `[]`).
 */
function exampleFromSchema(ctx: Ctx, raw: unknown, path: string, stack: readonly string[], depth: number, budget: Budget): unknown {
  if (depth > ctx.maxExampleDepth) {
    if (!ctx.depthWarned) {
      ctx.depthWarned = true;
      ctx.w.info(path, `Example generation stops at ${ctx.maxExampleDepth} levels of nesting; deeper values are omitted`);
    }
    return undefined;
  }
  if (++budget.nodes > ctx.maxExampleNodes) {
    if (!ctx.budgetWarned) {
      ctx.budgetWarned = true;
      ctx.w.info(path, `Example generation is limited to ${ctx.maxExampleNodes} values per example; the rest is omitted`);
    }
    return undefined;
  }
  if (raw === true) return {};
  if (raw === false) return undefined;
  const d = deref(ctx, raw, path, stack);
  if (d.cyclic || !d.value) return undefined;
  const schema = d.value;
  const fixed = fixedExample(ctx, schema, path);
  if (fixed !== undefined) return fixed;

  if (Array.isArray(schema.allOf)) {
    let merged: JsonObject | undefined;
    for (const part of schema.allOf) {
      const v = exampleFromSchema(ctx, part, path, d.stack, depth + 1, budget);
      if (isRecord(v)) merged = { ...(merged ?? {}), ...v };
      else if (v !== undefined && merged === undefined) return v;
    }
    if (merged !== undefined) return merged;
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const list = schema[key];
    if (Array.isArray(list) && list.length > 0) return exampleFromSchema(ctx, list[0], path, d.stack, depth + 1, budget);
  }

  const type = firstType(schema);
  switch (type) {
    case 'object': {
      const out: JsonObject = {};
      const props = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
      for (const key of props.slice(0, MAX_PROPERTIES_PER_OBJECT)) {
        if (UNSAFE_KEYS.has(key)) continue;
        const v = exampleFromSchema(ctx, (schema.properties as JsonObject)[key], `${path}.${key}`, d.stack, depth + 1, budget);
        if (v !== undefined) out[key] = v;
      }
      if (props.length === 0 && isRecord(schema.additionalProperties)) {
        const v = exampleFromSchema(ctx, schema.additionalProperties, path, d.stack, depth + 1, budget);
        if (v !== undefined) out.key = v;
      }
      return out;
    }
    case 'array': {
      const item = schema.items === undefined ? undefined : exampleFromSchema(ctx, schema.items, `${path}[]`, d.stack, depth + 1, budget);
      return item === undefined ? [] : [item];
    }
    case 'string':
      return stringExample(schema);
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return typeof schema.type === 'string' ? undefined : {};
  }
}

/** `example` / `examples[0]` (3.1) / `default` / `enum[0]`, deep-cloned without unsafe keys. */
function fixedExample(ctx: Ctx, schema: JsonObject, path: string): unknown {
  if (schema.example !== undefined) return cloneAt(ctx.w, schema.example, `${path}.example`);
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return cloneAt(ctx.w, schema.examples[0], `${path}.examples[0]`);
  if (schema.default !== undefined) return cloneAt(ctx.w, schema.default, `${path}.default`);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return cloneAt(ctx.w, schema.enum[0], `${path}.enum[0]`);
  return undefined;
}

function exampleText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

// ---------- media types ----------

const JSON_LIKE = /(^application\/(.*\+)?json)|(^\*\/\*$)/i;

function pickMediaType(content: JsonObject): string | undefined {
  const keys = Object.keys(content).filter((k) => !UNSAFE_KEYS.has(k));
  return keys.find((k) => JSON_LIKE.test(k)) ?? keys.find((k) => /x-www-form-urlencoded/i.test(k)) ?? keys.find((k) => /multipart\/form-data/i.test(k)) ?? keys[0];
}

/** Example for a media type object: `example` > first of `examples` > generated from `schema`. */
function mediaExample(ctx: Ctx, media: JsonObject, path: string): unknown {
  if (media.example !== undefined) return cloneAt(ctx.w, media.example, `${path}.example`);
  if (isRecord(media.examples)) {
    for (const key of Object.keys(media.examples)) {
      if (UNSAFE_KEYS.has(key)) continue;
      const ex = deref(ctx, (media.examples as JsonObject)[key], `${path}.examples.${key}`);
      if (ex.value) {
        if (ex.value.externalValue !== undefined) {
          ctx.w.warn(`${path}.examples.${key}`, 'externalValue examples are not fetched (local-only import)', ex.value.externalValue);
          continue;
        }
        return cloneAt(ctx.w, ex.value.value, `${path}.examples.${key}.value`);
      }
    }
  }
  if (media.schema !== undefined) return exampleFromSchema(ctx, media.schema, `${path}.schema`, [], 0, { nodes: 0 });
  return undefined;
}

function rawLanguageFor(mediaType: string): RequestBody['rawLanguage'] {
  if (JSON_LIKE.test(mediaType)) return 'json';
  if (/xml/i.test(mediaType)) return 'xml';
  if (/html/i.test(mediaType)) return 'html';
  if (/javascript/i.test(mediaType)) return 'javascript';
  return 'text';
}

// ---------- parameters ----------

interface Param {
  name: string;
  in: string;
  required: boolean;
  description: string;
  value: string;
}

function paramValue(ctx: Ctx, p: JsonObject, path: string): string {
  if (p.example !== undefined) return toStr(p.example);
  if (isRecord(p.examples)) {
    for (const key of Object.keys(p.examples)) {
      if (UNSAFE_KEYS.has(key)) continue;
      const ex = deref(ctx, (p.examples as JsonObject)[key], `${path}.examples.${key}`);
      if (ex.value && ex.value.value !== undefined) return toStr(ex.value.value);
    }
  }
  if (p.schema !== undefined) {
    const v = exampleFromSchema(ctx, p.schema, `${path}.schema`, [], 0, { nodes: 0 });
    if (v === undefined || v === 'string' || (isRecord(v) && Object.keys(v).length === 0)) return '';
    return toStr(v);
  }
  return '';
}

function collectParams(ctx: Ctx, list: unknown, path: string, into: Map<string, Param>): void {
  if (list === undefined || list === null) return;
  if (!Array.isArray(list)) {
    ctx.w.warn(path, 'Expected an array of parameters; ignored', list);
    return;
  }
  list.forEach((raw, i) => {
    const at = `${path}[${i}]`;
    const d = deref(ctx, raw, at);
    const p = d.value;
    if (!p || typeof p.name !== 'string' || typeof p.in !== 'string') {
      if (raw !== undefined && !(isRecord(raw) && typeof raw.$ref === 'string')) ctx.w.warn(at, 'Parameter without name/in skipped', raw);
      return;
    }
    const description = typeof p.description === 'string' ? p.description : '';
    into.set(`${p.in}:${p.name}`, { name: p.name, in: p.in, required: p.required === true || p.in === 'path', description, value: paramValue(ctx, p, at) });
  });
}

// ---------- security ----------

interface Scheme {
  auth: AuthConfig;
  note?: string;
}

function placeholder(ctx: Ctx, key: string, secret: boolean, description: string): string {
  if (!ctx.variables.has(key)) ctx.variables.set(key, { key, initialValue: '', isSecret: secret, enabled: true, description, ...(secret ? { type: 'secret' } : {}) });
  return `{{${key}}}`;
}

function oauth2Params(ctx: Ctx, flows: JsonObject, path: string, requestedScopes: readonly string[]): Record<string, AuthParamValue> | undefined {
  const order: Array<[string, string]> = [
    ['authorizationCode', 'authorization_code'],
    ['clientCredentials', 'client_credentials'],
    ['password', 'password_credentials'],
    ['implicit', 'implicit'],
  ];
  for (const [flowName, grant] of order) {
    const flow = flows[flowName];
    if (!isRecord(flow)) continue;
    // The security requirement names the scopes an operation needs; fall back to every scope the flow defines.
    const scopes = requestedScopes.length ? [...requestedScopes] : isRecord(flow.scopes) ? Object.keys(flow.scopes).filter((k) => !UNSAFE_KEYS.has(k)) : [];
    const params: Record<string, AuthParamValue> = {
      grant_type: grant,
      addTokenTo: 'header',
      clientId: placeholder(ctx, 'clientId', false, 'OAuth 2.0 client id'),
      scope: scopes.join(' '),
    };
    if (typeof flow.authorizationUrl === 'string') params.authUrl = flow.authorizationUrl;
    if (typeof flow.tokenUrl === 'string') params.accessTokenUrl = flow.tokenUrl;
    if (typeof flow.refreshUrl === 'string') params.refreshTokenUrl = flow.refreshUrl;
    if (grant !== 'implicit') params.clientSecret = placeholder(ctx, 'clientSecret', true, 'OAuth 2.0 client secret');
    if (grant === 'password_credentials') {
      params.username = placeholder(ctx, 'username', false, 'Resource owner user name');
      params.password = placeholder(ctx, 'password', true, 'Resource owner password');
    }
    if (grant === 'implicit') ctx.w.warn(path, 'OAuth 2.0 implicit flow is deprecated and cannot be executed; the parameters are imported for reference');
    if (Object.keys(flows).length > 1) ctx.w.info(path, `Several OAuth 2.0 flows are defined; "${flowName}" was imported`);
    return params;
  }
  return undefined;
}

function schemeToAuth(ctx: Ctx, name: string, raw: unknown, path: string, requestedScopes: readonly string[] = []): Scheme {
  const d = deref(ctx, raw, path);
  const s = d.value;
  const custom = (reason: string): Scheme => {
    ctx.w.warn(path, `Security scheme "${name}" (${reason}) is not natively supported; imported as a custom provider (not executable)`, s ?? raw);
    return { auth: { type: 'custom', params: { providerId: name, ...(s && typeof s.type === 'string' ? { schemeType: s.type } : {}) } } };
  };
  if (!s || typeof s.type !== 'string') return custom('invalid');
  switch (s.type) {
    case 'http': {
      const scheme = typeof s.scheme === 'string' ? s.scheme.toLowerCase() : '';
      if (scheme === 'basic') {
        return { auth: { type: 'basic', params: { username: placeholder(ctx, 'username', false, 'HTTP basic user name'), password: placeholder(ctx, 'password', true, 'HTTP basic password') } } };
      }
      if (scheme === 'bearer') return { auth: { type: 'bearer', params: { token: placeholder(ctx, 'bearerToken', true, 'Bearer token') } } };
      return custom(`http ${scheme || 'unknown scheme'}`);
    }
    case 'apiKey': {
      const where = s.in === 'query' ? 'query' : s.in === 'header' ? 'header' : undefined;
      if (!where) return custom(`apiKey in ${toStr(s.in)}`);
      return { auth: { type: 'apikey', params: { key: toStr(s.name), value: placeholder(ctx, 'apiKey', true, `API key sent as ${where} "${toStr(s.name)}"`), in: where } } };
    }
    case 'oauth2': {
      const params = isRecord(s.flows) ? oauth2Params(ctx, s.flows, `${path}.flows`, requestedScopes) : undefined;
      if (!params) return custom('oauth2 without flows');
      return { auth: { type: 'oauth2', params } };
    }
    case 'openIdConnect':
      ctx.w.warn(path, `OpenID Connect discovery (${toStr(s.openIdConnectUrl)}) is not fetched; imported as a bearer token placeholder`, s.openIdConnectUrl);
      return { auth: { type: 'bearer', params: { token: placeholder(ctx, 'bearerToken', true, 'OpenID Connect access token') } } };
    case 'mutualTLS':
      ctx.w.warn(path, `Security scheme "${name}" uses mutual TLS: configure a client certificate in Settings -> Certificates`);
      return { auth: { type: 'none', params: {} } };
    default:
      return custom(s.type);
  }
}

/** First scheme of the first security requirement, or `none` for `[]`. */
function authFromRequirements(ctx: Ctx, security: unknown, path: string, level: 'collection' | 'request'): AuthConfig | undefined {
  if (security === undefined) return undefined;
  if (!Array.isArray(security)) {
    ctx.w.warn(path, 'security is not an array; ignored', security);
    return undefined;
  }
  if (security.length === 0 || security.every((r) => isRecord(r) && Object.keys(r).length === 0)) return { type: 'none', params: {} };
  const first = security.find((r) => isRecord(r) && Object.keys(r).length > 0) as JsonObject | undefined;
  if (!first) return { type: 'none', params: {} };
  const names = Object.keys(first).filter((k) => !UNSAFE_KEYS.has(k));
  const name = names[0]!;
  if (names.length > 1) ctx.w.info(path, `Several security schemes are required together (${names.join(', ')}); "${name}" was imported`);
  if (security.length > 1) ctx.w.info(path, `${security.length} alternative security requirements; the first ("${name}") was imported`);
  const schemes = isRecord(ctx.doc.components) && isRecord(ctx.doc.components.securitySchemes) ? ctx.doc.components.securitySchemes : undefined;
  const raw = schemes && Object.prototype.hasOwnProperty.call(schemes, name) ? schemes[name] : undefined;
  if (raw === undefined) {
    ctx.w.warn(path, `Security scheme "${name}" is not defined in components.securitySchemes; no auth imported`, name);
    return level === 'collection' ? { type: 'none', params: {} } : undefined;
  }
  const requested = Array.isArray(first[name]) ? (first[name] as unknown[]).filter((s): s is string => typeof s === 'string') : [];
  return schemeToAuth(ctx, name, raw, `components.securitySchemes.${name}`, requested).auth;
}

// ---------- servers ----------

function serverUrl(ctx: Ctx, server: JsonObject, path: string): string {
  let url = typeof server.url === 'string' ? server.url : '';
  const vars = isRecord(server.variables) ? server.variables : {};
  url = url.replace(/\{([^{}]+)\}/g, (m, name: string) => {
    const v = vars[name];
    if (isRecord(v)) {
      if (v.default !== undefined) return toStr(v.default);
      if (Array.isArray(v.enum) && v.enum.length > 0) return toStr(v.enum[0]);
    }
    ctx.w.warn(`${path}.url`, `Server variable "${name}" has no default; left as {{${name}}}`, url);
    return `{{${name}}}`;
  });
  return url.replace(/\/+$/, '');
}

function importServers(ctx: Ctx): { baseUrl: string; all: string[] } {
  const servers = Array.isArray(ctx.doc.servers) ? ctx.doc.servers.filter(isRecord) : [];
  const all = servers.map((s, i) => serverUrl(ctx, s, `servers[${i}]`));
  if (all.length === 0) {
    ctx.w.warn('servers', 'No servers are defined; set the collection variable "baseUrl" before sending requests');
    return { baseUrl: '', all };
  }
  if (all.length > 1) ctx.w.info('servers', `${all.length} servers are defined; "${all[0]}" is the baseUrl, the full list is kept in metadata`, all.slice(1));
  const first = all[0]!;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(first) && !first.startsWith('{{')) ctx.w.warn('servers[0].url', 'The server URL is relative; prefix baseUrl with the scheme and host before sending', first);
  return { baseUrl: first, all };
}

// ---------- operations ----------

function pathToUrl(ctx: Ctx, baseUrl: string, pathTemplate: string, at: string): string {
  const converted = pathTemplate
    .split('/')
    .map((seg) => {
      const whole = /^\{([A-Za-z_][\w.-]*)\}$/.exec(seg);
      if (whole) return `:${whole[1]}`;
      if (/\{[^{}]+\}/.test(seg)) {
        ctx.w.warn(at, `Path segment "${seg}" mixes text and a template; it was converted to a {{variable}} and must be set manually`, seg);
        return seg.replace(/\{([^{}]+)\}/g, '{{$1}}');
      }
      return seg;
    })
    .join('/');
  return `${baseUrl}${converted.startsWith('/') ? '' : '/'}${converted}`;
}

function requestBodyFor(ctx: Ctx, raw: unknown, at: string, headers: KeyValueEntry[]): RequestBody {
  if (raw === undefined) return { mode: 'none' };
  const d = deref(ctx, raw, at);
  const rb = d.value;
  if (!rb) return { mode: 'none' };
  const content = isRecord(rb.content) ? rb.content : undefined;
  const mediaType = content ? pickMediaType(content) : undefined;
  if (!content || !mediaType) {
    ctx.w.warn(at, 'requestBody has no content; no body imported', rb);
    return { mode: 'none' };
  }
  const mediaRaw = content[mediaType];
  const media = isRecord(mediaRaw) ? mediaRaw : {};
  const mediaPath = `${at}.content["${mediaType}"]`;
  if (Object.keys(content).length > 1) ctx.w.info(at, `Several request body media types; "${mediaType}" was imported`, Object.keys(content));
  headers.push({ key: 'Content-Type', value: mediaType, enabled: true });

  if (/x-www-form-urlencoded/i.test(mediaType)) {
    const entries = formEntries(ctx, media, mediaPath);
    return { mode: 'urlencoded', urlencoded: entries.map((e) => ({ key: e.key, value: e.value, enabled: e.enabled, ...(e.description ? { description: e.description } : {}) })) };
  }
  if (/multipart\/form-data/i.test(mediaType)) {
    return { mode: 'formdata', formData: formEntries(ctx, media, mediaPath) };
  }
  const example = mediaExample(ctx, media, mediaPath);
  const language = rawLanguageFor(mediaType);
  if (example === undefined || (language !== 'json' && typeof example !== 'string')) {
    if (example !== undefined) ctx.w.warn(mediaPath, `No example could be generated for media type "${mediaType}"; the body is empty`);
    return { mode: 'raw', raw: '', rawLanguage: language };
  }
  return { mode: 'raw', raw: exampleText(example), rawLanguage: language };
}

function formEntries(ctx: Ctx, media: JsonObject, path: string): FormDataEntry[] {
  const d = deref(ctx, media.schema, `${path}.schema`);
  const schema = d.value;
  const out: FormDataEntry[] = [];
  if (!schema || !isRecord(schema.properties)) {
    const ex = mediaExample(ctx, media, path);
    if (isRecord(ex)) for (const [k, v] of Object.entries(ex)) if (!UNSAFE_KEYS.has(k)) out.push({ key: k, type: 'text', value: toStr(v), enabled: true });
    return out;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(toStr) : []);
  const encoding = isRecord(media.encoding) ? media.encoding : {};
  for (const key of Object.keys(schema.properties).slice(0, MAX_PROPERTIES_PER_OBJECT)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const prop = deref(ctx, (schema.properties as JsonObject)[key], `${path}.schema.properties.${key}`).value ?? {};
    const isFile = prop.format === 'binary' || prop.format === 'base64' || typeof prop.contentMediaType === 'string' || (prop.type === 'string' && prop.contentEncoding !== undefined);
    const entry: FormDataEntry = { key, type: isFile ? 'file' : 'text', value: '', enabled: required.has(key) || required.size === 0 };
    if (!isFile) {
      const v = exampleFromSchema(ctx, prop, `${path}.schema.properties.${key}`, d.stack, 0, { nodes: 0 });
      entry.value = v === undefined ? '' : typeof v === 'string' ? v : exampleText(v);
    }
    if (typeof prop.description === 'string' && prop.description) entry.description = prop.description;
    const enc = encoding[key];
    if (isRecord(enc) && typeof enc.contentType === 'string') entry.contentType = enc.contentType;
    out.push(entry);
  }
  return out;
}

function examplesFor(ctx: Ctx, responses: unknown, at: string): RequestExample[] {
  if (!isRecord(responses)) return [];
  const out: RequestExample[] = [];
  const codes = Object.keys(responses).filter((k) => !UNSAFE_KEYS.has(k));
  if (codes.length > MAX_EXAMPLES_PER_REQUEST) ctx.w.info(at, `Only the first ${MAX_EXAMPLES_PER_REQUEST} responses are imported as examples`, codes.length);
  for (const code of codes.slice(0, MAX_EXAMPLES_PER_REQUEST)) {
    const rp = `${at}.${code}`;
    const d = deref(ctx, responses[code], rp);
    const res = d.value;
    if (!res) continue;
    const numeric = /^\d{3}$/.test(code) ? Number(code) : /^\dXX$/i.test(code) ? Number(code[0]) * 100 : 200;
    const description = typeof res.description === 'string' ? res.description : '';
    const headers: KeyValueEntry[] = [];
    if (isRecord(res.headers)) {
      for (const name of Object.keys(res.headers)) {
        if (UNSAFE_KEYS.has(name)) continue;
        const h = deref(ctx, (res.headers as JsonObject)[name], `${rp}.headers.${name}`).value;
        const entry: KeyValueEntry = { key: name, value: h ? paramValue(ctx, h, `${rp}.headers.${name}`) : '', enabled: true };
        if (h && typeof h.description === 'string' && h.description) entry.description = h.description;
        headers.push(entry);
      }
    }
    let body = '';
    let language: string | undefined;
    const content = isRecord(res.content) ? res.content : undefined;
    const mediaType = content ? pickMediaType(content) : undefined;
    if (content && mediaType) {
      const media = isRecord(content[mediaType]) ? (content[mediaType] as JsonObject) : {};
      const ex = mediaExample(ctx, media, `${rp}.content["${mediaType}"]`);
      body = ex === undefined ? '' : exampleText(ex);
      language = rawLanguageFor(mediaType);
      headers.unshift({ key: 'Content-Type', value: mediaType, enabled: true });
    }
    const example: RequestExample = {
      name: description ? `${code} ${description}` : code,
      status: REASONS[numeric] ?? (code === 'default' ? 'Default' : ''),
      code: numeric,
      headers,
      body,
      ...(language ? { language } : {}),
    };
    if (res.links !== undefined) example.metadata = { links: cloneAt(ctx.w, res.links, `${rp}.links`) };
    out.push(example);
  }
  return out;
}

interface OpInput {
  pathTemplate: string;
  method: string;
  op: JsonObject;
  pathItem: JsonObject;
  baseUrl: string;
  collectionSecurity: unknown;
  at: string;
}

function convertOperation(ctx: Ctx, input: OpInput): RequestDraft {
  const { op, at } = input;
  const method = input.method.toUpperCase();
  const name = typeof op.summary === 'string' && op.summary.trim() ? op.summary.trim() : typeof op.operationId === 'string' && op.operationId ? op.operationId : `${method} ${input.pathTemplate}`;

  const params = new Map<string, Param>();
  collectParams(ctx, input.pathItem.parameters, `${at.replace(/\.[a-z]+$/, '')}.parameters`, params);
  collectParams(ctx, op.parameters, `${at}.parameters`, params);

  const headers: KeyValueEntry[] = [];
  const queryParams: KeyValueEntry[] = [];
  const pathVariables: KeyValueEntry[] = [];
  for (const p of params.values()) {
    const entry: KeyValueEntry = { key: p.name, value: p.value, enabled: p.required, ...(p.description ? { description: p.description } : {}) };
    if (p.in === 'path') pathVariables.push({ ...entry, enabled: true });
    else if (p.in === 'query') queryParams.push(entry);
    else if (p.in === 'header') headers.push(entry);
    else ctx.w.warn(`${at}.parameters`, `Parameter "${p.name}" in "${p.in}" is not supported (only path, query and header); skipped`, p.in);
  }

  let baseUrl = input.baseUrl;
  if (Array.isArray(op.servers) && op.servers.length > 0 && isRecord(op.servers[0])) {
    baseUrl = serverUrl(ctx, op.servers[0], `${at}.servers[0]`);
    ctx.w.info(`${at}.servers`, `Operation-level server "${baseUrl}" is used instead of {{baseUrl}}`);
  } else if (Array.isArray(input.pathItem.servers) && input.pathItem.servers.length > 0 && isRecord(input.pathItem.servers[0])) {
    baseUrl = serverUrl(ctx, input.pathItem.servers[0], `${at}.servers[0]`);
    ctx.w.info(`${at}.servers`, `Path-level server "${baseUrl}" is used instead of {{baseUrl}}`);
  }

  const body = requestBodyFor(ctx, op.requestBody, `${at}.requestBody`, headers);
  const examples = examplesFor(ctx, op.responses, `${at}.responses`);
  const accept = examples.find((e) => e.headers[0]?.key === 'Content-Type')?.headers[0]?.value;
  if (accept) headers.push({ key: 'Accept', value: accept, enabled: true });

  let auth: AuthConfig = { type: 'inherit', params: {} };
  if (op.security !== undefined) {
    const own = authFromRequirements(ctx, op.security, `${at}.security`, 'request');
    if (own && JSON.stringify(own) !== JSON.stringify(authFromRequirementsQuiet(ctx, input.collectionSecurity))) auth = own;
  }
  if (op.callbacks !== undefined) ctx.w.warn(`${at}.callbacks`, 'Callbacks are not supported; skipped');

  const descriptionParts: string[] = [];
  if (typeof op.description === 'string' && op.description.trim()) descriptionParts.push(op.description.trim());
  if (op.deprecated === true) {
    descriptionParts.push('DEPRECATED operation.');
    ctx.w.info(at, 'Operation is marked deprecated');
  }
  const openapiMeta: JsonObject = { path: input.pathTemplate, method };
  if (typeof op.operationId === 'string') openapiMeta.operationId = op.operationId;
  if (Array.isArray(op.tags)) openapiMeta.tags = op.tags.map(toStr);
  if (op.deprecated === true) openapiMeta.deprecated = true;
  const extensions = extensionsOf(ctx, op, at);
  if (extensions) openapiMeta.extensions = extensions;

  const draft: RequestDraft = {
    name,
    description: descriptionParts.join('\n\n'),
    method,
    url: pathToUrl(ctx, baseUrl, input.pathTemplate, at),
    headers,
    queryParams,
    pathVariables,
    body,
    auth,
    scripts: [],
    examples,
    settings: {},
    metadata: { openapi: openapiMeta },
  };
  ctx.stats.requests += 1;
  ctx.stats.examples += examples.length;
  ctx.doneOps += 1;
  if (ctx.doneOps % 50 === 0) ctx.onProgress?.({ stage: 'Importing', current: ctx.doneOps, total: ctx.totalOps });
  return draft;
}

/** Same as authFromRequirements but without emitting warnings (used for comparison only). */
function authFromRequirementsQuiet(ctx: Ctx, security: unknown): AuthConfig | undefined {
  const quiet: Ctx = { ...ctx, w: new WarningCollector(), variables: new Map(ctx.variables) };
  return authFromRequirements(quiet, security, '', 'collection');
}

function extensionsOf(ctx: Ctx, obj: JsonObject, at: string): JsonObject | undefined {
  const out: JsonObject = {};
  for (const key of Object.keys(obj)) if (key.startsWith('x-') && !UNSAFE_KEYS.has(key)) out[key] = cloneAt(ctx.w, obj[key], `${at}.${key}`);
  return Object.keys(out).length ? out : undefined;
}

// ---------- document ----------

function countOperations(paths: JsonObject, maxItems: number): number {
  let n = 0;
  for (const key of Object.keys(paths)) {
    const item = paths[key];
    if (!isRecord(item)) continue;
    for (const m of Object.keys(item)) if (HTTP_METHODS.has(m.toLowerCase()) && isRecord(item[m])) n++;
    if (n > maxItems) throw new AppError('IMPORT_TOO_LARGE', `The document contains more than ${maxItems} operations.`, { maxItems });
  }
  return n;
}

function validate(doc: unknown, w: WarningCollector): { doc: JsonObject; version: string } {
  if (!isRecord(doc)) failImport(w, '', 'This is not an OpenAPI document: the top-level value must be an object.');
  if (doc.swagger !== undefined) failImport(w, 'swagger', 'This is a Swagger 2.0 document; use the Swagger importer.');
  if (typeof doc.openapi !== 'string') failImport(w, 'openapi', 'This is not an OpenAPI document: the "openapi" version field is missing.');
  if (!/^3\.[01](\.\d+)?/.test(doc.openapi)) failImport(w, 'openapi', `Unsupported OpenAPI version "${doc.openapi}". Only OpenAPI 3.0 and 3.1 can be imported.`);
  if (!isRecord(doc.paths) && !isRecord(doc.webhooks)) failImport(w, 'paths', 'This is not an OpenAPI document: the "paths" object is missing.');
  return { doc, version: doc.openapi };
}

function convertDocument(ctx: Ctx, version: string, format: 'openapi' | 'swagger'): CollectionBundle {
  const { doc, w } = ctx;
  const info = isRecord(doc.info) ? doc.info : {};
  if (!isRecord(doc.info)) w.warn('info', 'The "info" object is missing; using "Imported API" as the collection name');
  const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim() : 'Imported API';
  const descriptionParts: string[] = [];
  if (typeof info.description === 'string' && info.description.trim()) descriptionParts.push(info.description.trim());
  if (info.version !== undefined) descriptionParts.push(`API version: ${toStr(info.version)}`);

  const servers = importServers(ctx);
  ctx.variables.set('baseUrl', { key: 'baseUrl', initialValue: servers.baseUrl, isSecret: false, enabled: true, description: 'Server URL (from the OpenAPI servers list)' });

  const auth = authFromRequirements(ctx, doc.security, 'security', 'collection') ?? { type: 'none', params: {} };
  if (doc.security === undefined && isRecord(doc.components) && isRecord(doc.components.securitySchemes) && Object.keys(doc.components.securitySchemes).length > 0) {
    w.info('components.securitySchemes', 'The document defines security schemes but no global "security" requirement; operations that declare one get request-level auth');
  }
  if (doc.webhooks !== undefined) w.warn('webhooks', 'Webhooks are not supported; skipped');

  // folders by tag
  const tagInfo = new Map<string, { description: string; node: FolderNode }>();
  const tagOrder: string[] = [];
  if (Array.isArray(doc.tags)) {
    for (const t of doc.tags) if (isRecord(t) && typeof t.name === 'string' && !tagInfo.has(t.name)) {
      tagInfo.set(t.name, { description: typeof t.description === 'string' ? t.description : '', node: emptyFolder(t.name, typeof t.description === 'string' ? t.description : '') });
      tagOrder.push(t.name);
    }
  }
  const root: ItemNode[] = [];
  const folderFor = (tag: string): FolderNode => {
    let f = tagInfo.get(tag);
    if (!f) {
      f = { description: '', node: emptyFolder(tag, '') };
      tagInfo.set(tag, f);
      tagOrder.push(tag);
    }
    return f.node;
  };

  const paths = isRecord(doc.paths) ? doc.paths : {};
  for (const pathTemplate of Object.keys(paths)) {
    if (UNSAFE_KEYS.has(pathTemplate)) continue;
    const at = `paths["${pathTemplate}"]`;
    const d = deref(ctx, paths[pathTemplate], at);
    const pathItem = d.value;
    if (!pathItem) {
      if (paths[pathTemplate] !== undefined && !(isRecord(paths[pathTemplate]) && typeof (paths[pathTemplate] as JsonObject).$ref === 'string')) w.warn(at, 'Path item is not an object; skipped', paths[pathTemplate]);
      continue;
    }
    for (const key of Object.keys(pathItem)) {
      const method = key.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;
      const op = pathItem[key];
      if (!isRecord(op)) {
        w.warn(`${at}.${key}`, 'Operation is not an object; skipped', op);
        continue;
      }
      const draft = convertOperation(ctx, { pathTemplate, method, op, pathItem, baseUrl: servers.baseUrl ? '{{baseUrl}}' : '', collectionSecurity: doc.security, at: `${at}.${key}` });
      const node: ItemNode = { kind: 'request', request: draft };
      const tag = Array.isArray(op.tags) && typeof op.tags[0] === 'string' ? op.tags[0] : undefined;
      if (tag !== undefined) folderFor(tag).items.push(node);
      else root.push(node);
    }
  }

  const items: ItemNode[] = [];
  for (const tag of tagOrder) {
    const node = tagInfo.get(tag)!.node;
    if (node.items.length === 0) continue; // tags declared but unused
    items.push(node);
    ctx.stats.folders += 1;
  }
  items.push(...root);

  const variables = [...ctx.variables.values()];
  ctx.stats.variables += variables.length;
  const sourceMetadata: JsonObject = {
    openapi: {
      source: format,
      version,
      title,
      ...(info.version !== undefined ? { apiVersion: toStr(info.version) } : {}),
      ...(servers.all.length > 1 ? { servers: servers.all } : {}),
      ...(doc.externalDocs !== undefined ? { externalDocs: cloneAt(w, doc.externalDocs, 'externalDocs') } : {}),
    },
  };
  const extensions = extensionsOf(ctx, doc, '');
  if (extensions) (sourceMetadata.openapi as JsonObject).extensions = extensions;

  return { name: title, description: descriptionParts.join('\n\n'), variables, auth, scripts: [], sourceMetadata, items };
}

function emptyFolder(name: string, description: string): FolderNode {
  return { kind: 'folder', name, description, auth: { type: 'inherit', params: {} }, scripts: [], variables: [], metadata: {}, items: [] };
}

/** Internal entry shared with the Swagger 2.0 front-end (which converts to this shape first). */
export function convertOpenApiObject(doc: JsonObject, version: string, format: 'openapi' | 'swagger', w: WarningCollector, options: ParseOpenApiOptions): ParseOpenApiResult {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const emit = (stage: ImportProgress['stage'], current: number, total: number) => options.onProgress?.({ stage, current, total });
  emit('Validating', 0, 1);
  const totalOps = countOperations(isRecord(doc.paths) ? doc.paths : {}, maxItems);
  emit('Validating', 1, 1);
  const stats: ImportStats = { folders: 0, requests: 0, variables: 0, scripts: 0, examples: 0 };
  const ctx: Ctx = {
    w,
    doc,
    stats,
    variables: new Map(),
    maxExampleDepth: options.maxExampleDepth ?? DEFAULT_MAX_EXAMPLE_DEPTH,
    maxExampleNodes: options.maxExampleNodes ?? DEFAULT_MAX_EXAMPLE_NODES,
    reportedRefs: new Set(),
    depthWarned: false,
    budgetWarned: false,
    totalOps,
    doneOps: 0,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
  emit('Importing', 0, totalOps);
  const bundle = convertDocument(ctx, version, format);
  emit('Importing', ctx.doneOps, totalOps);
  emit('Finalizing', 0, 1);
  const warnings = w.toArray();
  emit('Finalizing', 1, 1);
  return { bundle, warnings, stats, format, version };
}

/**
 * Convert an OpenAPI 3.0/3.1 document (JSON or YAML text, or a parsed object)
 * into a {@link CollectionBundle}. Throws `AppError` (`IMPORT_INVALID`, `IMPORT_TOO_LARGE`).
 */
export function parseOpenApiDocument(input: string | object, options: ParseOpenApiOptions = {}): ParseOpenApiResult {
  const w = new WarningCollector();
  try {
    options.onProgress?.({ stage: 'Parsing', current: 0, total: 1 });
    const raw = typeof input === 'string' ? parseImportText(input, options.fileName, options.maxBytes ?? DEFAULT_MAX_BYTES, w) : input;
    options.onProgress?.({ stage: 'Parsing', current: 1, total: 1 });
    const { doc, version } = validate(raw, w);
    if (/^3\.1/.test(version)) w.info('openapi', 'OpenAPI 3.1 document: JSON Schema 2020-12 keywords beyond the supported subset are ignored when generating examples');
    return convertOpenApiObject(doc, version, 'openapi', w, options);
  } catch (e) {
    if (e instanceof RangeError) throw new AppError('IMPORT_INVALID', 'The document is nested too deeply to import.', {}, { cause: e });
    throw e;
  }
}
