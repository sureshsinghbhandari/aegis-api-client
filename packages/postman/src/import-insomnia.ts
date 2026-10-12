/**
 * Insomnia v4 export (`{ _type: 'export', __export_format: 4, resources: [] }`)
 * -> one CollectionBundle per workspace plus one EnvironmentBundle per
 * sub-environment. request_group -> folder, request -> request, the base
 * environment -> collection variables. `{{ _.name }}` templates become
 * `{{name}}`; Nunjucks tags are kept verbatim with a warning.
 */
import type {
  AuthConfig,
  AuthParamValue,
  AuthType,
  CollectionBundle,
  EnvironmentBundle,
  FolderNode,
  FormDataEntry,
  ImportStats,
  ImportWarningModel,
  ItemNode,
  KeyValueEntry,
  RequestBody,
  RequestDraft,
  RequestSettings,
  ScriptEntry,
  VariableEntry,
} from '@aegis/core';
import {
  PROGRESS_EVERY,
  assertDepth,
  assertItemCount,
  baseMimeType,
  clampName,
  convertNamedRows,
  countScripts,
  emitProgress,
  flattenVariables,
  guardImport,
  newDraft,
  newStats,
  rawLanguageFromMime,
  resolveLimits,
  safeFilePath,
  splitRequestUrl,
  stripUrlCredentials,
  variableEntry,
} from './import-common';
import type { ImportLimitOptions, ResolvedLimits } from './import-common';
import type { JsonObject } from './shared';
import { META, failImport, graphqlToRaw, isRecord, parseJsonInput, toStr } from './shared';
import { WarningCollector } from './warnings';

export interface ParseInsomniaResult {
  /** One collection per Insomnia workspace (orphaned resources join the first one). */
  collections: CollectionBundle[];
  /** Insomnia sub-environments; the base environment becomes collection variables. */
  environments: EnvironmentBundle[];
  warnings: ImportWarningModel[];
  stats: ImportStats;
  format: 'insomnia-v4';
}

interface Resource {
  id: string;
  type: string;
  parentId: string | null;
  raw: JsonObject;
  index: number;
  path: string;
}

interface Ctx {
  w: WarningCollector;
  stats: ImportStats;
  limits: ResolvedLimits;
  byId: Map<string, Resource>;
  children: Map<string | null, Resource[]>;
  visited: Set<string>;
  total: number;
  done: number;
}

const UNSUPPORTED_TYPES: Record<string, string> = {
  api_spec: 'Embedded OpenAPI document not imported; import the specification file with the OpenAPI importer instead',
  unit_test_suite: 'Insomnia unit test suite not imported',
  unit_test: 'Insomnia unit test not imported',
  websocket_request: 'WebSocket requests are not supported; skipped',
  websocket_payload: 'WebSocket payload not imported',
  grpc_request: 'gRPC requests are not supported; skipped',
  proto_file: 'Protobuf file not imported',
  proto_directory: 'Protobuf directory not imported',
  mock_server: 'Mock server not imported',
  mock_route: 'Mock route not imported',
  ca_certificate: 'CA certificate not imported; add it under Settings -> Certificates',
  client_certificate: 'Client certificate not imported; add it under Settings -> Certificates',
  request_meta: 'Request metadata not imported',
};

// ---------- templates ----------

const INSOMNIA_VAR = /\{\{\s*(?:_\.)?([A-Za-z_][\w.-]*)\s*\}\}/g;

/** `{{ _.base_url }}` / `{{ base_url }}` -> `{{base_url}}`; tags and filters are reported and kept. */
export function convertInsomniaTemplate(w: WarningCollector, text: string, path: string): string {
  if (!text.includes('{{') && !text.includes('{%')) return text;
  const out = text.replace(INSOMNIA_VAR, '{{$1}}');
  if (out.includes('{%')) w.warn(path, 'Insomnia template tag ({% ... %}) is not supported; kept verbatim and not resolved');
  else if (/\{\{[^}]*\|/.test(out)) w.warn(path, 'Insomnia template filter ({{ x | filter }}) is not supported; kept verbatim and not resolved');
  return out;
}

function templateRows(ctx: Ctx, rows: KeyValueEntry[], path: string): KeyValueEntry[] {
  return rows.map((r, i) => ({ ...r, key: convertInsomniaTemplate(ctx.w, r.key, `${path}[${i}].name`), value: convertInsomniaTemplate(ctx.w, r.value, `${path}[${i}].value`) }));
}

// ---------- variables ----------

function convertEnvironmentData(ctx: Ctx, data: unknown, path: string): VariableEntry[] {
  if (data === undefined || data === null) return [];
  if (!isRecord(data)) {
    ctx.w.warn(path, 'Environment data is not an object; ignored', data);
    return [];
  }
  return flattenVariables(ctx.w, data, path).map((v) => variableEntry(v.key, convertInsomniaTemplate(ctx.w, v.value, `${path}.${v.key}`)));
}

// ---------- auth ----------

interface AuthMapping {
  type: AuthType;
  providerId?: string;
  fields: Record<string, string>;
}

const AUTH_MAP: Record<string, AuthMapping> = {
  basic: { type: 'basic', fields: { username: 'username', password: 'password' } },
  bearer: { type: 'bearer', fields: { token: 'token' } },
  apikey: { type: 'apikey', fields: { key: 'key', value: 'value' } },
  oauth2: {
    type: 'oauth2',
    fields: {
      authorizationUrl: 'authUrl',
      accessTokenUrl: 'accessTokenUrl',
      clientId: 'clientId',
      clientSecret: 'clientSecret',
      scope: 'scope',
      redirectUrl: 'redirect_uri',
      audience: 'audience',
      resource: 'resource',
      state: 'state',
      username: 'username',
      password: 'password',
      tokenPrefix: 'headerPrefix',
      accessToken: 'accessToken',
      refreshToken: 'refreshToken',
    },
  },
  oauth1: {
    type: 'oauth1',
    fields: {
      consumerKey: 'consumerKey',
      consumerSecret: 'consumerSecret',
      tokenKey: 'token',
      tokenSecret: 'tokenSecret',
      signatureMethod: 'signatureMethod',
      realm: 'realm',
      version: 'version',
      nonce: 'nonce',
      timestamp: 'timestamp',
      callback: 'callback',
      verifier: 'verifier',
      privateKey: 'privateKey',
    },
  },
  iam: { type: 'awsv4', fields: { accessKeyId: 'accessKey', secretAccessKey: 'secretKey', sessionToken: 'sessionToken', region: 'region', service: 'service' } },
  digest: { type: 'custom', providerId: 'digest', fields: { username: 'username', password: 'password' } },
  hawk: { type: 'custom', providerId: 'hawk', fields: { id: 'authId', key: 'authKey', algorithm: 'algorithm', ext: 'extraData' } },
  asap: { type: 'custom', providerId: 'asap', fields: { issuer: 'iss', subject: 'sub', audience: 'aud', keyId: 'kid', privateKey: 'privateKey', additionalClaims: 'claims' } },
  ntlm: { type: 'custom', providerId: 'ntlm', fields: { username: 'username', password: 'password' } },
};

const OAUTH2_GRANTS: Record<string, string> = {
  authorization_code: 'authorization_code',
  client_credentials: 'client_credentials',
  password: 'password_credentials',
  implicit: 'implicit',
};

function scalar(ctx: Ctx, value: unknown, path: string): AuthParamValue | undefined {
  if (typeof value === 'string') return convertInsomniaTemplate(ctx.w, value, path);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function convertAuth(ctx: Ctx, raw: unknown, path: string, level: 'folder' | 'request'): AuthConfig {
  const inherit: AuthConfig = { type: 'inherit', params: {} };
  if (raw === undefined || raw === null) return inherit;
  if (!isRecord(raw)) {
    ctx.w.warn(path, 'Authentication is not an object; ignored', raw);
    return inherit;
  }
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (type === '' || Object.keys(raw).length === 0) return inherit;
  if (raw.disabled === true) {
    ctx.w.warn(path, `Disabled ${type} authentication was not imported; the ${level} inherits authentication`);
    return inherit;
  }
  if (type === 'none') return { type: 'none', params: {} };
  if (type === 'netrc') {
    ctx.w.warn(path, 'netrc authentication is not supported; imported as "no auth"');
    return { type: 'none', params: {} };
  }
  const mapping = AUTH_MAP[type];
  const params: Record<string, AuthParamValue> = {};
  if (!mapping) {
    // Postman has no equivalent, so a custom provider could not be exported as a valid collection; drop it loudly.
    ctx.w.warn(path, `Auth type "${type}" is not supported; imported as "no auth" (its parameters were not imported)`, { type });
    return { type: 'none', params: {} };
  }
  if (mapping.providerId) {
    params.providerId = mapping.providerId;
    if (mapping.providerId === 'ntlm') ctx.w.warn(path, 'NTLM authentication is preserved but cannot be executed by this version');
  }
  for (const [source, target] of Object.entries(mapping.fields)) {
    const s = scalar(ctx, raw[source], `${path}.${source}`);
    if (s !== undefined) params[target] = s;
  }
  if (type === 'apikey') params.in = raw.addTo === 'queryParams' ? 'query' : 'header';
  if (type === 'bearer' && typeof raw.prefix === 'string' && raw.prefix !== '' && raw.prefix.toLowerCase() !== 'bearer') {
    ctx.w.warn(`${path}.prefix`, `Bearer prefix "${raw.prefix}" is not supported; "Bearer" is used`, raw.prefix);
  }
  if (type === 'oauth2') {
    const grant = typeof raw.grantType === 'string' ? raw.grantType : 'authorization_code';
    const mapped = OAUTH2_GRANTS[grant];
    if (!mapped) ctx.w.warn(`${path}.grantType`, `OAuth 2.0 grant type "${grant}" is not supported; authorization code is used`, grant);
    params.grant_type = mapped === 'authorization_code' && raw.usePkce === true ? 'authorization_code_with_pkce' : (mapped ?? 'authorization_code');
    if (raw.credentialsInBody !== undefined) params.client_authentication = raw.credentialsInBody === true ? 'body' : 'header';
  }
  return { type: mapping.type, params };
}

// ---------- scripts ----------

function convertScripts(ctx: Ctx, raw: JsonObject, path: string): ScriptEntry[] {
  const out: ScriptEntry[] = [];
  const add = (field: string, type: 'prerequest' | 'test'): void => {
    const source = raw[field];
    if (typeof source !== 'string' || source.trim() === '') return;
    ctx.w.warn(`${path}.${field}`, 'Insomnia script imported unchanged; calls to the insomnia.* API may need to be changed to pm.*');
    out.push({ type, language: 'javascript', source, enabled: true });
  };
  add('preRequestScript', 'prerequest');
  add('afterResponseScript', 'test');
  return out;
}

// ---------- body ----------

function convertFormData(ctx: Ctx, params: unknown, path: string): FormDataEntry[] {
  if (!Array.isArray(params)) return [];
  const out: FormDataEntry[] = [];
  params.forEach((p: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(p)) {
      ctx.w.warn(at, 'Form parameter is not an object; skipped', p);
      return;
    }
    const isFile = p.type === 'file';
    const entry: FormDataEntry = {
      key: convertInsomniaTemplate(ctx.w, toStr(p.name), `${at}.name`),
      type: isFile ? 'file' : 'text',
      value: isFile ? '' : convertInsomniaTemplate(ctx.w, toStr(p.value), `${at}.value`),
      enabled: p.disabled !== true,
    };
    if (isFile) {
      const filePath = safeFilePath(ctx.w, p.fileName, `${at}.fileName`);
      if (filePath !== undefined) entry.filePath = filePath;
    }
    if (typeof p.description === 'string' && p.description !== '') entry.description = p.description;
    out.push(entry);
  });
  return out;
}

function hasHeader(headers: readonly KeyValueEntry[], name: string): boolean {
  return headers.some((h) => h.key.toLowerCase() === name);
}

function convertGraphql(ctx: Ctx, text: string, path: string, meta: JsonObject): RequestBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    ctx.w.warn(`${path}.text`, 'GraphQL body is not valid JSON; imported as raw text');
    return { mode: 'raw', raw: text };
  }
  const src = isRecord(parsed) ? parsed : {};
  const graphql: JsonObject = { query: convertInsomniaTemplate(ctx.w, toStr(src.query), `${path}.text.query`) };
  const variables = src.variables;
  graphql.variables = typeof variables === 'string' ? variables : variables === undefined || variables === null ? '' : JSON.stringify(variables);
  if (typeof src.operationName === 'string' && src.operationName !== '') graphql.operationName = src.operationName;
  ctx.w.info(`${path}.text`, 'GraphQL body imported as a raw JSON body ({query, variables}); the original is preserved for export');
  meta[META.originalBodyMode] = 'graphql';
  meta[META.graphqlBody] = graphql;
  return { mode: 'raw', raw: graphqlToRaw(graphql), rawLanguage: 'json' };
}

function convertBody(ctx: Ctx, raw: unknown, path: string, meta: JsonObject, headers: KeyValueEntry[]): RequestBody {
  if (raw === undefined || raw === null) return { mode: 'none' };
  if (!isRecord(raw)) {
    ctx.w.warn(path, 'Body is not an object; ignored', raw);
    return { mode: 'none' };
  }
  if (Object.keys(raw).length === 0) return { mode: 'none' };
  const mime = baseMimeType(raw.mimeType);
  const text = typeof raw.text === 'string' ? raw.text : undefined;
  const ensureContentType = (value: string): void => {
    if (!hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value, enabled: true });
  };

  if (mime === 'application/x-www-form-urlencoded') return { mode: 'urlencoded', urlencoded: templateRows(ctx, convertNamedRows(ctx.w, raw.params, `${path}.params`), `${path}.params`) };
  if (mime === 'multipart/form-data') return { mode: 'formdata', formData: convertFormData(ctx, raw.params, `${path}.params`) };
  if (mime === 'application/graphql') {
    ensureContentType('application/json');
    return convertGraphql(ctx, text ?? '', path, meta);
  }
  if (typeof raw.fileName === 'string' && raw.fileName !== '' && text === undefined) {
    const filePath = safeFilePath(ctx.w, raw.fileName, `${path}.fileName`);
    if (mime !== '') ensureContentType(toStr(raw.mimeType));
    return filePath === undefined ? { mode: 'binary' } : { mode: 'binary', filePath };
  }
  if (text === undefined || (text === '' && mime === '')) return { mode: 'none' };
  const body: RequestBody = { mode: 'raw', raw: convertInsomniaTemplate(ctx.w, text, `${path}.text`) };
  const language = rawLanguageFromMime(mime);
  if (language) body.rawLanguage = language;
  if (mime !== '') ensureContentType(toStr(raw.mimeType));
  return body;
}

// ---------- settings ----------

function convertSettings(ctx: Ctx, raw: JsonObject, path: string): RequestSettings {
  const settings: RequestSettings = {};
  if (raw.settingFollowRedirects === 'on') settings.followRedirects = true;
  else if (raw.settingFollowRedirects === 'off') settings.followRedirects = false;
  const unmapped: string[] = [];
  if (raw.settingSendCookies === false) unmapped.push('settingSendCookies');
  if (raw.settingStoreCookies === false) unmapped.push('settingStoreCookies');
  if (raw.settingEncodeUrl === false) unmapped.push('settingEncodeUrl');
  if (raw.settingRebuildPath === false) unmapped.push('settingRebuildPath');
  if (raw.settingDisableRenderMacro === true) unmapped.push('settingDisableRenderMacro');
  for (const key of unmapped) ctx.w.info(`${path}.${key}`, `Request setting "${key}" is not mapped; the default behaviour applies`, raw[key]);
  return settings;
}

// ---------- requests and folders ----------

function convertRequest(ctx: Ctx, res: Resource): RequestDraft {
  const { raw, path } = res;
  const { w } = ctx;
  const meta: JsonObject = {};
  const method = typeof raw.method === 'string' && raw.method.trim() !== '' ? raw.method.trim().toUpperCase() : 'GET';
  const urlText = stripUrlCredentials(w, convertInsomniaTemplate(w, toStr(raw.url), `${path}.url`), `${path}.url`);
  const split = splitRequestUrl(urlText);
  if (split.hash) meta[META.urlHash] = split.hash;
  const queryParams = [...split.queryParams, ...templateRows(ctx, convertNamedRows(w, raw.parameters, `${path}.parameters`), `${path}.parameters`)];
  const headers = templateRows(ctx, convertNamedRows(w, raw.headers, `${path}.headers`), `${path}.headers`);
  const body = convertBody(ctx, raw.body, `${path}.body`, meta, headers);
  const scripts = convertScripts(ctx, raw, path);
  const draft = newDraft({
    name: clampName(toStr(raw.name), 'Untitled Request'),
    method,
    url: split.url,
    description: typeof raw.description === 'string' ? raw.description : '',
    headers,
    queryParams,
    body,
    auth: convertAuth(ctx, raw.authentication, `${path}.authentication`, 'request'),
    scripts,
    settings: convertSettings(ctx, raw, path),
    metadata: meta,
  });
  if (typeof raw.name !== 'string' || raw.name.trim() === '') w.info(`${path}.name`, 'Request has no name; using "Untitled Request"');
  ctx.stats.requests += 1;
  ctx.stats.scripts += countScripts(scripts);
  ctx.done += 1;
  if (ctx.done % PROGRESS_EVERY === 0) emitProgress(ctx.limits, 'Importing', ctx.done, ctx.total);
  return draft;
}

function convertFolder(ctx: Ctx, res: Resource): FolderNode {
  const { raw, path } = res;
  const variables = convertEnvironmentData(ctx, raw.environment, `${path}.environment`);
  const scripts = convertScripts(ctx, raw, path);
  ctx.stats.folders += 1;
  ctx.stats.variables += variables.length;
  ctx.stats.scripts += countScripts(scripts);
  return {
    kind: 'folder',
    name: clampName(toStr(raw.name), 'Untitled folder'),
    description: typeof raw.description === 'string' ? raw.description : '',
    auth: convertAuth(ctx, raw.authentication, `${path}.authentication`, 'folder'),
    scripts,
    variables,
    metadata: {},
    items: [],
  };
}

function sortKey(res: Resource): number {
  const k = res.raw.metaSortKey;
  return typeof k === 'number' && Number.isFinite(k) ? k : 0;
}

function sortedChildren(ctx: Ctx, parentId: string | null): Resource[] {
  const list = (ctx.children.get(parentId) ?? []).filter((r) => r.type === 'request' || r.type === 'request_group');
  return [...list].sort((a, b) => sortKey(a) - sortKey(b) || a.index - b.index);
}

/** Iterative DFS from `roots` into `target`, honouring the depth limit and skipping already placed resources. */
function placeTree(ctx: Ctx, roots: Resource[], target: ItemNode[], depth: number): void {
  const stack: Array<{ res: Resource; depth: number; into: ItemNode[] }> = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ res: roots[i]!, depth, into: target });
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    const { res } = frame;
    if (ctx.visited.has(res.id)) continue;
    ctx.visited.add(res.id);
    if (res.type === 'request') {
      frame.into.push({ kind: 'request', request: convertRequest(ctx, res) });
      continue;
    }
    assertDepth(frame.depth, ctx.limits, ctx.w, res.path);
    const folder = convertFolder(ctx, res);
    frame.into.push(folder);
    const kids = sortedChildren(ctx, res.id);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ res: kids[i]!, depth: frame.depth + 1, into: folder.items });
  }
}

// ---------- workspaces and environments ----------

function newBundle(name: string, description: string): CollectionBundle {
  return { name, description, postmanSchemaVersion: '2.1.0', variables: [], auth: { type: 'none', params: {} }, scripts: [], sourceMetadata: {}, items: [] };
}

function convertWorkspace(ctx: Ctx, ws: Resource): CollectionBundle {
  const bundle = newBundle(clampName(toStr(ws.raw.name), 'Insomnia import'), typeof ws.raw.description === 'string' ? ws.raw.description : '');
  if (ws.raw.scope === 'design') ctx.w.info(`${ws.path}.scope`, 'Design document workspace: only its requests are imported (the OpenAPI document is not)');
  placeTree(ctx, sortedChildren(ctx, ws.id), bundle.items, 1);
  return bundle;
}

function convertEnvironment(ctx: Ctx, env: Resource): EnvironmentBundle {
  const variables = convertEnvironmentData(ctx, env.raw.data, `${env.path}.data`);
  ctx.stats.variables += variables.length;
  const bundle: EnvironmentBundle = { name: clampName(toStr(env.raw.name), 'Imported environment'), variables, sourceMetadata: {} };
  if (env.raw.isPrivate === true) ctx.w.info(`${env.path}.isPrivate`, 'Private environment imported; values that look like credentials are stored as secrets');
  return bundle;
}

// ---------- document ----------

function indexResources(ctx: Ctx, resources: unknown[]): Resource[] {
  const out: Resource[] = [];
  resources.forEach((raw, index) => {
    const path = `resources[${index}]`;
    if (!isRecord(raw)) {
      ctx.w.warn(path, 'Resource is not an object; skipped', raw);
      return;
    }
    const type = typeof raw._type === 'string' ? raw._type : '';
    const id = typeof raw._id === 'string' && raw._id !== '' ? raw._id : `__anon_${index}`;
    if (typeof raw._id !== 'string' || raw._id === '') ctx.w.warn(`${path}._id`, 'Resource has no _id; a generated one is used', raw._id);
    if (ctx.byId.has(id)) {
      ctx.w.warn(`${path}._id`, `Duplicate resource id "${id}"; this resource is skipped`, id);
      return;
    }
    const parentId = typeof raw.parentId === 'string' && raw.parentId !== '' ? raw.parentId : null;
    const res: Resource = { id, type, parentId, raw, index, path };
    ctx.byId.set(id, res);
    const siblings = ctx.children.get(parentId);
    if (siblings) siblings.push(res);
    else ctx.children.set(parentId, [res]);
    out.push(res);
  });
  return out;
}

function validate(w: WarningCollector, doc: unknown): unknown[] {
  if (!isRecord(doc)) failImport(w, '', 'This is not an Insomnia export: the top-level JSON value must be an object.');
  if (doc._type !== 'export') failImport(w, '_type', 'This is not an Insomnia export: "_type" must be "export".');
  if (!Array.isArray(doc.resources)) failImport(w, 'resources', 'This is not an Insomnia export: the "resources" array is missing.');
  const format = doc.__export_format;
  if (format !== 4) w.warn('__export_format', `Insomnia export format ${toStr(format)} is treated as format 4`, format);
  return doc.resources;
}

function run(input: string | object, options: ImportLimitOptions): ParseInsomniaResult {
  const w = new WarningCollector();
  const limits = resolveLimits(options);

  emitProgress(limits, 'Parsing', 0, 1);
  const doc = parseJsonInput(input, limits.maxBytes, w);
  emitProgress(limits, 'Parsing', 1, 1);

  emitProgress(limits, 'Validating', 0, 1);
  const resources = validate(w, doc);
  assertItemCount(resources.length, limits, 'resources');
  const ctx: Ctx = { w, stats: newStats(), limits, byId: new Map(), children: new Map(), visited: new Set(), total: 0, done: 0 };
  const all = indexResources(ctx, resources);
  ctx.total = all.filter((r) => r.type === 'request').length;
  emitProgress(limits, 'Validating', 1, 1);

  emitProgress(limits, 'Importing', 0, ctx.total);
  const workspaces = all.filter((r) => r.type === 'workspace');
  const collections: CollectionBundle[] = workspaces.map((ws) => convertWorkspace(ctx, ws));
  const workspaceIds = new Set(workspaces.map((ws) => ws.id));

  // Orphans: requests/groups whose parent chain does not reach a workspace (missing parent or a cycle).
  const orphans = all.filter((r) => (r.type === 'request' || r.type === 'request_group') && !ctx.visited.has(r.id));
  if (orphans.length > 0) {
    if (collections.length === 0) collections.push(newBundle('Insomnia import', 'Imported from an Insomnia export without a workspace.'));
    const root = collections[0]!;
    for (const orphan of orphans) {
      if (ctx.visited.has(orphan.id)) continue;
      w.warn(`${orphan.path}.parentId`, `Parent "${toStr(orphan.parentId)}" not found; "${toStr(orphan.raw.name)}" was placed at the top level of "${root.name}"`, orphan.parentId);
      placeTree(ctx, [orphan], root.items, 1);
    }
  }

  const environments: EnvironmentBundle[] = [];
  const envIds = new Set(all.filter((r) => r.type === 'environment').map((r) => r.id));
  for (const res of all) {
    if (res.type === 'environment') {
      if (res.parentId !== null && workspaceIds.has(res.parentId)) {
        const index = workspaces.findIndex((ws) => ws.id === res.parentId);
        const variables = convertEnvironmentData(ctx, res.raw.data, `${res.path}.data`);
        ctx.stats.variables += variables.length;
        collections[index]!.variables.push(...variables);
      } else {
        if (res.parentId === null || !envIds.has(res.parentId)) w.warn(`${res.path}.parentId`, 'Environment has no base environment or workspace; imported as a stand-alone environment', res.parentId);
        environments.push(convertEnvironment(ctx, res));
      }
    } else if (res.type === 'cookie_jar') {
      const count = Array.isArray(res.raw.cookies) ? res.raw.cookies.length : 0;
      if (count > 0) w.info(`${res.path}.cookies`, `${count} cookie(s) of the Insomnia cookie jar were not imported`);
    } else if (res.type === 'workspace' || res.type === 'request' || res.type === 'request_group') {
      continue;
    } else if (UNSUPPORTED_TYPES[res.type]) w.warn(res.path, UNSUPPORTED_TYPES[res.type]!, { _type: res.type, name: res.raw.name });
    else w.warn(res.path, `Unknown Insomnia resource type "${res.type}" skipped`, { _type: res.type });
  }
  emitProgress(limits, 'Importing', ctx.done, ctx.total);

  emitProgress(limits, 'Finalizing', 0, 1);
  if (collections.length === 0 && environments.length === 0) failImport(w, 'resources', 'The Insomnia export contains no workspace, request or environment to import.');
  const warnings = w.toArray();
  emitProgress(limits, 'Finalizing', 1, 1);
  return { collections, environments, warnings, stats: ctx.stats, format: 'insomnia-v4' };
}

/**
 * Convert an Insomnia v4 export (JSON text or parsed object) into collection
 * and environment bundles. Synchronous; throws `AppError` (`IMPORT_INVALID`,
 * `IMPORT_TOO_LARGE`).
 */
export function parseInsomnia(input: string | object, options: ImportLimitOptions = {}): ParseInsomniaResult {
  return guardImport(() => run(input, options));
}
