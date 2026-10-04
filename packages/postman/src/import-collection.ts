import { AppError } from '@aegis/core';
import type {
  CollectionBundle,
  FolderNode,
  ImportProgress,
  ImportStage,
  ImportStats,
  ImportWarningModel,
  ItemNode,
  RequestDraft,
  RequestNode,
  ScriptEntry,
} from '@aegis/core';
import { detectPostmanFormat } from './detect';
import {
  applyEventMeta,
  cloneAt,
  collectExtras,
  convertAuth,
  convertBody,
  convertEvents,
  convertExamples,
  convertHeaders,
  convertProtocolProfile,
  convertUrl,
  convertVariables,
  importDescription,
} from './import-parts';
import type { ImportedAuth } from './import-parts';
import type { JsonObject } from './shared';
import { DEFAULT_MAX_BYTES, META, failImport, isRecord, parseJsonInput } from './shared';
import { WarningCollector } from './warnings';

export interface ParseCollectionOptions {
  /** Maximum size of a JSON string input (default 256 MiB). */
  maxBytes?: number;
  /** Maximum number of folders + items (default 200000). */
  maxItems?: number;
  /** Maximum folder nesting (default 64). */
  maxDepth?: number;
  onProgress?: (progress: ImportProgress) => void;
}

export interface ParseCollectionResult {
  bundle: CollectionBundle;
  warnings: ImportWarningModel[];
  stats: ImportStats;
  format: 'collection-v2.0' | 'collection-v2.1';
}

const DEFAULT_MAX_ITEMS = 200_000;
const DEFAULT_MAX_DEPTH = 64;
const PROGRESS_EVERY = 50;

const TOP_KNOWN: ReadonlySet<string> = new Set(['info', 'item', 'variable', 'auth', 'event', 'protocolProfileBehavior']);
const INFO_KNOWN: ReadonlySet<string> = new Set(['name', '_postman_id', 'description', 'schema']);
const INFO_QUIET: ReadonlySet<string> = new Set(['version', '_exporter_id']);
const FOLDER_KNOWN: ReadonlySet<string> = new Set(['name', 'description', 'item', 'event', 'variable', 'auth', 'id', 'protocolProfileBehavior']);
const REQUEST_ITEM_KNOWN: ReadonlySet<string> = new Set(['name', 'description', 'request', 'response', 'event', 'id', 'protocolProfileBehavior']);
const REQUEST_KNOWN: ReadonlySet<string> = new Set(['method', 'header', 'body', 'url', 'description', 'auth']);

interface Ctx {
  w: WarningCollector;
  stats: ImportStats;
  maxDepth: number;
  totalRequests: number;
  doneRequests: number;
  onProgress?: (progress: ImportProgress) => void;
}

function emit(ctx: Pick<Ctx, 'onProgress'>, stage: ImportStage, current: number, total: number): void {
  ctx.onProgress?.({ stage, current, total });
}

// ---------- validation ----------

interface Counts {
  folders: number;
  requests: number;
}

/** Iterative walk (no recursion) that enforces the depth and item-count limits. */
function countItems(items: unknown[], maxItems: number, maxDepth: number, w: WarningCollector): Counts {
  const counts: Counts = { folders: 0, requests: 0 };
  let seen = 0;
  const stack: Array<{ list: unknown[]; depth: number }> = [{ list: items, depth: 1 }];
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    if (frame.depth > maxDepth) failImport(w, 'item', `Folders are nested deeper than the supported limit of ${maxDepth} levels.`);
    for (const item of frame.list) {
      seen += 1;
      if (seen > maxItems) {
        throw new AppError('IMPORT_TOO_LARGE', `The collection contains more than ${maxItems} items.`, { maxItems });
      }
      if (!isRecord(item)) continue;
      if (Array.isArray(item.item)) {
        counts.folders += 1;
        stack.push({ list: item.item, depth: frame.depth + 1 });
      } else if (item.request !== undefined) counts.requests += 1;
    }
  }
  return counts;
}

function validateCollection(doc: unknown, w: WarningCollector): 'collection-v2.0' | 'collection-v2.1' {
  if (!isRecord(doc)) failImport(w, '', 'This is not a Postman collection: the top-level JSON value must be an object.');
  const detected = detectPostmanFormat(doc);
  if (detected === 'environment' || detected === 'globals') {
    failImport(w, '', `This file is a Postman ${detected}, not a collection. Use the environment import instead.`);
  }
  if (!isRecord(doc.info)) failImport(w, 'info', 'This is not a Postman collection: the "info" object is missing.');
  if (typeof doc.info.name !== 'string') failImport(w, 'info.name', 'This is not a Postman collection: "info.name" is missing.');
  if (!Array.isArray(doc.item)) failImport(w, 'item', 'This is not a Postman collection: the "item" array is missing.');
  if (detected !== 'collection-v2.0' && detected !== 'collection-v2.1') {
    failImport(w, 'info.schema', `Unsupported collection schema "${String(doc.info.schema)}". Only Postman Collection v2.0 and v2.1 can be imported.`);
  }
  return detected;
}

// ---------- shared pieces of folder / request conversion ----------

function applyAuth(meta: JsonObject, imported: ImportedAuth): void {
  if (imported.meta) meta[META.authMeta] = imported.meta;
}

function countScripts(scripts: readonly ScriptEntry[]): number {
  return scripts.filter((s) => s.source.trim() !== '').length;
}

function emitRequestDone(ctx: Ctx): void {
  ctx.doneRequests += 1;
  if (ctx.doneRequests % PROGRESS_EVERY === 0) emit(ctx, 'Importing', ctx.doneRequests, ctx.totalRequests);
}

// ---------- folders ----------

function convertFolder(raw: JsonObject, path: string, depth: number, ctx: Ctx): FolderNode {
  const { w } = ctx;
  const metadata: JsonObject = {};
  if (typeof raw.id === 'string') metadata[META.postmanId] = raw.id;
  if (typeof raw.name !== 'string') w.info(`${path}.name`, 'Folder has no name; using "Untitled folder"');
  const description = importDescription(w, raw.description, `${path}.description`, metadata);
  const auth = convertAuth(w, raw.auth, `${path}.auth`, 'folder');
  applyAuth(metadata, auth);
  const events = convertEvents(w, raw.event, `${path}.event`);
  applyEventMeta(metadata, events);
  const variables = convertVariables(w, raw.variable, `${path}.variable`);
  if (raw.protocolProfileBehavior !== undefined) metadata[META.protocolProfileBehavior] = cloneAt(w, raw.protocolProfileBehavior, `${path}.protocolProfileBehavior`);
  const extras = collectExtras(w, raw, FOLDER_KNOWN, path);
  if (extras) metadata[META.itemExtras] = extras;

  ctx.stats.folders += 1;
  ctx.stats.variables += variables.length;
  ctx.stats.scripts += countScripts(events.scripts);
  return {
    kind: 'folder',
    name: typeof raw.name === 'string' ? raw.name : 'Untitled folder',
    description,
    auth: auth.auth,
    scripts: events.scripts,
    variables,
    metadata,
    items: convertItems(Array.isArray(raw.item) ? raw.item : [], `${path}.item`, depth + 1, ctx),
  };
}

// ---------- requests ----------

function requestDescription(raw: JsonObject, req: JsonObject, path: string, meta: JsonObject, ctx: Ctx): { text: string; itemKnown: ReadonlySet<string> } {
  const hasRequestDescription = req.description !== undefined && req.description !== null;
  if (hasRequestDescription) {
    // An item-level description next to a request-level one has nowhere to go; it is kept as an extra.
    const itemKnown = raw.description === undefined ? REQUEST_ITEM_KNOWN : new Set([...REQUEST_ITEM_KNOWN].filter((k) => k !== 'description'));
    return { text: importDescription(ctx.w, req.description, `${path}.request.description`, meta), itemKnown };
  }
  if (raw.description !== undefined && raw.description !== null) meta[META.descriptionAt] = 'item';
  return { text: importDescription(ctx.w, raw.description, `${path}.description`, meta), itemKnown: REQUEST_ITEM_KNOWN };
}

function convertRequest(raw: JsonObject, path: string, ctx: Ctx): RequestNode {
  const { w } = ctx;
  const meta: JsonObject = {};
  // v2.0 allows `request` to be just the URL string.
  const shorthand = typeof raw.request === 'string';
  const req: JsonObject = shorthand ? { method: 'GET', url: raw.request } : isRecord(raw.request) ? raw.request : {};
  if (!shorthand && !isRecord(raw.request)) w.warn(`${path}.request`, 'Request is not an object; imported as an empty GET request', raw.request);
  const reqPath = `${path}.request`;

  if (typeof raw.id === 'string') meta[META.postmanId] = raw.id;
  if (typeof raw.name !== 'string') w.info(`${path}.name`, 'Request has no name; using "Untitled Request"');
  const description = requestDescription(raw, req, path, meta, ctx);

  const url = convertUrl(w, req.url, shorthand ? reqPath : `${reqPath}.url`);
  if (url.hash) meta[META.urlHash] = url.hash;
  if (url.extras) meta[META.urlExtras] = url.extras;
  const body = convertBody(w, req.body, `${reqPath}.body`, meta);
  const auth = convertAuth(w, req.auth, `${reqPath}.auth`, 'request');
  applyAuth(meta, auth);
  const events = convertEvents(w, raw.event, `${path}.event`);
  applyEventMeta(meta, events);
  const examples = convertExamples(w, raw.response, `${path}.response`);
  const profile = convertProtocolProfile(w, raw.protocolProfileBehavior, `${path}.protocolProfileBehavior`);
  if (profile.remainder) meta[META.protocolProfileBehavior] = profile.remainder;
  const requestExtras = shorthand ? undefined : collectExtras(w, req, REQUEST_KNOWN, reqPath);
  if (requestExtras) meta[META.requestExtras] = requestExtras;
  const itemExtras = collectExtras(w, raw, description.itemKnown, path);
  if (itemExtras) meta[META.itemExtras] = itemExtras;

  const method = typeof req.method === 'string' && req.method.trim() !== '' ? req.method.trim() : 'GET';
  const draft: RequestDraft = {
    name: typeof raw.name === 'string' ? raw.name : 'Untitled Request',
    description: description.text,
    method,
    url: url.url,
    headers: convertHeaders(w, req.header, `${reqPath}.header`),
    queryParams: url.queryParams,
    pathVariables: url.pathVariables,
    body,
    auth: auth.auth,
    scripts: events.scripts,
    examples,
    settings: profile.settings,
    metadata: meta,
  };
  ctx.stats.requests += 1;
  ctx.stats.scripts += countScripts(events.scripts);
  ctx.stats.examples += examples.length;
  emitRequestDone(ctx);
  return { kind: 'request', request: draft };
}

// ---------- items ----------

function convertItem(raw: unknown, path: string, depth: number, ctx: Ctx): ItemNode | null {
  if (!isRecord(raw)) {
    ctx.w.warn(path, 'Item is not an object; skipped', raw);
    return null;
  }
  if (Array.isArray(raw.item)) return convertFolder(raw, path, depth, ctx);
  if (raw.request !== undefined) return convertRequest(raw, path, ctx);
  ctx.w.warn(path, 'Item is neither a folder nor a request; skipped', raw);
  return null;
}

function convertItems(list: unknown[], path: string, depth: number, ctx: Ctx): ItemNode[] {
  const out: ItemNode[] = [];
  list.forEach((raw, i) => {
    const node = convertItem(raw, `${path}[${i}]`, depth, ctx);
    if (node) out.push(node);
  });
  return out;
}

// ---------- collection ----------

function convertCollection(doc: JsonObject, format: 'collection-v2.0' | 'collection-v2.1', ctx: Ctx): CollectionBundle {
  const { w } = ctx;
  const info = doc.info as JsonObject;
  const sourceMetadata: JsonObject = {};

  const schema = info.schema;
  if (typeof schema !== 'string') w.info('info.schema', 'Collection has no schema URL; treated as Postman Collection v2.1');
  else if (!/\/v2\.[01]\.\d+\//.test(schema)) w.info('info.schema', 'Unrecognised schema URL; treated as Postman Collection v2.1', schema);
  if (format === 'collection-v2.0') w.info('info.schema', 'Postman Collection v2.0 imported; it is exported as Collection v2.1');

  const description = importDescription(w, info.description, 'info.description', sourceMetadata);
  const infoExtras = collectExtras(w, info, INFO_KNOWN, 'info', INFO_QUIET);
  if (infoExtras) sourceMetadata[META.info] = infoExtras;

  const auth = convertAuth(w, doc.auth, 'auth', 'collection');
  applyAuth(sourceMetadata, auth);
  const events = convertEvents(w, doc.event, 'event');
  applyEventMeta(sourceMetadata, events);
  const variables = convertVariables(w, doc.variable, 'variable');
  if (doc.protocolProfileBehavior !== undefined) sourceMetadata[META.protocolProfileBehavior] = cloneAt(w, doc.protocolProfileBehavior, 'protocolProfileBehavior');
  const extras = collectExtras(w, doc, TOP_KNOWN, '');
  if (extras) sourceMetadata[META.extra] = extras;

  ctx.stats.variables += variables.length;
  ctx.stats.scripts += countScripts(events.scripts);
  const name = (info.name as string).trim() === '' ? 'Imported collection' : (info.name as string);
  if (name !== info.name) w.warn('info.name', 'Collection name is empty; using "Imported collection"');

  const bundle: CollectionBundle = {
    name,
    description,
    postmanSchemaVersion: format === 'collection-v2.0' ? '2.0.0' : '2.1.0',
    variables,
    auth: auth.auth,
    scripts: events.scripts,
    sourceMetadata,
    items: convertItems(doc.item as unknown[], 'item', 1, ctx),
  };
  if (typeof info._postman_id === 'string') bundle.uid = info._postman_id;
  return bundle;
}

function run(input: string | object, options: ParseCollectionOptions): ParseCollectionResult {
  const w = new WarningCollector();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const progress = { onProgress: options.onProgress };

  emit(progress, 'Parsing', 0, 1);
  const doc = parseJsonInput(input, maxBytes, w);
  emit(progress, 'Parsing', 1, 1);

  emit(progress, 'Validating', 0, 1);
  const format = validateCollection(doc, w);
  const doc2 = doc as JsonObject;
  const counts = countItems(doc2.item as unknown[], maxItems, maxDepth, w);
  emit(progress, 'Validating', 1, 1);

  const stats: ImportStats = { folders: 0, requests: 0, variables: 0, scripts: 0, examples: 0 };
  const ctx: Ctx = { w, stats, maxDepth, totalRequests: counts.requests, doneRequests: 0, onProgress: options.onProgress };
  emit(ctx, 'Importing', 0, counts.requests);
  const bundle = convertCollection(doc2, format, ctx);
  emit(ctx, 'Importing', ctx.doneRequests, counts.requests);

  emit(progress, 'Finalizing', 0, 1);
  const warnings = w.toArray();
  emit(progress, 'Finalizing', 1, 1);
  return { bundle, warnings, stats, format };
}

/**
 * Convert a Postman Collection v2.0/v2.1 document (JSON text or parsed object)
 * into the portable {@link CollectionBundle}. Synchronous; reports progress via
 * `options.onProgress`. Throws `AppError` (`IMPORT_INVALID`, `IMPORT_TOO_LARGE`).
 */
export function parsePostmanCollection(input: string | object, options: ParseCollectionOptions = {}): ParseCollectionResult {
  try {
    return run(input, options);
  } catch (e) {
    if (e instanceof RangeError) throw new AppError('IMPORT_INVALID', 'The document is nested too deeply to import.', {}, { cause: e });
    throw e;
  }
}
