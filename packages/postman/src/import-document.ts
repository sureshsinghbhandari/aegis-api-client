/**
 * One entry point for every import format: parse text (JSON/YAML), detect the
 * family, dispatch to the registered importer and return a uniform
 * {@link ImportedDocuments} (collections + environments + globals) so the
 * application layer stores, previews and rolls back every format the same way.
 *
 * Importers for additional families register themselves through
 * {@link registerDocumentImporter}; an unregistered family is reported as
 * "not available" instead of being silently ignored.
 */
import { AppError } from '@aegis/core';
import type { CollectionBundle, EnvironmentBundle, ImportProgress, ImportStats, ImportWarningModel, VariableEntry } from '@aegis/core';
import { describeImportFormat, detectImportFormat, type ImportFormat } from './detect';
import { parsePostmanCollection, type ParseCollectionResult } from './import-collection';
import { parsePostmanEnvironment, parsePostmanGlobals, type ParseEnvironmentResult } from './import-environment';
import { parseOpenApiDocument } from './import-openapi';
import { parseSwagger2Document } from './import-swagger2';
import { parseImportText } from './parse-input';
import type { JsonObject } from './shared';
import { DEFAULT_MAX_BYTES, isRecord } from './shared';
import { WarningCollector } from './warnings';

export type ImportedFormat = Exclude<ImportFormat, 'unknown' | 'aegis-backup'>;

export interface ImportedDocuments {
  format: ImportedFormat;
  /** Display name: the collection name, or a summary for multi-document files. */
  name: string;
  collections: CollectionBundle[];
  environments: EnvironmentBundle[];
  /** Global variables, when the file carries them (`null` otherwise). */
  globals: VariableEntry[] | null;
  /** Aegis workspace files carry the workspace itself. */
  workspace?: { name: string; description: string };
  warnings: ImportWarningModel[];
  stats: ImportStats;
  schemaVersion?: string;
}

export interface DocumentImportOptions {
  fileName?: string;
  maxBytes?: number;
  onProgress?: (progress: ImportProgress) => void;
}

/** An importer receives the parsed document (never text) and the options. */
export type DocumentImporter = (doc: object, options: DocumentImportOptions) => ImportedDocuments;

const ZERO: ImportStats = { folders: 0, requests: 0, variables: 0, scripts: 0, examples: 0 };

const registry = new Map<ImportedFormat, DocumentImporter>();

export function registerDocumentImporter(format: ImportedFormat, importer: DocumentImporter): void {
  registry.set(format, importer);
}

export function getDocumentImporter(format: ImportedFormat): DocumentImporter | undefined {
  return registry.get(format);
}

/** Formats with a registered importer (for menus and error messages). */
export function availableImportFormats(): ImportedFormat[] {
  return [...registry.keys()];
}

function addStats(into: ImportStats, from: ImportStats): void {
  into.folders += from.folders;
  into.requests += from.requests;
  into.variables += from.variables;
  into.scripts += from.scripts;
  into.examples += from.examples;
}

function prefixWarnings(prefix: string, warnings: ImportWarningModel[]): ImportWarningModel[] {
  return warnings.map((w) => ({ ...w, path: w.path ? `${prefix}.${w.path}` : prefix }));
}

/** Adapter for importers that produce exactly one collection. */
export function singleCollection(format: ImportedFormat, result: Pick<ParseCollectionResult, 'bundle' | 'warnings' | 'stats'>, schemaVersion?: string): ImportedDocuments {
  return {
    format,
    name: result.bundle.name,
    collections: [result.bundle],
    environments: [],
    globals: null,
    warnings: result.warnings,
    stats: result.stats,
    ...(schemaVersion ? { schemaVersion } : {}),
  };
}

function singleEnvironment(format: 'postman-environment' | 'postman-globals', result: ParseEnvironmentResult): ImportedDocuments {
  const stats = { ...ZERO, variables: result.bundle.variables.length };
  return format === 'postman-globals'
    ? { format, name: result.bundle.name, collections: [], environments: [], globals: result.bundle.variables, warnings: result.warnings, stats }
    : { format, name: result.bundle.name, collections: [], environments: [result.bundle], globals: null, warnings: result.warnings, stats };
}

// ---------- Aegis workspace file (written by workspaces.export) ----------

function importAegisWorkspace(doc: object, options: DocumentImportOptions): ImportedDocuments {
  const w = new WarningCollector();
  const d = doc as JsonObject;
  if (d.version !== 1) {
    w.error('version', `Unsupported Aegis workspace file version "${String(d.version)}".`);
    throw new AppError('IMPORT_INVALID', 'Unsupported Aegis workspace file version.', { warnings: w.toArray() });
  }
  const ws = isRecord(d.workspace) ? d.workspace : {};
  const workspace = { name: typeof ws.name === 'string' && ws.name.trim() ? ws.name : 'Imported workspace', description: typeof ws.description === 'string' ? ws.description : '' };
  if (!isRecord(d.workspace)) w.warn('workspace', 'The file has no workspace entry; using "Imported workspace"');
  const stats = { ...ZERO };
  const warnings: ImportWarningModel[] = [];
  const collections: CollectionBundle[] = [];
  const environments: EnvironmentBundle[] = [];
  let globals: VariableEntry[] | null = null;

  const list = Array.isArray(d.collections) ? d.collections : [];
  if (!Array.isArray(d.collections)) w.warn('collections', 'collections is not an array; no collections imported');
  list.forEach((c, i) => {
    const res = parsePostmanCollection(c as object, { onProgress: options.onProgress });
    collections.push(res.bundle);
    addStats(stats, res.stats);
    warnings.push(...prefixWarnings(`collections[${i}]`, res.warnings));
  });
  const envs = Array.isArray(d.environments) ? d.environments : [];
  if (d.environments !== undefined && !Array.isArray(d.environments)) w.warn('environments', 'environments is not an array; no environments imported');
  envs.forEach((e, i) => {
    const res = parsePostmanEnvironment(e as object);
    environments.push(res.bundle);
    stats.variables += res.bundle.variables.length;
    warnings.push(...prefixWarnings(`environments[${i}]`, res.warnings));
  });
  if (isRecord(d.globals)) {
    const res = parsePostmanEnvironment(d.globals);
    globals = res.bundle.variables;
    stats.variables += globals.length;
    warnings.push(...prefixWarnings('globals', res.warnings.filter((x) => !/_postman_variable_scope/.test(x.path))));
  }
  const name = `${workspace.name} (${collections.length} collection${collections.length === 1 ? '' : 's'}, ${environments.length} environment${environments.length === 1 ? '' : 's'})`;
  return { format: 'aegis-workspace', name, collections, environments, globals, workspace, warnings: [...w.toArray(), ...warnings], stats, schemaVersion: '1' };
}

// ---------- built-in registrations ----------

registerDocumentImporter('postman-collection', (doc, o) => {
  const r = parsePostmanCollection(doc, { onProgress: o.onProgress });
  return singleCollection('postman-collection', r, r.bundle.postmanSchemaVersion);
});
registerDocumentImporter('postman-environment', (doc) => singleEnvironment('postman-environment', parsePostmanEnvironment(doc)));
registerDocumentImporter('postman-globals', (doc) => singleEnvironment('postman-globals', parsePostmanGlobals(doc)));
registerDocumentImporter('openapi', (doc, o) => {
  const r = parseOpenApiDocument(doc, { fileName: o.fileName, onProgress: o.onProgress });
  return singleCollection('openapi', r, r.version);
});
registerDocumentImporter('swagger', (doc, o) => {
  const r = parseSwagger2Document(doc, { fileName: o.fileName, onProgress: o.onProgress });
  return singleCollection('swagger', r, r.version);
});
registerDocumentImporter('aegis-workspace', importAegisWorkspace);

// ---------- entry point ----------

export interface ImportDocumentOptions extends DocumentImportOptions {
  /**
   * Families the caller accepts (what the user chose in the UI). When the file
   * belongs to another family the import fails with a message naming it, so a
   * HAR file is never imported "as a collection" by accident.
   */
  expect?: readonly ImportFormat[];
}

/**
 * Parse `input` (JSON/YAML text or a parsed object), detect its format and run
 * the matching importer. Throws `AppError` (`IMPORT_INVALID`, `IMPORT_TOO_LARGE`, `UNSUPPORTED`).
 */
export function importDocument(input: string | object, options: ImportDocumentOptions = {}): ImportedDocuments {
  const w = new WarningCollector();
  let doc: unknown;
  if (typeof input === 'string') {
    options.onProgress?.({ stage: 'Parsing', current: 0, total: 1 });
    try {
      doc = parseImportText(input, options.fileName, options.maxBytes ?? DEFAULT_MAX_BYTES, w);
    } catch (e) {
      if (e instanceof RangeError) throw new AppError('IMPORT_INVALID', 'The document is nested too deeply to import.', {}, { cause: e });
      throw e;
    }
    options.onProgress?.({ stage: 'Parsing', current: 1, total: 1 });
  } else doc = input;

  const format = detectImportFormat(doc);
  if (format === 'unknown') {
    w.error('', 'The file format was not recognised. Supported: Postman Collection v1/v2, Postman environment/globals, Postman data dump, OpenAPI 3.x, Swagger 2.0, HAR 1.2, Insomnia v4 export, Aegis workspace file.');
    throw new AppError('IMPORT_INVALID', 'The file format was not recognised.', { warnings: w.toArray() });
  }
  if (format === 'aegis-backup') {
    w.error('format', 'This is an Aegis backup. Use File -> Import -> Backup (or the "Aegis Backup" option) to restore it.');
    throw new AppError('IMPORT_INVALID', 'This is an Aegis backup; use the backup restore instead.', { warnings: w.toArray() });
  }
  if (options.expect && !options.expect.includes(format)) {
    const msg = `This file is a ${describeImportFormat(format)}, not ${options.expect.map(describeImportFormat).join(' / ')}. Choose that format or "Auto-detect".`;
    w.error('', msg);
    throw new AppError('IMPORT_INVALID', msg, { warnings: w.toArray(), detected: format });
  }
  const importer = registry.get(format);
  if (!importer) {
    throw new AppError('UNSUPPORTED', `${describeImportFormat(format)} import is not available in this build.`, { detected: format });
  }
  const result = importer(doc as object, { fileName: options.fileName, maxBytes: options.maxBytes, onProgress: options.onProgress });
  const info = w.toArray();
  return info.length ? { ...result, warnings: [...info, ...result.warnings] } : result;
}
