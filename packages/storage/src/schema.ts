/**
 * Drizzle schema for the local SQLite database.
 *
 * Conventions: text UUID primary keys, ISO-8601 text timestamps, foreign keys
 * with ON DELETE CASCADE, `sort_order` for user-defined ordering.
 * Values that are credentials are NEVER stored here: columns named `*_ref`
 * hold an opaque reference into the `secrets` table (ciphertext only).
 */
import { index, integer, sqliteTable, text, uniqueIndex, blob, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

const id = () => text('id').primaryKey();
const createdAt = () => text('created_at').notNull();
const updatedAt = () => text('updated_at').notNull();

export const workspaces = sqliteTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const collections = sqliteTable(
  'collections',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    uid: text('uid').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    postmanSchemaVersion: text('postman_schema_version'),
    sourceMetadataJson: text('source_metadata_json').notNull().default('{}'),
    /** Collection-level auth (inherited by folders/requests). */
    authJson: text('auth_json').notNull().default('{"type":"none","params":{}}'),
    /** Collection-level pre-request/test scripts. */
    scriptsJson: text('scripts_json').notNull().default('[]'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_collections_workspace').on(t.workspaceId, t.sortOrder), index('idx_collections_name').on(t.name)],
);

export const folders = sqliteTable(
  'folders',
  {
    id: id(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    parentFolderId: text('parent_folder_id').references((): AnySQLiteColumn => folders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    authJson: text('auth_json').notNull().default('{"type":"inherit","params":{}}'),
    scriptsJson: text('scripts_json').notNull().default('[]'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_folders_collection').on(t.collectionId, t.parentFolderId, t.sortOrder)],
);

export const requests = sqliteTable(
  'requests',
  {
    id: id(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    folderId: text('folder_id').references(() => folders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    method: text('method').notNull().default('GET'),
    url: text('url').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    settingsJson: text('settings_json').notNull().default('{}'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_requests_collection').on(t.collectionId, t.folderId, t.sortOrder),
    index('idx_requests_name').on(t.name),
    index('idx_requests_url').on(t.url),
  ],
);

const keyValueColumns = () => ({
  id: id(),
  requestId: text('request_id')
    .notNull()
    .references(() => requests.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull().default(''),
  description: text('description').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const requestHeaders = sqliteTable('request_headers', keyValueColumns(), (t) => [index('idx_request_headers_request').on(t.requestId, t.sortOrder)]);
export const requestQueryParams = sqliteTable('request_query_params', keyValueColumns(), (t) => [
  index('idx_request_query_params_request').on(t.requestId, t.sortOrder),
]);
export const requestPathVariables = sqliteTable('request_path_variables', keyValueColumns(), (t) => [
  index('idx_request_path_variables_request').on(t.requestId, t.sortOrder),
]);

export const requestBodies = sqliteTable(
  'request_bodies',
  {
    id: id(),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull().default('none'),
    rawContent: text('raw_content'),
    rawLanguage: text('raw_language'),
    contentType: text('content_type'),
    filePath: text('file_path'),
    formDataJson: text('form_data_json'),
    urlencodedJson: text('urlencoded_json'),
  },
  (t) => [uniqueIndex('uq_request_bodies_request').on(t.requestId)],
);

export const requestAuth = sqliteTable(
  'request_auth',
  {
    id: id(),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    authType: text('auth_type').notNull().default('inherit'),
    /** JSON; secret parameters are replaced with `secretref:` references. */
    configurationJson: text('configuration_json').notNull().default('{}'),
  },
  (t) => [uniqueIndex('uq_request_auth_request').on(t.requestId)],
);

export const requestScripts = sqliteTable(
  'request_scripts',
  {
    id: id(),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    scriptType: text('script_type').notNull(),
    language: text('language').notNull().default('javascript'),
    source: text('source').notNull().default(''),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('idx_request_scripts_request').on(t.requestId, t.sortOrder)],
);

export const requestExamples = sqliteTable(
  'request_examples',
  {
    id: id(),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull().default(''),
    code: integer('code').notNull().default(200),
    headersJson: text('headers_json').notNull().default('[]'),
    body: text('body').notNull().default(''),
    language: text('language'),
    originalRequestJson: text('original_request_json'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('idx_request_examples_request').on(t.requestId, t.sortOrder)],
);

export const environments = sqliteTable(
  'environments',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    isProduction: integer('is_production', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_environments_workspace').on(t.workspaceId)],
);

const variableColumns = () => ({
  id: id(),
  key: text('key').notNull(),
  /** Empty for secret variables: the value lives in secret storage. */
  initialValue: text('initial_value').notNull().default(''),
  currentValue: text('current_value'),
  isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  description: text('description').notNull().default(''),
  type: text('type'),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const environmentVariables = sqliteTable(
  'environment_variables',
  {
    ...variableColumns(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
  },
  (t) => [index('idx_environment_variables_env').on(t.environmentId, t.sortOrder)],
);

export const globalVariables = sqliteTable(
  'global_variables',
  {
    ...variableColumns(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
  },
  (t) => [index('idx_global_variables_workspace').on(t.workspaceId, t.sortOrder)],
);

export const collectionVariables = sqliteTable(
  'collection_variables',
  {
    ...variableColumns(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
  },
  (t) => [index('idx_collection_variables_collection').on(t.collectionId, t.sortOrder)],
);

export const folderVariables = sqliteTable(
  'folder_variables',
  {
    ...variableColumns(),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
  },
  (t) => [index('idx_folder_variables_folder').on(t.folderId, t.sortOrder)],
);

export const history = sqliteTable(
  'history',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    requestId: text('request_id').references(() => requests.id, { onDelete: 'set null' }),
    environmentId: text('environment_id').references(() => environments.id, { onDelete: 'set null' }),
    environmentName: text('environment_name'),
    requestName: text('request_name'),
    method: text('method').notNull(),
    /** Stored URL has sensitive query parameters masked. */
    url: text('url').notNull(),
    statusCode: integer('status_code'),
    statusText: text('status_text'),
    errorCode: text('error_code'),
    durationMs: integer('duration_ms'),
    requestSize: integer('request_size'),
    responseSize: integer('response_size'),
    createdAt: createdAt(),
    requestSnapshotJson: text('request_snapshot_json'),
    responseMetadataJson: text('response_metadata_json'),
  },
  (t) => [
    index('idx_history_workspace_created').on(t.workspaceId, t.createdAt),
    index('idx_history_url').on(t.url),
    index('idx_history_status').on(t.statusCode),
    index('idx_history_method').on(t.method),
  ],
);

export const cookies = sqliteTable(
  'cookies',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    path: text('path').notNull().default('/'),
    name: text('name').notNull(),
    /** Cookie value is stored in secret storage under `cookie:<id>`. */
    valueRef: text('value_ref').notNull(),
    hostOnly: integer('host_only', { mode: 'boolean' }).notNull().default(true),
    secure: integer('secure', { mode: 'boolean' }).notNull().default(false),
    httpOnly: integer('http_only', { mode: 'boolean' }).notNull().default(false),
    sameSite: text('same_site'),
    expiresAt: text('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_cookies_identity').on(t.workspaceId, t.domain, t.path, t.name), index('idx_cookies_domain').on(t.domain)],
);

export const certificates = sqliteTable('certificates', {
  id: id(),
  /** `ca` = additional trusted authority; `client` = client certificate for mutual TLS. */
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  /** Host pattern the certificate applies to (client certs), e.g. `api.corp.example` or `*.corp.example`. */
  hostPattern: text('host_pattern').notNull().default('*'),
  certPem: text('cert_pem'),
  keyRef: text('key_ref'),
  pfxRef: text('pfx_ref'),
  passphraseRef: text('passphrase_ref'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
});

export const testResults = sqliteTable(
  'test_results',
  {
    id: id(),
    historyId: text('history_id').references(() => history.id, { onDelete: 'cascade' }),
    runItemId: text('run_item_id'),
    requestId: text('request_id'),
    name: text('name').notNull(),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_test_results_history').on(t.historyId), index('idx_test_results_run_item').on(t.runItemId)],
);

export const collectionRuns = sqliteTable(
  'collection_runs',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id').references(() => collections.id, { onDelete: 'set null' }),
    collectionName: text('collection_name').notNull(),
    environmentId: text('environment_id').references(() => environments.id, { onDelete: 'set null' }),
    iterations: integer('iterations').notNull().default(1),
    delayMs: integer('delay_ms').notNull().default(0),
    stopOnFailure: integer('stop_on_failure', { mode: 'boolean' }).notNull().default(false),
    status: text('status').notNull().default('running'),
    totalRequests: integer('total_requests').notNull().default(0),
    passedTests: integer('passed_tests').notNull().default(0),
    failedTests: integer('failed_tests').notNull().default(0),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    summaryJson: text('summary_json'),
  },
  (t) => [index('idx_collection_runs_workspace').on(t.workspaceId, t.startedAt)],
);

export const collectionRunItems = sqliteTable(
  'collection_run_items',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => collectionRuns.id, { onDelete: 'cascade' }),
    iteration: integer('iteration').notNull().default(0),
    requestId: text('request_id'),
    requestName: text('request_name').notNull(),
    method: text('method').notNull(),
    url: text('url').notNull(),
    statusCode: integer('status_code'),
    durationMs: integer('duration_ms'),
    passed: integer('passed', { mode: 'boolean' }).notNull().default(true),
    error: text('error'),
    testsJson: text('tests_json'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Redacted response head (JSON), only when the run was started with `keepResponses`. Never contains Authorization/Cookie headers. */
    responseJson: text('response_json'),
  },
  (t) => [index('idx_collection_run_items_run').on(t.runId, t.sortOrder)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: updatedAt(),
});

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: id(),
    action: text('action').notNull(),
    detailsJson: text('details_json').notNull().default('{}'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_audit_logs_created').on(t.createdAt), index('idx_audit_logs_action').on(t.action)],
);

export const importJobs = sqliteTable('import_jobs', {
  id: id(),
  workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  sourceType: text('source_type').notNull(),
  fileName: text('file_name'),
  status: text('status').notNull().default('pending'),
  collectionId: text('collection_id'),
  statsJson: text('stats_json'),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
});

export const importWarnings = sqliteTable(
  'import_warnings',
  {
    id: id(),
    importJobId: text('import_job_id')
      .notNull()
      .references(() => importJobs.id, { onDelete: 'cascade' }),
    severity: text('severity').notNull(),
    path: text('path').notNull().default(''),
    message: text('message').notNull(),
    sourceValue: text('source_value'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_import_warnings_job').on(t.importJobId)],
);

export const backups = sqliteTable('backups', {
  id: id(),
  fileName: text('file_name').notNull(),
  path: text('path').notNull(),
  sizeBytes: integer('size_bytes').notNull().default(0),
  includesHistory: integer('includes_history', { mode: 'boolean' }).notNull().default(false),
  encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
});

/** Ciphertext-only secret blobs (see `CipherBackedSecretStorage`). Never contains plaintext. */
export const secrets = sqliteTable('secrets', {
  key: text('key').primaryKey(),
  blob: blob('blob', { mode: 'buffer' }).notNull(),
  updatedAt: updatedAt(),
});
