/**
 * Postman data dump (Settings -> Data -> Export: `{ version, collections[],
 * environments[], globals, headerPresets }`) -> several bundles. Each
 * collection is handed to the v2 or v1 importer, environments to the
 * environment importer, globals to the globals importer. A broken member is
 * reported as an ERROR warning and skipped instead of failing the whole dump.
 */
import { AppError } from '@aegis/core';
import type { CollectionBundle, EnvironmentBundle, ImportStats, ImportWarningModel } from '@aegis/core';
import { isPostmanV1Collection } from './detect';
import { parsePostmanCollection } from './import-collection';
import { addStats, assertItemCount, emitProgress, guardImport, newStats, resolveLimits } from './import-common';
import type { ImportLimitOptions, ResolvedLimits } from './import-common';
import { parsePostmanEnvironment, parsePostmanGlobals } from './import-environment';
import { parsePostmanV1 } from './import-v1';
import { failImport, isRecord, parseJsonInput, toStr } from './shared';
import { WarningCollector } from './warnings';

export interface ParseDumpResult {
  collections: CollectionBundle[];
  environments: EnvironmentBundle[];
  /** Present when the dump contains globals. */
  globals?: EnvironmentBundle;
  warnings: ImportWarningModel[];
  /** Aggregate over every imported member. */
  stats: ImportStats;
  format: 'postman-dump';
}

function prefixed(path: string, inner: string): string {
  return inner === '' ? path : `${path}.${inner}`;
}

/** Copy the warnings of a member import into the dump collector, prefixing their paths. */
function merge(w: WarningCollector, path: string, warnings: readonly ImportWarningModel[]): void {
  for (const x of warnings) w.add(x.severity, prefixed(path, x.path), x.message, x.sourceValue);
}

/** Run a member importer; IMPORT_INVALID becomes an ERROR warning (the member is skipped), everything else propagates. */
function tryMember<T>(w: WarningCollector, path: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AppError && e.code === 'IMPORT_INVALID') {
      const inner = e.details.warnings;
      if (Array.isArray(inner)) merge(w, path, inner.filter((x): x is ImportWarningModel => isRecord(x) && typeof x.message === 'string'));
      else w.error(path, e.message);
      return undefined;
    }
    throw e;
  }
}

function memberLimits(limits: ResolvedLimits): ImportLimitOptions {
  return { maxBytes: limits.maxBytes, maxItems: limits.maxItems, maxDepth: limits.maxDepth };
}

function importCollections(w: WarningCollector, list: unknown[], limits: ResolvedLimits, stats: ImportStats): CollectionBundle[] {
  const out: CollectionBundle[] = [];
  list.forEach((raw, i) => {
    const path = `collections[${i}]`;
    emitProgress(limits, 'Importing', i, list.length);
    if (!isRecord(raw)) {
      w.warn(path, 'Collection entry is not an object; skipped', raw);
      return;
    }
    if (isRecord(raw.info)) {
      const r = tryMember(w, path, () => parsePostmanCollection(raw, memberLimits(limits)));
      if (!r) return;
      merge(w, path, r.warnings);
      addStats(stats, r.stats);
      out.push(r.bundle);
    } else if (isPostmanV1Collection(raw) || Array.isArray(raw.requests)) {
      const r = tryMember(w, path, () => parsePostmanV1(raw, memberLimits(limits)));
      if (!r) return;
      merge(w, path, r.warnings);
      addStats(stats, r.stats);
      out.push(r.bundle);
    } else w.warn(path, `Collection "${toStr(raw.name)}" is neither a v1 nor a v2 collection; skipped`, raw.name);
  });
  return out;
}

function importEnvironments(w: WarningCollector, raw: unknown, stats: ImportStats): EnvironmentBundle[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    w.warn('environments', 'environments is not an array; ignored', raw);
    return [];
  }
  const out: EnvironmentBundle[] = [];
  raw.forEach((env, i) => {
    const path = `environments[${i}]`;
    if (!isRecord(env) || !Array.isArray(env.values)) {
      w.warn(path, 'Environment entry has no "values" array; skipped', env);
      return;
    }
    const r = tryMember(w, path, () => parsePostmanEnvironment(env));
    if (!r) return;
    merge(w, path, r.warnings);
    stats.variables += r.bundle.variables.length;
    out.push(r.bundle);
  });
  return out;
}

function importGlobals(w: WarningCollector, raw: unknown, stats: ImportStats): EnvironmentBundle | undefined {
  if (raw === undefined || raw === null) return undefined;
  let doc: Record<string, unknown>;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return undefined;
    doc = { name: 'Globals', values: raw, _postman_variable_scope: 'globals' };
  } else if (isRecord(raw) && Array.isArray(raw.values)) doc = { _postman_variable_scope: 'globals', ...raw };
  else {
    w.warn('globals', 'globals is neither an array of variables nor an object with "values"; ignored', raw);
    return undefined;
  }
  const r = tryMember(w, 'globals', () => parsePostmanGlobals(doc));
  if (!r) return undefined;
  merge(w, 'globals', r.warnings);
  stats.variables += r.bundle.variables.length;
  return r.bundle;
}

function validate(w: WarningCollector, doc: unknown): Record<string, unknown> {
  if (!isRecord(doc)) failImport(w, '', 'This is not a Postman data dump: the top-level JSON value must be an object.');
  if (isRecord(doc.info) && Array.isArray(doc.item)) failImport(w, 'info', 'This is a single Postman collection, not a data dump; use the collection importer.');
  if (!Array.isArray(doc.collections)) failImport(w, 'collections', 'This is not a Postman data dump: the "collections" array is missing.');
  return doc;
}

function run(input: string | object, options: ImportLimitOptions): ParseDumpResult {
  const w = new WarningCollector();
  const limits = resolveLimits(options);

  emitProgress(limits, 'Parsing', 0, 1);
  const parsed = parseJsonInput(input, limits.maxBytes, w);
  emitProgress(limits, 'Parsing', 1, 1);

  emitProgress(limits, 'Validating', 0, 1);
  const doc = validate(w, parsed);
  const collectionsRaw = doc.collections as unknown[];
  const environmentsRaw = Array.isArray(doc.environments) ? doc.environments : [];
  assertItemCount(collectionsRaw.length + environmentsRaw.length, limits, 'collections and environments');
  if (typeof doc.version === 'string' && doc.version !== '1') w.info('version', `Dump version "${doc.version}" is treated as version 1`, doc.version);
  emitProgress(limits, 'Validating', 1, 1);

  const stats = newStats();
  emitProgress(limits, 'Importing', 0, collectionsRaw.length);
  const collections = importCollections(w, collectionsRaw, limits, stats);
  const environments = importEnvironments(w, doc.environments, stats);
  const globals = importGlobals(w, doc.globals, stats);
  if (Array.isArray(doc.headerPresets) && doc.headerPresets.length > 0) w.info('headerPresets', `${doc.headerPresets.length} header preset(s) are not imported`);
  emitProgress(limits, 'Importing', collectionsRaw.length, collectionsRaw.length);

  emitProgress(limits, 'Finalizing', 0, 1);
  if (collections.length === 0 && environments.length === 0 && !globals) {
    if (w.hasErrors) failImport(w, '', 'No member of the data dump could be imported.');
    w.warn('', 'The data dump contains no collections, environments or globals');
  }
  const result: ParseDumpResult = { collections, environments, warnings: w.toArray(), stats, format: 'postman-dump' };
  if (globals) result.globals = globals;
  emitProgress(limits, 'Finalizing', 1, 1);
  return result;
}

/**
 * Convert a Postman data dump (JSON text or parsed object) into collection,
 * environment and globals bundles. Synchronous; throws `AppError`
 * (`IMPORT_INVALID`, `IMPORT_TOO_LARGE`).
 */
export function parsePostmanDump(input: string | object, options: ImportLimitOptions = {}): ParseDumpResult {
  return guardImport(() => run(input, options));
}
