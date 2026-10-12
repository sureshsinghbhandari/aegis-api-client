import { z } from 'zod';
import { API_CHANNELS, type ApiChannel } from '@aegis/core';

/**
 * Strict argument schemas for EVERY IPC channel. Unknown keys are stripped,
 * strings are length-bounded, enums are closed. A channel without a schema
 * is a startup error (see `assertSchemasComplete`).
 */
const id = z.string().min(1).max(200);
const nullableId = id.nullable();
const name = z.string().min(1).max(500);
const text = (max = 100_000) => z.string().max(max);
const bool = z.boolean();
const int = z.number().int().min(0).max(2_000_000_000);

const kv = z.object({ key: text(5000), value: text(10_000_000), description: text(10_000).optional(), enabled: bool });
const authType = z.enum(['inherit', 'none', 'basic', 'bearer', 'apikey', 'oauth2', 'oauth1', 'jwt', 'awsv4', 'custom']);
const authConfig = z.object({
  type: authType,
  params: z.record(z.string().max(200), z.union([text(1_000_000), z.number(), z.boolean()])),
});
const script = z.object({ type: z.enum(['prerequest', 'test']), language: z.literal('javascript'), source: text(5_000_000), enabled: bool });
const body = z.object({
  mode: z.enum(['none', 'raw', 'urlencoded', 'formdata', 'binary', 'graphql']),
  raw: text(256 * 1024 * 1024).optional(),
  graphql: z.object({ query: text(10_000_000), variables: text(10_000_000), operationName: text(500).optional() }).optional(),
  rawLanguage: z.enum(['json', 'xml', 'text', 'html', 'javascript']).optional(),
  contentType: text(500).optional(),
  filePath: text(4096).optional(),
  urlencoded: z.array(kv).max(5000).optional(),
  formData: z
    .array(z.object({ key: text(5000), type: z.enum(['text', 'file', 'variable']), value: text(10_000_000), filePath: text(4096).optional(), contentType: text(500).optional(), description: text(10_000).optional(), enabled: bool }))
    .max(5000)
    .optional(),
});
const example = z.object({
  id: id.optional(),
  name: text(500),
  status: text(200),
  code: z.number().int(),
  headers: z.array(kv).max(500),
  body: text(10_000_000),
  language: text(50).optional(),
  originalRequest: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const draft = z.object({
  name: text(500),
  description: text(100_000),
  method: z.string().min(1).max(50),
  url: text(100_000),
  headers: z.array(kv).max(1000),
  queryParams: z.array(kv).max(2000),
  pathVariables: z.array(kv).max(500),
  body,
  auth: authConfig,
  scripts: z.array(script).max(20),
  examples: z.array(example).max(200),
  settings: z.object({
    timeoutMs: int.optional(),
    followRedirects: bool.optional(),
    maxRedirects: int.optional(),
    verifyTls: bool.optional(),
    maxResponseBytes: int.optional(),
    disableCookies: bool.optional(),
    encodeUrl: bool.optional(),
    followOriginalHttpMethod: bool.optional(),
    followAuthorizationHeader: bool.optional(),
    removeRefererHeaderOnRedirect: bool.optional(),
    httpVersion: z.enum(['auto', '1.1', '2']).optional(),
  }),
  metadata: z.record(z.string(), z.unknown()),
});
const variable = z.object({
  id: id.optional(),
  key: text(1000),
  initialValue: text(10_000_000),
  currentValue: text(10_000_000).optional(),
  isSecret: bool,
  enabled: bool,
  description: text(10_000).optional(),
  type: text(50).optional(),
});
const owner = z.object({ scope: z.enum(['environment', 'global', 'collection', 'folder']), ownerId: id });
const importKind = z.enum(['postman-collection', 'postman-environment', 'backup', 'openapi', 'har', 'insomnia', 'postman-v1', 'postman-dump', 'aegis-workspace', 'auto']);

const noArgs = z.object({}).optional();

export const IPC_SCHEMAS: Record<ApiChannel, z.ZodType> = {
  'app.info': noArgs,

  'workspaces.list': noArgs,
  'workspaces.create': z.object({ name, description: text(10_000).optional() }),
  'workspaces.update': z.object({ id, name: name.optional(), description: text(10_000).optional() }),
  'workspaces.delete': z.object({ id }),
  'workspaces.search': z.object({ query: text(500) }),
  'workspaces.export': z.object({ id, includeSecrets: bool }),

  'collections.list': z.object({ workspaceId: id }),
  'collections.get': z.object({ id }),
  'collections.create': z.object({ workspaceId: id, name, description: text(100_000).optional() }),
  'collections.update': z.object({ id, name: name.optional(), description: text(100_000).optional(), auth: authConfig.optional(), scripts: z.array(script).max(20).optional() }),
  'collections.delete': z.object({ id }),
  'collections.duplicate': z.object({ id }),
  'collections.reorder': z.object({ workspaceId: id, orderedIds: z.array(id).max(10_000) }),
  'collections.tree': z.object({ collectionId: id }),
  'collections.search': z.object({ workspaceId: id, query: text(500) }),

  'folders.get': z.object({ id }),
  'folders.create': z.object({ collectionId: id, parentFolderId: nullableId, name }),
  'folders.update': z.object({ id, name: name.optional(), description: text(100_000).optional(), auth: authConfig.optional(), scripts: z.array(script).max(20).optional() }),
  'folders.delete': z.object({ id }),

  'requests.get': z.object({ id }),
  'requests.create': z.object({ collectionId: id, folderId: nullableId, draft }),
  'requests.save': z.object({ id, draft }),
  'requests.delete': z.object({ id }),
  'requests.duplicate': z.object({ id }),
  'requests.move': z.object({ kind: z.enum(['folder', 'request']), id, parentFolderId: nullableId, index: int, collectionId: id.optional() }),
  'requests.effectiveAuth': z.object({ id }),

  'environments.list': z.object({ workspaceId: id }),
  'environments.create': z.object({ workspaceId: id, name, description: text(10_000).optional(), isProduction: bool.optional() }),
  'environments.update': z.object({ id, name: name.optional(), description: text(10_000).optional(), isProduction: bool.optional() }),
  'environments.duplicate': z.object({ id }),
  'environments.delete': z.object({ id }),
  'environments.setActive': z.object({ workspaceId: id, id: nullableId }),

  'variables.get': owner,
  'variables.set': owner.extend({ entries: z.array(variable).max(20_000) }),
  'variables.revealSecret': z.object({ ref: text(500) }),

  'execution.send': z.object({
    executionId: id,
    workspaceId: id,
    requestId: id.optional(),
    draft: draft.optional(),
    collectionId: id.optional(),
    folderId: nullableId.optional(),
    environmentId: nullableId.optional(),
    confirmProduction: bool.optional(),
    runScripts: bool.optional(),
  }),
  'execution.cancel': z.object({ executionId: id }),

  'responses.readChunk': z.object({ responseId: id, offset: int, length: z.number().int().min(0).max(4 * 1024 * 1024) }),
  'responses.saveAs': z.object({ responseId: id, suggestedName: text(255) }),
  'responses.release': z.object({ responseId: id }),

  'history.search': z.object({
    workspaceId: id,
    text: text(1000).optional(),
    method: text(20).optional(),
    status: text(10).optional(),
    from: text(40).optional(),
    to: text(40).optional(),
    sortBy: z.enum(['createdAt', 'durationMs', 'statusCode', 'method']).optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: int.optional(),
  }),
  'history.get': z.object({ id }),
  'history.delete': z.object({ id }),
  'history.clear': z.object({ workspaceId: id }),
  'history.replay': z.object({ id, executionId: id, confirmProduction: bool.optional() }),
  'history.saveToCollection': z.object({ id, collectionId: id, folderId: nullableId }),

  'runner.start': z.object({
    workspaceId: id,
    collectionId: id,
    folderId: nullableId.optional(),
    environmentId: nullableId.optional(),
    iterations: z.number().int().min(1).max(100_000),
    delayMs: z.number().int().min(0).max(600_000),
    stopOnFailure: bool,
    dataFile: z.object({ name: text(255), content: text(64 * 1024 * 1024) }).optional(),
    confirmProduction: bool.optional(),
    requestIds: z.array(id).max(200_000).optional(),
    keepResponses: bool.optional(),
  }),
  'runner.stop': z.object({ runId: id }),
  'runner.list': z.object({ workspaceId: id }),
  'runner.items': z.object({ runId: id }),

  'importExport.pickAndPreview': z.object({ kind: importKind }),
  'importExport.previewContent': z.object({ kind: importKind, fileName: text(255), content: text(256 * 1024 * 1024) }),
  'importExport.commit': z.object({ token: id, workspaceId: id, passphrase: text(1000).optional() }),
  'importExport.discard': z.object({ token: id }),
  'importExport.exportCollection': z.object({ collectionId: id, includeSecrets: bool }),
  'importExport.exportEnvironment': z.object({ environmentId: id, includeSecrets: bool }),
  'importExport.createBackup': z.object({ includeHistory: bool, passphrase: text(1000).optional(), historyLimit: z.number().int().min(0).max(100_000).optional() }),
  'importExport.listBackups': noArgs,

  'settings.get': noArgs,
  'settings.update': z.object({ patch: z.record(z.string(), z.unknown()) }),
  'settings.setProxyPassword': z.object({ password: text(2000) }),

  'cookies.list': z.object({ workspaceId: id, domain: text(500).optional() }),
  'cookies.reveal': z.object({ id }),
  'cookies.delete': z.object({ id }),
  'cookies.clear': z.object({ workspaceId: id, domain: text(500).optional() }),

  'certificates.list': noArgs,
  'certificates.add': z.object({
    kind: z.enum(['ca', 'client']),
    name,
    hostPattern: text(500).optional(),
    certPem: text(1_000_000).optional(),
    keyPem: text(1_000_000).optional(),
    passphrase: text(2000).optional(),
    pfxBase64: text(4_000_000).optional(),
    pfxPath: text(4096).optional(),
  }),
  'certificates.pickFile': z.object({ purpose: z.enum(['certificate', 'key']) }),
  'certificates.setEnabled': z.object({ id, enabled: bool }),
  'certificates.delete': z.object({ id }),

  'audit.list': z.object({ action: text(100).optional(), limit: z.number().int().min(1).max(1000).optional(), offset: int.optional() }),

  'tools.decodeJwt': z.object({ token: text(100_000) }),
  'tools.pickFile': z.object({ purpose: z.enum(['upload', 'data']) }),
  'tools.oauth2GetToken': z.object({ requestId: id.optional(), collectionId: id.optional(), folderId: id.optional(), auth: authConfig, environmentId: nullableId.optional(), workspaceId: id, cancelId: id.optional() }),
  'tools.oauth2DeviceStart': z.object({ requestId: id.optional(), collectionId: id.optional(), folderId: id.optional(), auth: authConfig, environmentId: nullableId.optional(), workspaceId: id }),
  'tools.oauth2DevicePoll': z.object({
    requestId: id.optional(),
    collectionId: id.optional(),
    folderId: id.optional(),
    auth: authConfig,
    environmentId: nullableId.optional(),
    workspaceId: id,
    deviceCode: text(4096).min(1),
    interval: z.number().min(0).max(3600),
  }),

  'collections.findReplace': z.object({
    collectionId: id.optional(),
    workspaceId: id.optional(),
    find: z.string().min(1).max(2000),
    replace: text(10_000),
    scopes: z.array(z.enum(['url', 'params', 'headers', 'body', 'scripts', 'descriptions', 'variables'])).max(7),
    matchCase: bool.optional(),
    wholeWord: bool.optional(),
    useRegex: bool.optional(),
    apply: bool,
  }),
  'folders.duplicate': z.object({ id }),
  'cookies.add': z.object({
    workspaceId: id,
    domain: z.string().min(1).max(500),
    path: text(2000).optional(),
    name: z.string().min(1).max(500),
    value: text(64 * 1024),
    hostOnly: bool.optional(),
    secure: bool.optional(),
    httpOnly: bool.optional(),
    sameSite: text(20).nullable().optional(),
    expiresAt: text(40).nullable().optional(),
  }),
  'cookies.update': z.object({
    id,
    domain: z.string().min(1).max(500).optional(),
    path: text(2000).optional(),
    name: z.string().min(1).max(500).optional(),
    value: text(64 * 1024).optional(),
    hostOnly: bool.optional(),
    secure: bool.optional(),
    httpOnly: bool.optional(),
    sameSite: text(20).nullable().optional(),
    expiresAt: text(40).nullable().optional(),
  }),
};

/** Fail fast (and in tests) if a channel was added without a schema, or a schema without a channel. */
export function assertSchemasComplete(): void {
  const missing = API_CHANNELS.filter((c) => !(c in IPC_SCHEMAS));
  const extra = Object.keys(IPC_SCHEMAS).filter((c) => !(API_CHANNELS as readonly string[]).includes(c));
  if (missing.length || extra.length) throw new Error(`IPC schema mismatch. Missing: ${missing.join(', ')}. Extra: ${extra.join(', ')}`);
}
