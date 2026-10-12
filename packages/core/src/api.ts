/**
 * The typed IPC contract between the renderer and the application services.
 * Every method takes ONE object argument (or none) and returns a promise.
 * Channel names are `<namespace>.<method>`; see `API_CHANNELS`.
 * The renderer only sees `window.api` (a narrow, validated bridge).
 */
import type { EnterprisePolicy, AppSettings } from './settings';
import type { SerializedAppError } from './errors';
import type {
  AuthConfig,
  Collection,
  Environment,
  Folder,
  ImportProgress,
  ImportStats,
  ImportWarningModel,
  RequestDraft,
  RequestModel,
  ScriptEntry,
  VariableEntry,
  Workspace,
} from './model';
import type { ConnectionInfo, HeaderPair, TlsConnectionInfo } from './http';
import type { ConsoleEntry, TestResult } from './scripting';

// ----------------------------------------------------------------------------- execution

export interface ExecuteRequestInput {
  /** Client-generated id; use it with `execution.cancel`. */
  executionId: string;
  workspaceId: string;
  /** Saved request (used for scope/inheritance); optional for ad-hoc requests. */
  requestId?: string;
  /** Unsaved editor state; wins over the stored request when present. */
  draft?: RequestDraft;
  collectionId?: string;
  folderId?: string | null;
  /** Defaults to the workspace's active environment. */
  environmentId?: string | null;
  /** Must be true to send while a production environment is active and policy requires confirmation. */
  confirmProduction?: boolean;
  runScripts?: boolean;
}

export interface ResponseCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

export interface ResponseView {
  /** Handle for chunked body access and save-to-file. */
  responseId: string;
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HeaderPair[];
  cookies: ResponseCookie[];
  contentType: string;
  /** Total body size in bytes. */
  size: number;
  requestSize: number;
  url: string;
  redirects: Array<{ url: string; status: number; location: string }>;
  timings: { waitingMs: number; downloadMs: number; totalMs: number; startedAt: number; dnsMs?: number; connectMs?: number; tlsMs?: number };
  /** TLS protocol, cipher and peer certificate of the final hop (https only). */
  tls?: TlsConnectionInfo;
  /** Remote/local addresses of the final hop (direct connections only). */
  connection?: ConnectionInfo;
  /** First part of the body as text (UTF-8, lossy for binary). Use `responses.readChunk` for more. */
  bodyPreview: string;
  /** Bytes covered by `bodyPreview`. */
  previewBytes: number;
  isBinary: boolean;
  /** Base64 of the first bytes for safe image preview (images only, capped). */
  imagePreviewBase64?: string;
  notes: string[];
}

export interface ResolvedRequestView {
  method: string;
  /** Final URL with sensitive query parameters masked. */
  url: string;
  headers: HeaderPair[];
  bodyPreview: string;
}

export interface ExecutionResult {
  executionId: string;
  ok: boolean;
  response?: ResponseView;
  error?: SerializedAppError;
  request?: ResolvedRequestView;
  tests: TestResult[];
  console: ConsoleEntry[];
  /** Messages about unresolved variables, ignored changes, script failures, ... */
  warnings: string[];
  unresolvedVariables: string[];
  /** Variable changes applied by scripts, keyed by scope (values masked for secrets). */
  variableChanges: Record<string, { set: string[]; unset: string[] }>;
  historyId?: string;
  environment?: { id: string; name: string; isProduction: boolean } | null;
  skipped?: boolean;
  nextRequest?: string | null;
  /** Sanitised HTML produced by `pm.visualizer.set` (rendered by the Visualize tab inside a sandboxed iframe). */
  visualizer?: string;
}

// ----------------------------------------------------------------------------- trees / search

export interface TreeNode {
  id: string;
  kind: 'folder' | 'request';
  collectionId: string;
  parentId: string | null;
  name: string;
  method?: string;
  sortOrder: number;
}

export interface SearchResult {
  kind: 'workspace' | 'collection' | 'folder' | 'request' | 'environment' | 'variable';
  id: string;
  name: string;
  subtitle: string;
  collectionId?: string;
  method?: string;
}

// ----------------------------------------------------------------------------- history

export interface HistoryItem {
  id: string;
  workspaceId: string;
  requestId: string | null;
  requestName: string | null;
  environmentName: string | null;
  method: string;
  url: string;
  statusCode: number | null;
  statusText: string | null;
  errorCode: string | null;
  durationMs: number | null;
  requestSize: number | null;
  responseSize: number | null;
  createdAt: string;
}

export interface HistorySearchInput {
  workspaceId: string;
  text?: string;
  method?: string;
  status?: string;
  from?: string;
  to?: string;
  sortBy?: 'createdAt' | 'durationMs' | 'statusCode' | 'method';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// ----------------------------------------------------------------------------- import / export

/** Newest history rows per workspace that a backup includes unless the caller asks for more. */
export const BACKUP_HISTORY_LIMIT_DEFAULT = 500;
export const BACKUP_HISTORY_LIMIT_MAX = 100_000;

/**
 * What the user asked to import. `auto` detects the format from the content
 * (Postman v1/v2, data dump, OpenAPI/Swagger, HAR, Insomnia, Aegis workspace/backup).
 */
export type ImportSourceKind =
  | 'postman-collection'
  | 'postman-environment'
  | 'backup'
  | 'openapi'
  | 'har'
  | 'insomnia'
  | 'postman-v1'
  | 'postman-dump'
  | 'aegis-workspace'
  | 'auto';

/** What the importer found. */
export type ImportDocumentKind =
  | 'postman-collection'
  | 'postman-environment'
  | 'postman-globals'
  | 'aegis-backup'
  | 'aegis-workspace'
  | 'openapi'
  | 'swagger'
  | 'har'
  | 'insomnia'
  | 'postman-v1'
  | 'postman-dump';

export interface ImportPreview {
  /** Opaque token to commit or discard this import (the parsed data stays in the main process). */
  token: string;
  kind: ImportDocumentKind;
  fileName: string;
  name: string;
  stats: ImportStats;
  warnings: ImportWarningModel[];
  warningCounts: { INFO: number; WARNING: number; ERROR: number };
  schemaVersion?: string;
  /** Number of collections / environments the file contains (multi-document formats). */
  collections?: number;
  environments?: number;
}

export interface ImportCommitResult {
  jobId: string;
  kind: ImportPreview['kind'];
  collectionId?: string;
  environmentId?: string;
  stats: ImportStats;
  warnings: ImportWarningModel[];
}

export interface BackupInfo {
  id: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  includesHistory: boolean;
  encrypted: boolean;
  createdAt: string;
}

// ----------------------------------------------------------------------------- runner

export interface RunnerOptions {
  workspaceId: string;
  collectionId: string;
  /** Run only a folder (and its descendants). */
  folderId?: string | null;
  environmentId?: string | null;
  iterations: number;
  delayMs: number;
  stopOnFailure: boolean;
  /** Raw text of a CSV or JSON data file (parsed in the main process). */
  dataFile?: { name: string; content: string };
  confirmProduction?: boolean;
  /**
   * Run only these requests, in this order (ids from `collections.tree`). Unknown ids are ignored;
   * when omitted (or empty) every request of the collection/folder runs in tree order.
   */
  requestIds?: string[];
  /** Store a redacted response head (status, non-sensitive headers, first 64 KiB of the body) with each result. */
  keepResponses?: boolean;
}

/** Redacted response head kept with a run item when `RunnerOptions.keepResponses` is set. */
export interface RunnerItemResponse {
  status: number;
  statusText: string;
  contentType: string;
  /** Sensitive headers (Authorization, Cookie, Set-Cookie, tokens, ...) are removed, never stored. */
  headers: HeaderPair[];
  /** Redacted body text (first 64 KiB, UTF-8; empty for binary bodies). */
  body: string;
  bodyTruncated: boolean;
  /** Total body size in bytes. */
  size: number;
}

export interface RunnerItemEvent {
  runId: string;
  index: number;
  iteration: number;
  requestId: string | null;
  name: string;
  method: string;
  url: string;
  statusCode: number | null;
  durationMs: number | null;
  passed: boolean;
  error?: string;
  tests: TestResult[];
  /** Present only when the run was started with `keepResponses`. */
  response?: RunnerItemResponse;
}

export interface RunnerDoneEvent {
  runId: string;
  status: 'completed' | 'stopped' | 'failed';
  totalRequests: number;
  passedTests: number;
  failedTests: number;
  durationMs: number;
}

export interface RunSummary {
  id: string;
  collectionName: string;
  status: string;
  iterations: number;
  totalRequests: number;
  passedTests: number;
  failedTests: number;
  startedAt: string;
  finishedAt: string | null;
}

// ----------------------------------------------------------------------------- misc

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  dataDir: string;
  secretStorage: string;
  secretStorageAvailable: boolean;
  policy: EnterprisePolicy;
  settings: AppSettings;
  localOnly: boolean;
}

export interface CookieView {
  id: string;
  domain: string;
  path: string;
  name: string;
  /** Empty unless revealed. */
  value: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  expiresAt: string | null;
}

export interface CertificateView {
  id: string;
  kind: 'ca' | 'client';
  name: string;
  hostPattern: string;
  hasKey: boolean;
  hasPfx: boolean;
  hasPassphrase: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface AuditView {
  id: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface VariableOwner {
  scope: 'environment' | 'global' | 'collection' | 'folder';
  /** environment id / workspace id / collection id / folder id depending on scope. */
  ownerId: string;
}

export interface FolderUpdate {
  name?: string;
  description?: string;
  auth?: AuthConfig;
  scripts?: ScriptEntry[];
}

export type CollectionUpdate = FolderUpdate;

// ----------------------------------------------------------------------------- find & replace / cookies

export type FindReplaceScope = 'url' | 'params' | 'headers' | 'body' | 'scripts' | 'descriptions' | 'variables';

export const FIND_REPLACE_SCOPES: readonly FindReplaceScope[] = ['url', 'params', 'headers', 'body', 'scripts', 'descriptions', 'variables'];

export interface FindReplaceInput {
  /** One collection, or omit and pass `workspaceId` to search every collection of the workspace. */
  collectionId?: string;
  workspaceId?: string;
  find: string;
  replace: string;
  scopes: FindReplaceScope[];
  matchCase?: boolean;
  /** Match only whole words (letters, digits and `_` are word characters). */
  wholeWord?: boolean;
  /** Treat `find` as a regular expression (bounded: max 500 chars, no nested quantifiers, time budget). `$1` works in `replace`. */
  useRegex?: boolean;
  /** `false` = preview only (count matches, change nothing). */
  apply: boolean;
}

/** One before/after excerpt for the preview. Never produced for secret values. */
export interface FindReplaceSample {
  /** Where the match is, e.g. `Request "List users" › url`. */
  location: string;
  before: string;
  after: string;
}

export interface FindReplaceResult {
  /** Total number of matched occurrences. */
  matches: number;
  /** Number of requests with at least one match. */
  requests: number;
  /** Number of folders (descriptions / scripts) with at least one match. */
  folders: number;
  /** Number of variables (collection + folder scope) with at least one match. Secret variables are never touched. */
  variables: number;
  /** True when a collection's own description or scripts matched. */
  collection: boolean;
  /** Collections with at least one match (anywhere inside). */
  collections: number;
  /** Matches per scope. */
  byScope: Record<FindReplaceScope, number>;
  /** Capped list of before/after excerpts (preview and apply). */
  samples: FindReplaceSample[];
  /** Human-readable summary, e.g. `12 matches in 4 requests`. */
  summary: string;
  applied: boolean;
}

export interface CookieInput {
  workspaceId: string;
  domain: string;
  path?: string;
  name: string;
  /** Stored in the vault, never in a plain table. */
  value: string;
  hostOnly?: boolean;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string | null;
  /** ISO timestamp; null/undefined = session cookie. */
  expiresAt?: string | null;
}

// ----------------------------------------------------------------------------- OAuth 2.0 device flow

export interface OAuth2DeviceInput {
  requestId?: string;
  collectionId?: string;
  folderId?: string;
  auth: AuthConfig;
  environmentId?: string | null;
  workspaceId: string;
}

export interface OAuth2DeviceStart {
  /** Credential for the token polls; the renderer keeps it in memory only and never displays it. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export type OAuth2DevicePoll = { status: 'pending'; interval: number } | { status: 'done'; params: Record<string, string | number | boolean> };

// ----------------------------------------------------------------------------- the API

export interface AegisApi {
  app: {
    info(): Promise<AppInfo>;
  };
  workspaces: {
    list(): Promise<Workspace[]>;
    create(input: { name: string; description?: string }): Promise<Workspace>;
    update(input: { id: string; name?: string; description?: string }): Promise<Workspace>;
    delete(input: { id: string }): Promise<void>;
    search(input: { query: string }): Promise<Workspace[]>;
    /** Export a whole workspace to a file chosen by the user. Returns the path or null if cancelled. */
    export(input: { id: string; includeSecrets: boolean }): Promise<string | null>;
  };
  collections: {
    list(input: { workspaceId: string }): Promise<Collection[]>;
    get(input: { id: string }): Promise<Collection>;
    create(input: { workspaceId: string; name: string; description?: string }): Promise<Collection>;
    update(input: { id: string } & CollectionUpdate): Promise<Collection>;
    delete(input: { id: string }): Promise<void>;
    duplicate(input: { id: string }): Promise<Collection>;
    reorder(input: { workspaceId: string; orderedIds: string[] }): Promise<void>;
    tree(input: { collectionId: string }): Promise<TreeNode[]>;
    search(input: { workspaceId: string; query: string }): Promise<SearchResult[]>;
    /** Find & replace across one collection (or a whole workspace). Preview with `apply: false`; applying runs in one transaction and is audited (counts only). */
    findReplace(input: FindReplaceInput): Promise<FindReplaceResult>;
  };
  folders: {
    get(input: { id: string }): Promise<Folder>;
    create(input: { collectionId: string; parentFolderId: string | null; name: string }): Promise<Folder>;
    update(input: { id: string } & FolderUpdate): Promise<Folder>;
    delete(input: { id: string }): Promise<void>;
    /** Deep copy of a folder (sub-folders, requests, scripts, variables, auth) next to the original. */
    duplicate(input: { id: string }): Promise<Folder>;
  };
  requests: {
    get(input: { id: string }): Promise<RequestModel>;
    create(input: { collectionId: string; folderId: string | null; draft: RequestDraft }): Promise<RequestModel>;
    save(input: { id: string; draft: RequestDraft }): Promise<RequestModel>;
    delete(input: { id: string }): Promise<void>;
    duplicate(input: { id: string }): Promise<RequestModel>;
    /** Move a folder or request; `index` is the position among the target's children. `collectionId` moves it into another collection. */
    move(input: { kind: 'folder' | 'request'; id: string; parentFolderId: string | null; index: number; collectionId?: string }): Promise<void>;
    /** Effective auth after inheritance, for display ("Inherited from Folder X"). */
    effectiveAuth(input: { id: string }): Promise<{ auth: AuthConfig; source: string }>;
  };
  environments: {
    list(input: { workspaceId: string }): Promise<Environment[]>;
    create(input: { workspaceId: string; name: string; description?: string; isProduction?: boolean }): Promise<Environment>;
    update(input: { id: string; name?: string; description?: string; isProduction?: boolean }): Promise<Environment>;
    duplicate(input: { id: string }): Promise<Environment>;
    delete(input: { id: string }): Promise<void>;
    setActive(input: { workspaceId: string; id: string | null }): Promise<void>;
  };
  variables: {
    get(input: VariableOwner): Promise<VariableEntry[]>;
    set(input: VariableOwner & { entries: VariableEntry[] }): Promise<VariableEntry[]>;
    /** Explicit user action: returns the plaintext of a secret reference. Audited. */
    revealSecret(input: { ref: string }): Promise<string>;
  };
  execution: {
    send(input: ExecuteRequestInput): Promise<ExecutionResult>;
    cancel(input: { executionId: string }): Promise<void>;
  };
  responses: {
    readChunk(input: { responseId: string; offset: number; length: number }): Promise<{ text: string; offset: number; bytesRead: number; total: number }>;
    /** Save the full body via a save dialog. Returns the path or null if cancelled. */
    saveAs(input: { responseId: string; suggestedName: string }): Promise<string | null>;
    release(input: { responseId: string }): Promise<void>;
  };
  history: {
    search(input: HistorySearchInput): Promise<{ items: HistoryItem[]; total: number; limit: number; offset: number }>;
    get(input: { id: string }): Promise<HistoryItem & { requestSnapshot: unknown; responseMetadata: unknown }>;
    delete(input: { id: string }): Promise<void>;
    clear(input: { workspaceId: string }): Promise<number>;
    /** Re-run: uses the saved request if it still exists, otherwise the stored snapshot. */
    replay(input: { id: string; executionId: string; confirmProduction?: boolean }): Promise<ExecutionResult>;
    saveToCollection(input: { id: string; collectionId: string; folderId: string | null }): Promise<RequestModel>;
  };
  runner: {
    start(input: RunnerOptions): Promise<{ runId: string }>;
    stop(input: { runId: string }): Promise<void>;
    list(input: { workspaceId: string }): Promise<RunSummary[]>;
    items(input: { runId: string }): Promise<RunnerItemEvent[]>;
  };
  importExport: {
    /** Open a file dialog, parse the file, return a preview. Null if cancelled. */
    pickAndPreview(input: { kind: ImportSourceKind }): Promise<ImportPreview | null>;
    /** Parse content supplied directly (drag & drop / paste). */
    previewContent(input: { kind: ImportSourceKind; fileName: string; content: string }): Promise<ImportPreview>;
    commit(input: { token: string; workspaceId: string; passphrase?: string }): Promise<ImportCommitResult>;
    discard(input: { token: string }): Promise<void>;
    exportCollection(input: { collectionId: string; includeSecrets: boolean }): Promise<string | null>;
    exportEnvironment(input: { environmentId: string; includeSecrets: boolean }): Promise<string | null>;
    /** `historyLimit`: newest history rows per workspace to include (default `BACKUP_HISTORY_LIMIT_DEFAULT`, max `BACKUP_HISTORY_LIMIT_MAX`). */
    createBackup(input: { includeHistory: boolean; passphrase?: string; historyLimit?: number }): Promise<BackupInfo | null>;
    listBackups(): Promise<BackupInfo[]>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(input: { patch: Record<string, unknown> }): Promise<AppSettings>;
    setProxyPassword(input: { password: string }): Promise<void>;
  };
  cookies: {
    list(input: { workspaceId: string; domain?: string }): Promise<CookieView[]>;
    reveal(input: { id: string }): Promise<string>;
    delete(input: { id: string }): Promise<void>;
    clear(input: { workspaceId: string; domain?: string }): Promise<number>;
    /** Add a cookie by hand (value goes to the vault). Fails when the same domain/path/name already exists. */
    add(input: CookieInput): Promise<CookieView>;
    /** Edit a cookie; omit `value` to keep the stored one. */
    update(input: { id: string } & Partial<Omit<CookieInput, 'workspaceId'>>): Promise<CookieView>;
  };
  certificates: {
    list(): Promise<CertificateView[]>;
    /**
     * Add a CA (PEM) or client certificate. Client certificates are either PEM `certPem` + `keyPem`, or a PKCS#12
     * bundle given as `pfxBase64` or as a local `pfxPath` (read in the main process, size-capped). Keys, PFX bundles
     * and passphrases go to the vault.
     */
    add(input: { kind: 'ca' | 'client'; name: string; hostPattern?: string; certPem?: string; keyPem?: string; pfxBase64?: string; pfxPath?: string; passphrase?: string }): Promise<CertificateView>;
    /** File picker for certificates / keys; returns the file content. */
    pickFile(input: { purpose: 'certificate' | 'key' }): Promise<{ name: string; content: string } | null>;
    setEnabled(input: { id: string; enabled: boolean }): Promise<void>;
    delete(input: { id: string }): Promise<void>;
  };
  audit: {
    list(input: { action?: string; limit?: number; offset?: number }): Promise<AuditView[]>;
  };
  tools: {
    decodeJwt(input: { token: string }): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown>; expiresAt?: number; expired?: boolean }>;
    pickFile(input: { purpose: 'upload' | 'data' }): Promise<{ path: string; name: string; size: number } | null>;
    /**
     * Interactive "Get New Access Token". `{{variables}}` in the auth parameters are resolved with the full scope chain
     * (request's collection/folders, environment, globals). Pass a client-generated `cancelId` and call
     * `execution.cancel({ executionId: cancelId })` to abort a pending flow.
     */
    oauth2GetToken(input: { requestId?: string; collectionId?: string; folderId?: string; auth: AuthConfig; environmentId?: string | null; workspaceId: string; cancelId?: string }): Promise<{ params: Record<string, string | number | boolean> }>;
    /**
     * OAuth 2.0 device authorization grant (RFC 8628), step 1: request a device code. The UI shows
     * `userCode` and `verificationUri` to the user, then calls `oauth2DevicePoll` every `interval`
     * seconds until it answers `done` (or the user cancels by simply not polling again).
     */
    oauth2DeviceStart(input: OAuth2DeviceInput): Promise<OAuth2DeviceStart>;
    /** Step 2: one poll of the token endpoint. `pending` carries the (possibly increased) interval to wait before the next poll. */
    oauth2DevicePoll(input: OAuth2DeviceInput & { deviceCode: string; interval: number }): Promise<OAuth2DevicePoll>;
  };
  events: {
    /** Subscribe to main-process events; returns an unsubscribe function. */
    on<K extends keyof AegisEvents>(channel: K, listener: (payload: AegisEvents[K]) => void): () => void;
  };
}

export interface AegisEvents {
  'runner:item': RunnerItemEvent;
  'runner:done': RunnerDoneEvent;
  'import:progress': ImportProgress & { token?: string };
  'menu:action': { action: string };
}

export const EVENT_CHANNELS = ['runner:item', 'runner:done', 'import:progress', 'menu:action'] as const;

/** Every invokable channel, `namespace.method`. The preload bridge exposes exactly these. */
export const API_CHANNELS = [
  'app.info',
  'workspaces.list', 'workspaces.create', 'workspaces.update', 'workspaces.delete', 'workspaces.search', 'workspaces.export',
  'collections.list', 'collections.get', 'collections.create', 'collections.update', 'collections.delete', 'collections.duplicate', 'collections.reorder', 'collections.tree', 'collections.search',
  'folders.get', 'folders.create', 'folders.update', 'folders.delete',
  'requests.get', 'requests.create', 'requests.save', 'requests.delete', 'requests.duplicate', 'requests.move', 'requests.effectiveAuth',
  'environments.list', 'environments.create', 'environments.update', 'environments.duplicate', 'environments.delete', 'environments.setActive',
  'variables.get', 'variables.set', 'variables.revealSecret',
  'execution.send', 'execution.cancel',
  'responses.readChunk', 'responses.saveAs', 'responses.release',
  'history.search', 'history.get', 'history.delete', 'history.clear', 'history.replay', 'history.saveToCollection',
  'runner.start', 'runner.stop', 'runner.list', 'runner.items',
  'importExport.pickAndPreview', 'importExport.previewContent', 'importExport.commit', 'importExport.discard', 'importExport.exportCollection', 'importExport.exportEnvironment', 'importExport.createBackup', 'importExport.listBackups',
  'settings.get', 'settings.update', 'settings.setProxyPassword',
  'cookies.list', 'cookies.reveal', 'cookies.delete', 'cookies.clear',
  'certificates.list', 'certificates.add', 'certificates.pickFile', 'certificates.setEnabled', 'certificates.delete',
  'audit.list',
  'tools.decodeJwt', 'tools.pickFile', 'tools.oauth2GetToken',
  'collections.findReplace', 'folders.duplicate', 'cookies.add', 'cookies.update',
  'tools.oauth2DeviceStart', 'tools.oauth2DevicePoll',
] as const;

export type ApiChannel = (typeof API_CHANNELS)[number];

/** Envelope returned by every IPC invocation. */
export type IpcEnvelope<T = unknown> = { ok: true; value: T } | { ok: false; error: SerializedAppError };
