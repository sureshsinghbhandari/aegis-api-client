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
