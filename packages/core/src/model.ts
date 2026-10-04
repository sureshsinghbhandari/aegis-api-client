/**
 * Portable domain model. These types are used by the UI, the services, the
 * Postman importer/exporter and the storage layer. They deliberately contain
 * no database concerns beyond ids/timestamps.
 */

export type ID = string;

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'] as const;
/** Custom methods are allowed, so this is `string`; HTTP_METHODS lists the well-known ones. */
export type HttpMethod = string;

export interface KeyValueEntry {
  key: string;
  value: string;
  description?: string;
  enabled: boolean;
}

export type BodyMode = 'none' | 'raw' | 'urlencoded' | 'formdata' | 'binary';
export type RawLanguage = 'json' | 'xml' | 'text' | 'html' | 'javascript';

export interface FormDataEntry {
  key: string;
  /** `variable`: `value` is the NAME of a variable resolved at send time. */
  type: 'text' | 'file' | 'variable';
  value: string;
  /** For `file` entries: local path chosen by the user (validated at send time). */
  filePath?: string;
  contentType?: string;
  description?: string;
  enabled: boolean;
}

export interface RequestBody {
  mode: BodyMode;
  raw?: string;
  rawLanguage?: RawLanguage;
  /** Explicit content-type override for the body (optional). */
  contentType?: string;
  /** For `binary` mode: local file path. */
  filePath?: string;
  formData?: FormDataEntry[];
  urlencoded?: KeyValueEntry[];
}

export type AuthType = 'inherit' | 'none' | 'basic' | 'bearer' | 'apikey' | 'oauth2' | 'oauth1' | 'jwt' | 'awsv4' | 'custom';

export type AuthParamValue = string | number | boolean;

export interface AuthConfig {
  type: AuthType;
  /** Provider-specific parameters. See packages/authentication for the keys of each type. */
  params: Record<string, AuthParamValue>;
}

/**
 * Auth parameter keys (Postman key names are used verbatim for lossless
 * round-trips) that hold credentials. These are moved to secret storage on
 * save and blanked on export unless secrets are explicitly included.
 * For `custom`, every parameter whose key looks sensitive is treated as a secret.
 */
export const AUTH_SECRET_PARAMS: Record<string, readonly string[]> = {
  basic: ['password'],
  bearer: ['token'],
  apikey: ['value'],
  oauth2: ['clientSecret', 'accessToken', 'refreshToken', 'password', 'code_verifier'],
  oauth1: ['consumerSecret', 'tokenSecret'],
  jwt: ['secret', 'privateKey'],
  awsv4: ['secretKey', 'sessionToken'],
};

/** True when the whole string consists of `{{variable}}` references (i.e. is not itself a literal credential). */
export function isVariableReferenceOnly(value: string): boolean {
  return /^\s*(\{\{[^{}]+\}\}\s*)+$/.test(value);
}

export type ScriptType = 'prerequest' | 'test';

export interface ScriptEntry {
  type: ScriptType;
  language: 'javascript';
  source: string;
  enabled: boolean;
}

export interface RequestExample {
  id?: ID;
  name: string;
  status: string;
  code: number;
  headers: KeyValueEntry[];
  body: string;
  /** Example body language hint (json/xml/text/html). */
  language?: string;
  /** The request snapshot the example was recorded for (opaque JSON). */
  originalRequest?: unknown;
  /** Unknown source fields preserved for round-trip. */
  metadata?: Record<string, unknown>;
}

export interface RequestSettings {
  timeoutMs?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  /** Only honored if enterprise policy permits. */
  verifyTls?: boolean;
  maxResponseBytes?: number;
}

/** A request without database identity. Used by import/export. */
export interface RequestDraft {
  name: string;
  description: string;
  method: HttpMethod;
  url: string;
  headers: KeyValueEntry[];
  queryParams: KeyValueEntry[];
  pathVariables: KeyValueEntry[];
  body: RequestBody;
  /** `inherit` means: use folder/collection auth. */
  auth: AuthConfig;
  scripts: ScriptEntry[];
  examples: RequestExample[];
  settings: RequestSettings;
  /** Unknown source JSON preserved for round-trip (e.g. Postman protocolProfileBehavior). */
  metadata: Record<string, unknown>;
}

export interface RequestModel extends RequestDraft {
  id: ID;
  collectionId: ID;
  folderId: ID | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface VariableEntry {
  /** Stable row id (present for stored variables; keeps secret references valid across edits). */
  id?: ID;
  key: string;
  initialValue: string;
  /** Runtime value. When undefined/empty the initial value is used. */
  currentValue?: string;
  isSecret: boolean;
  enabled: boolean;
  description?: string;
  /** Source type label (e.g. Postman `secret`, `default`, `any`). */
  type?: string;
}

export interface Workspace {
  id: ID;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface Collection {
  id: ID;
  workspaceId: ID;
  name: string;
  description: string;
  uid: string;
  sortOrder: number;
  postmanSchemaVersion: string | null;
  sourceMetadata: Record<string, unknown>;
  auth: AuthConfig;
  scripts: ScriptEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface Folder {
  id: ID;
  collectionId: ID;
  parentFolderId: ID | null;
  name: string;
  description: string;
  sortOrder: number;
  auth: AuthConfig;
  scripts: ScriptEntry[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Environment {
  id: ID;
  workspaceId: ID;
  name: string;
  description: string;
  isActive: boolean;
  /** Production environments can require extra confirmation (see enterprise policy). */
  isProduction: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------- portable (import/export) tree ----------

export interface FolderNode {
  kind: 'folder';
  name: string;
  description: string;
  auth: AuthConfig;
  scripts: ScriptEntry[];
  variables: VariableEntry[];
  metadata: Record<string, unknown>;
  items: ItemNode[];
}

export interface RequestNode {
  kind: 'request';
  request: RequestDraft;
}

export type ItemNode = FolderNode | RequestNode;

export interface CollectionBundle {
  name: string;
  description: string;
  /** Source uid (Postman `info._postman_id`) if known. */
  uid?: string;
  postmanSchemaVersion?: string;
  variables: VariableEntry[];
  auth: AuthConfig;
  scripts: ScriptEntry[];
  /** Unknown/unsupported source JSON preserved verbatim. */
  sourceMetadata: Record<string, unknown>;
  items: ItemNode[];
}

export interface EnvironmentBundle {
  name: string;
  description?: string;
  variables: VariableEntry[];
  sourceMetadata?: Record<string, unknown>;
}

// ---------- import reporting ----------

export type ImportSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface ImportWarningModel {
  id?: ID;
  importJobId?: ID;
  severity: ImportSeverity;
  /** JSON-path-like location in the source document, e.g. `item[2].request.auth`. */
  path: string;
  message: string;
  sourceValue?: string;
  createdAt?: string;
}

export interface ImportStats {
  folders: number;
  requests: number;
  variables: number;
  scripts: number;
  examples: number;
}

export type ImportStage = 'Parsing' | 'Validating' | 'Importing' | 'Saving' | 'Finalizing';

export interface ImportProgress {
  stage: ImportStage;
  current: number;
  total: number;
}

export function emptyRequestDraft(overrides: Partial<RequestDraft> = {}): RequestDraft {
  return {
    name: 'New Request',
    description: '',
    method: 'GET',
    url: '',
    headers: [],
    queryParams: [],
    pathVariables: [],
    body: { mode: 'none' },
    auth: { type: 'inherit', params: {} },
    scripts: [],
    examples: [],
    settings: {},
    metadata: {},
    ...overrides,
  };
}
