import { isRecord } from './shared';

export type PostmanFormat = 'collection-v2.0' | 'collection-v2.1' | 'environment' | 'globals' | 'unknown';

/** Schema URL looks like `https://schema.getpostman.com/json/collection/v2.1.0/collection.json`. */
const SCHEMA_VERSION = /\/v(\d+)\.(\d+)(?:\.\d+)?\//;

function collectionFormat(info: Record<string, unknown>): PostmanFormat {
  const schema = info.schema;
  if (typeof schema !== 'string') return 'collection-v2.1';
  const m = SCHEMA_VERSION.exec(schema);
  if (!m) return 'collection-v2.1';
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== 2) return 'unknown';
  return minor === 0 ? 'collection-v2.0' : 'collection-v2.1';
}

/**
 * Identify what kind of Postman document `doc` is. A collection without a
 * `schema` (but with `info.name` and an `item` array) is treated as v2.1; the
 * importer reports that as an INFO warning.
 */
export function detectPostmanFormat(doc: unknown): PostmanFormat {
  if (!isRecord(doc)) return 'unknown';
  const { info } = doc;
  if (isRecord(info) && typeof info.name === 'string' && Array.isArray(doc.item)) return collectionFormat(info);
  if (Array.isArray(doc.values)) {
    const scope = doc._postman_variable_scope;
    if (scope === 'globals') return 'globals';
    if (scope === undefined || scope === 'environment') return 'environment';
  }
  return 'unknown';
}

// ---------- every importable document family ----------

/**
 * Every document family the import pipeline understands. `postman-collection`
 * covers v2.0 and v2.1; `postman-v1` is the legacy `order`/`requests` layout.
 */
export type ImportFormat =
  | 'postman-collection'
  | 'postman-environment'
  | 'postman-globals'
  | 'postman-v1'
  | 'postman-dump'
  | 'openapi'
  | 'swagger'
  | 'har'
  | 'insomnia'
  | 'aegis-workspace'
  | 'aegis-backup'
  | 'unknown';

/** True for the legacy Postman Collection v1 layout (`requests[]` + `order[]`/`folders[]`). */
export function isPostmanV1Collection(doc: unknown): boolean {
  if (!isRecord(doc)) return false;
  if (isRecord(doc.info) && Array.isArray(doc.item)) return false;
  if (!Array.isArray(doc.requests)) return false;
  return Array.isArray(doc.order) || Array.isArray(doc.folders) || Array.isArray(doc.folders_order) || typeof doc.name === 'string';
}

/** True for a Postman "data dump" (Settings -> Data -> Export): `collections[]` + `environments[]`/`globals`. */
export function isPostmanDump(doc: unknown): boolean {
  if (!isRecord(doc)) return false;
  if (isRecord(doc.info) || Array.isArray(doc.item) || Array.isArray(doc.requests)) return false;
  if (!Array.isArray(doc.collections)) return false;
  return Array.isArray(doc.environments) || Array.isArray(doc.globals) || isRecord(doc.globals) || Array.isArray(doc.headerPresets) || typeof doc.version === 'string';
}

/**
 * Detect the family of an already parsed document. Postman v2 collections and
 * environments win over everything else, so a Postman export that happens to
 * contain an `openapi` key is still a Postman collection.
 */
export function detectImportFormat(doc: unknown): ImportFormat {
  if (!isRecord(doc)) return 'unknown';
  if (doc.format === 'aegis-backup') return 'aegis-backup';
  if (doc.format === 'aegis-workspace') return 'aegis-workspace';
  // Encrypted Aegis backups are an envelope `{ v, kdf, ... }` handled by the service; see isEncryptedEnvelope.
  const postman = detectPostmanFormat(doc);
  if (postman === 'collection-v2.0' || postman === 'collection-v2.1') return 'postman-collection';
  if (postman === 'environment') return 'postman-environment';
  if (postman === 'globals') return 'postman-globals';
  if (typeof doc.openapi === 'string' && isRecord(doc.paths)) return 'openapi';
  if (typeof doc.openapi === 'string' && isRecord(doc.info) && (isRecord(doc.components) || isRecord(doc.webhooks))) return 'openapi';
  if (doc.swagger === '2.0' || doc.swagger === 2) return 'swagger';
  if (isRecord(doc.log) && Array.isArray(doc.log.entries)) return 'har';
  if (doc._type === 'export' && Array.isArray(doc.resources)) return 'insomnia';
  if (isPostmanDump(doc)) return 'postman-dump';
  if (isPostmanV1Collection(doc)) return 'postman-v1';
  return 'unknown';
}

/** Human-readable family name for messages and menus. */
export function describeImportFormat(format: ImportFormat): string {
  switch (format) {
    case 'postman-collection':
      return 'Postman Collection v2';
    case 'postman-environment':
      return 'Postman environment';
    case 'postman-globals':
      return 'Postman globals';
    case 'postman-v1':
      return 'Postman Collection v1';
    case 'postman-dump':
      return 'Postman data dump';
    case 'openapi':
      return 'OpenAPI 3.x';
    case 'swagger':
      return 'Swagger 2.0';
    case 'har':
      return 'HAR 1.2';
    case 'insomnia':
      return 'Insomnia v4 export';
    case 'aegis-workspace':
      return 'Aegis workspace file';
    case 'aegis-backup':
      return 'Aegis backup';
    case 'unknown':
      return 'unknown format';
  }
}
