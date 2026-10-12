import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { like } from 'drizzle-orm';
import {
  AppError,
  newId,
  type AuthConfig,
  type Collection,
  type CollectionBundle,
  type FindReplaceResult,
  type FindReplaceScope,
  type Folder,
  type FolderNode,
  type ImportProgress,
  type ImportStats,
  type ItemNode,
  type KeyValueEntry,
  type RequestDraft,
  type RequestModel,
  type ScriptEntry,
  type VariableEntry,
} from '@aegis/core';
import { isSecretRef } from '@aegis/security';
import type { DbHandle } from '../database';
import {
  collections,
  folders,
  requestAuth,
  requestBodies,
  requestExamples,
  requestHeaders,
  requestPathVariables,
  requestQueryParams,
  requestScripts,
  requests,
  environments,
} from '../schema';
import type { SecretMode, SecretVault } from '../vault';
import { chunk, likePattern, parseAuth, parseJson, parseScripts, toJson } from './common';
import type { VariableStores } from './variables';

type RequestRow = typeof requests.$inferSelect;
type FolderRow = typeof folders.$inferSelect;
type CollectionRow = typeof collections.$inferSelect;

export interface TreeRow {
  id: string;
  kind: 'folder' | 'request';
  collectionId: string;
  parentId: string | null;
  name: string;
  method?: string;
  sortOrder: number;
}

export interface SearchHit {
  kind: 'collection' | 'folder' | 'request' | 'environment' | 'variable';
  id: string;
  name: string;
  subtitle: string;
  collectionId?: string;
  method?: string;
}

export interface CollectionInput {
  name: string;
  description?: string;
  uid?: string;
  postmanSchemaVersion?: string | null;
  sourceMetadata?: Record<string, unknown>;
  auth?: AuthConfig;
  scripts?: ScriptEntry[];
}

export interface FolderInput {
  name: string;
  description?: string;
  auth?: AuthConfig;
  scripts?: ScriptEntry[];
  metadata?: Record<string, unknown>;
}

export interface InsertBundleResult {
  collectionId: string;
  stats: ImportStats;
}

/** Text substitution used by find & replace. Built by the application layer (literal or regular expression). */
export interface TextReplacer {
  /** Number of matches in `text`. */
  count(text: string): number;
  /** `text` with every match replaced. */
  apply(text: string): string;
  /** Offset of the first match (for excerpts); -1 when there is none. */
  firstIndex(text: string): number;
}

export interface FindReplaceOptions {
  scopes: readonly FindReplaceScope[];
  replacer: TextReplacer;
  /** `false` = count only, write nothing. */
  apply: boolean;
  /** Receives one before/after excerpt per matched field until `maxSamples` is reached (default 25). */
  maxSamples?: number;
}

/** Characters of context kept on each side of the first match in a sample. */
const SAMPLE_CONTEXT = 60;

export function emptyFindReplaceResult(apply: boolean): FindReplaceResult {
  return {
    matches: 0,
    requests: 0,
    folders: 0,
    variables: 0,
    collection: false,
    collections: 0,
    byScope: { url: 0, params: 0, headers: 0, body: 0, scripts: 0, descriptions: 0, variables: 0 },
    samples: [],
    summary: '0 matches',
    applied: apply,
  };
}

/** `12 matches in 4 requests, 1 folder and 2 variables`. */
export function summarizeFindReplace(r: Pick<FindReplaceResult, 'matches' | 'requests' | 'folders' | 'variables' | 'collection' | 'collections'>): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  if (r.matches === 0) return '0 matches';
  const parts: string[] = [];
  if (r.requests) parts.push(n(r.requests, 'request'));
  if (r.folders) parts.push(n(r.folders, 'folder'));
  if (r.variables) parts.push(n(r.variables, 'variable'));
  if (r.collection) parts.push(r.collections > 1 ? `${r.collections} collection descriptions/scripts` : 'the collection description/scripts');
  const where = parts.length === 0 ? '' : parts.length === 1 ? ` in ${parts[0]}` : ` in ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${n(r.matches, 'match', 'matches')}${where}`;
}

/** Merge per-collection results (workspace-wide run). */
export function mergeFindReplaceResults(results: readonly FindReplaceResult[], apply: boolean, maxSamples = 25): FindReplaceResult {
  const out = emptyFindReplaceResult(apply);
  for (const r of results) {
    out.matches += r.matches;
    out.requests += r.requests;
    out.folders += r.folders;
    out.variables += r.variables;
    out.collection = out.collection || r.collection;
    out.collections += r.matches > 0 ? 1 : 0;
    for (const k of Object.keys(out.byScope) as FindReplaceScope[]) out.byScope[k] += r.byScope[k];
    for (const s of r.samples) if (out.samples.length < maxSamples) out.samples.push(s);
  }
  out.summary = summarizeFindReplace(out);
  return out;
}

function excerpt(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SAMPLE_CONTEXT);
  const end = Math.min(text.length, at + Math.max(length, 1) + SAMPLE_CONTEXT);
  const middle = text.slice(start, end).replace(/\s+/g, ' ');
  return `${start > 0 ? '…' : ''}${middle}${end < text.length ? '…' : ''}`;
}

const KV_TABLES = [requestHeaders, requestQueryParams, requestPathVariables] as const;

export class CollectionRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly vault: SecretVault,
    private readonly vars: VariableStores,
    private readonly now: () => string,
  ) {}

  // ---------------------------------------------------------------- collections

  private toCollection(r: CollectionRow, mode: SecretMode): Collection {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      description: r.description,
      uid: r.uid,
      sortOrder: r.sortOrder,
      postmanSchemaVersion: r.postmanSchemaVersion,
      sourceMetadata: parseJson(r.sourceMetadataJson, {}),
      auth: this.vault.openAuth(parseAuth(r.authJson, 'none'), mode),
      scripts: parseScripts(r.scriptsJson),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  listCollections(workspaceId: string): Collection[] {
    return this.db
      .select()
      .from(collections)
      .where(eq(collections.workspaceId, workspaceId))
      .orderBy(asc(collections.sortOrder), asc(collections.name))
      .all()
      .map((r) => this.toCollection(r, 'refs'));
  }

  getCollection(id: string, mode: SecretMode = 'refs'): Collection | null {
    const r = this.db.select().from(collections).where(eq(collections.id, id)).get();
    return r ? this.toCollection(r, mode) : null;
  }

  requireCollection(id: string, mode: SecretMode = 'refs'): Collection {
    const c = this.getCollection(id, mode);
    if (!c) throw new AppError('NOT_FOUND', 'Collection not found.', { id });
    return c;
  }

  createCollection(workspaceId: string, input: CollectionInput): Collection {
    const id = newId();
    const ts = this.now();
    const max = this.db
      .select({ m: sql<number>`coalesce(max(${collections.sortOrder}), -1)` })
      .from(collections)
      .where(eq(collections.workspaceId, workspaceId))
      .get();
    const auth = this.vault.sealAuth(input.auth ?? { type: 'none', params: {} }, `c:${id}`);
    this.db
      .insert(collections)
      .values({
        id,
        workspaceId,
        name: input.name,
        description: input.description ?? '',
        uid: input.uid ?? newId(),
        sortOrder: (max?.m ?? -1) + 1,
        postmanSchemaVersion: input.postmanSchemaVersion ?? null,
        sourceMetadataJson: toJson(input.sourceMetadata ?? {}),
        authJson: toJson(auth),
        scriptsJson: toJson(input.scripts ?? []),
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return this.requireCollection(id);
  }

  updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'auth' | 'scripts'>>): Collection {
    this.requireCollection(id);
    const set: Partial<typeof collections.$inferInsert> = { updatedAt: this.now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.auth !== undefined) set.authJson = toJson(this.vault.sealAuth(patch.auth, `c:${id}`));
    if (patch.scripts !== undefined) set.scriptsJson = toJson(patch.scripts);
    this.db.update(collections).set(set).where(eq(collections.id, id)).run();
    return this.requireCollection(id);
  }

  reorderCollections(workspaceId: string, orderedIds: readonly string[]): void {
    orderedIds.forEach((id, i) => {
      this.db
        .update(collections)
        .set({ sortOrder: i })
        .where(and(eq(collections.id, id), eq(collections.workspaceId, workspaceId)))
        .run();
    });
  }

  deleteCollection(id: string): void {
    this.purgeCollectionSecrets(id);
    this.db.delete(collections).where(eq(collections.id, id)).run();
  }

  /** Remove credentials belonging to a collection and everything inside it (they would otherwise be orphaned). */
  purgeCollectionSecrets(collectionId: string): void {
    const reqIds = this.db.select({ id: requests.id }).from(requests).where(eq(requests.collectionId, collectionId)).all();
    for (const r of reqIds) this.vault.deleteAuth(r.id);
    const folderIds = this.db.select({ id: folders.id }).from(folders).where(eq(folders.collectionId, collectionId)).all();
    for (const f of folderIds) this.vault.deleteAuth(`f:${f.id}`);
    this.vars.folder.purgeSecretsFor(folderIds.map((f) => f.id));
    this.vars.collection.purgeSecretsFor([collectionId]);
    this.vault.deleteAuth(`c:${collectionId}`);
  }

  // -------------------------------------------------------------------- folders

  private toFolder(r: FolderRow, mode: SecretMode): Folder {
    return {
      id: r.id,
      collectionId: r.collectionId,
      parentFolderId: r.parentFolderId,
      name: r.name,
      description: r.description,
      sortOrder: r.sortOrder,
      auth: this.vault.openAuth(parseAuth(r.authJson, 'inherit'), mode),
      scripts: parseScripts(r.scriptsJson),
      metadata: parseJson(r.metadataJson, {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  getFolder(id: string, mode: SecretMode = 'refs'): Folder | null {
    const r = this.db.select().from(folders).where(eq(folders.id, id)).get();
    return r ? this.toFolder(r, mode) : null;
  }

  requireFolder(id: string, mode: SecretMode = 'refs'): Folder {
    const f = this.getFolder(id, mode);
    if (!f) throw new AppError('NOT_FOUND', 'Folder not found.', { id });
    return f;
  }

  listFolders(collectionId: string, mode: SecretMode = 'refs'): Folder[] {
    return this.db
      .select()
      .from(folders)
      .where(eq(folders.collectionId, collectionId))
      .orderBy(asc(folders.sortOrder))
      .all()
      .map((r) => this.toFolder(r, mode));
  }

  /** Next free `sort_order` among the children (folders + requests) of a parent. */
  private nextSortOrder(collectionId: string, parentFolderId: string | null): number {
    const f = this.db
      .select({ m: sql<number>`coalesce(max(${folders.sortOrder}), -1)` })
      .from(folders)
      .where(and(eq(folders.collectionId, collectionId), parentFolderId === null ? isNull(folders.parentFolderId) : eq(folders.parentFolderId, parentFolderId)))
      .get();
    const r = this.db
      .select({ m: sql<number>`coalesce(max(${requests.sortOrder}), -1)` })
      .from(requests)
      .where(and(eq(requests.collectionId, collectionId), parentFolderId === null ? isNull(requests.folderId) : eq(requests.folderId, parentFolderId)))
      .get();
    return Math.max(f?.m ?? -1, r?.m ?? -1) + 1;
  }

  createFolder(collectionId: string, parentFolderId: string | null, input: FolderInput, sortOrder?: number): Folder {
    this.requireCollection(collectionId);
    if (parentFolderId) {
      const parent = this.requireFolder(parentFolderId);
      if (parent.collectionId !== collectionId) throw new AppError('VALIDATION_FAILED', 'Parent folder belongs to a different collection.');
    }
    const id = newId();
    const ts = this.now();
    const auth = this.vault.sealAuth(input.auth ?? { type: 'inherit', params: {} }, `f:${id}`);
    this.db
      .insert(folders)
      .values({
        id,
        collectionId,
        parentFolderId,
        name: input.name,
        description: input.description ?? '',
        sortOrder: sortOrder ?? this.nextSortOrder(collectionId, parentFolderId),
        authJson: toJson(auth),
        scriptsJson: toJson(input.scripts ?? []),
        metadataJson: toJson(input.metadata ?? {}),
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return this.requireFolder(id);
  }

  updateFolder(id: string, patch: Partial<Pick<Folder, 'name' | 'description' | 'auth' | 'scripts'>>): Folder {
    this.requireFolder(id);
    const set: Partial<typeof folders.$inferInsert> = { updatedAt: this.now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.auth !== undefined) set.authJson = toJson(this.vault.sealAuth(patch.auth, `f:${id}`));
    if (patch.scripts !== undefined) set.scriptsJson = toJson(patch.scripts);
    this.db.update(folders).set(set).where(eq(folders.id, id)).run();
    return this.requireFolder(id);
  }

  /** All descendant folder ids (including `id`). */
  private descendantFolderIds(id: string): string[] {
    const out: string[] = [];
    const queue = [id];
    while (queue.length) {
      const current = queue.shift()!;
      out.push(current);
      const kids = this.db.select({ id: folders.id }).from(folders).where(eq(folders.parentFolderId, current)).all();
      for (const k of kids) queue.push(k.id);
    }
    return out;
  }

  deleteFolder(id: string): void {
    const folder = this.requireFolder(id);
    const folderIds = this.descendantFolderIds(id);
    for (const part of chunk(folderIds)) {
      const reqIds = this.db.select({ id: requests.id }).from(requests).where(inArray(requests.folderId, part)).all();
      for (const r of reqIds) this.vault.deleteAuth(r.id);
    }
    for (const fid of folderIds) this.vault.deleteAuth(`f:${fid}`);
    this.vars.folder.purgeSecretsFor(folderIds);
    this.db.delete(folders).where(eq(folders.id, folder.id)).run();
  }

  /** Folder ancestry for `folderId`, INNERMOST first. */
  getFolderChain(folderId: string | null, mode: SecretMode = 'resolve'): Folder[] {
    const chain: Folder[] = [];
    let current = folderId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const f = this.getFolder(current, mode);
      if (!f) break;
      chain.push(f);
      current = f.parentFolderId;
    }
    return chain;
  }

  // ------------------------------------------------------------------- requests

  private hydrate(rows: RequestRow[], mode: SecretMode): RequestModel[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const kv: Array<Map<string, KeyValueEntry[]>> = KV_TABLES.map(() => new Map());
    const bodies = new Map<string, typeof requestBodies.$inferSelect>();
    const auths = new Map<string, typeof requestAuth.$inferSelect>();
    const scripts = new Map<string, ScriptEntry[]>();
    const examples = new Map<string, Array<typeof requestExamples.$inferSelect>>();

    for (const part of chunk(ids)) {
      KV_TABLES.forEach((table, i) => {
        const rowsKv = this.db.select().from(table).where(inArray(table.requestId, part)).orderBy(asc(table.sortOrder)).all();
        for (const r of rowsKv) {
          const list = kv[i]!.get(r.requestId) ?? [];
          const entry: KeyValueEntry = { key: r.key, value: r.value, enabled: r.enabled };
          if (r.description) entry.description = r.description;
          list.push(entry);
          kv[i]!.set(r.requestId, list);
        }
      });
      for (const b of this.db.select().from(requestBodies).where(inArray(requestBodies.requestId, part)).all()) bodies.set(b.requestId, b);
      for (const a of this.db.select().from(requestAuth).where(inArray(requestAuth.requestId, part)).all()) auths.set(a.requestId, a);
      for (const s of this.db.select().from(requestScripts).where(inArray(requestScripts.requestId, part)).orderBy(asc(requestScripts.sortOrder)).all()) {
        const list = scripts.get(s.requestId) ?? [];
        list.push({ type: s.scriptType as ScriptEntry['type'], language: 'javascript', source: s.source, enabled: s.enabled });
        scripts.set(s.requestId, list);
      }
      for (const e of this.db.select().from(requestExamples).where(inArray(requestExamples.requestId, part)).orderBy(asc(requestExamples.sortOrder)).all()) {
        const list = examples.get(e.requestId) ?? [];
        list.push(e);
        examples.set(e.requestId, list);
      }
    }

    return rows.map((r) => {
      const b = bodies.get(r.id);
      const a = auths.get(r.id);
      return {
        id: r.id,
        collectionId: r.collectionId,
        folderId: r.folderId,
        name: r.name,
        description: r.description,
        method: r.method,
        url: r.url,
        sortOrder: r.sortOrder,
        headers: kv[0]!.get(r.id) ?? [],
        queryParams: kv[1]!.get(r.id) ?? [],
        pathVariables: kv[2]!.get(r.id) ?? [],
        body: b
          ? {
              mode: b.mode as RequestDraft['body']['mode'],
              // GraphQL bodies store `{query, variables, operationName}` JSON in raw_content (no schema change needed).
              ...(b.rawContent !== null && b.mode !== 'graphql' ? { raw: b.rawContent } : {}),
              ...(b.mode === 'graphql' ? { graphql: parseJson(b.rawContent ?? '', { query: '', variables: '' }) } : {}),
              ...(b.rawLanguage ? { rawLanguage: b.rawLanguage as NonNullable<RequestDraft['body']['rawLanguage']> } : {}),
              ...(b.contentType ? { contentType: b.contentType } : {}),
              ...(b.filePath ? { filePath: b.filePath } : {}),
              ...(b.formDataJson ? { formData: parseJson(b.formDataJson, []) } : {}),
              ...(b.urlencodedJson ? { urlencoded: parseJson(b.urlencodedJson, []) } : {}),
            }
          : { mode: 'none' as const },
        auth: a ? this.vault.openAuth({ type: a.authType as AuthConfig['type'], params: parseJson(a.configurationJson, {}) }, mode) : { type: 'inherit' as const, params: {} },
        scripts: scripts.get(r.id) ?? [],
        examples: (examples.get(r.id) ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          status: e.status,
          code: e.code,
          headers: parseJson<KeyValueEntry[]>(e.headersJson, []),
          body: e.body,
          ...(e.language ? { language: e.language } : {}),
          ...(e.originalRequestJson ? { originalRequest: parseJson<unknown>(e.originalRequestJson, null) } : {}),
          metadata: parseJson<Record<string, unknown>>(e.metadataJson, {}),
        })),
        settings: parseJson(r.settingsJson, {}),
        metadata: parseJson(r.metadataJson, {}),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  getRequest(id: string, mode: SecretMode = 'refs'): RequestModel | null {
    const row = this.db.select().from(requests).where(eq(requests.id, id)).get();
    return row ? this.hydrate([row], mode)[0]! : null;
  }

  requireRequest(id: string, mode: SecretMode = 'refs'): RequestModel {
    const r = this.getRequest(id, mode);
    if (!r) throw new AppError('NOT_FOUND', 'Request not found.', { id });
    return r;
  }

  listRequests(collectionId: string, mode: SecretMode = 'refs'): RequestModel[] {
    const rows = this.db.select().from(requests).where(eq(requests.collectionId, collectionId)).orderBy(asc(requests.sortOrder)).all();
    return this.hydrate(rows, mode);
  }

  private writeChildren(requestId: string, draft: RequestDraft, ownerKey: string): void {
    const kvRows = (list: readonly KeyValueEntry[]) =>
      list.map((e, i) => ({ id: newId(), requestId, key: e.key, value: e.value, description: e.description ?? '', enabled: e.enabled, sortOrder: i }));
    const headers = kvRows(draft.headers);
    const query = kvRows(draft.queryParams);
    const path = kvRows(draft.pathVariables);
    if (headers.length) this.db.insert(requestHeaders).values(headers).run();
    if (query.length) this.db.insert(requestQueryParams).values(query).run();
    if (path.length) this.db.insert(requestPathVariables).values(path).run();

    const b = draft.body;
    if (b.mode !== 'none' || b.raw !== undefined) {
      this.db
        .insert(requestBodies)
        .values({
          id: newId(),
          requestId,
          mode: b.mode,
          rawContent: b.mode === 'graphql' ? toJson(b.graphql ?? { query: '', variables: '' }) : (b.raw ?? null),
          rawLanguage: b.rawLanguage ?? null,
          contentType: b.contentType ?? null,
          filePath: b.filePath ?? null,
          formDataJson: b.formData ? toJson(b.formData) : null,
          urlencodedJson: b.urlencoded ? toJson(b.urlencoded) : null,
        })
        .run();
    }

    if (draft.auth.type !== 'inherit' || Object.keys(draft.auth.params).length > 0) {
      const sealed = this.vault.sealAuth(draft.auth, ownerKey);
      this.db.insert(requestAuth).values({ id: newId(), requestId, authType: sealed.type, configurationJson: toJson(sealed.params) }).run();
    }

    if (draft.scripts.length) {
      this.db
        .insert(requestScripts)
        .values(draft.scripts.map((s, i) => ({ id: newId(), requestId, scriptType: s.type, language: s.language, source: s.source, enabled: s.enabled, sortOrder: i })))
        .run();
    }
    if (draft.examples.length) {
      this.db
        .insert(requestExamples)
        .values(
          draft.examples.map((e, i) => ({
            id: newId(),
            requestId,
            name: e.name,
            status: e.status,
            code: e.code,
            headersJson: toJson(e.headers),
            body: e.body,
            language: e.language ?? null,
            originalRequestJson: e.originalRequest === undefined ? null : toJson(e.originalRequest),
            metadataJson: toJson(e.metadata ?? {}),
            sortOrder: i,
          })),
        )
        .run();
    }
  }

  private deleteChildren(requestId: string): void {
    for (const t of KV_TABLES) this.db.delete(t).where(eq(t.requestId, requestId)).run();
    this.db.delete(requestBodies).where(eq(requestBodies.requestId, requestId)).run();
    this.db.delete(requestAuth).where(eq(requestAuth.requestId, requestId)).run();
    this.db.delete(requestScripts).where(eq(requestScripts.requestId, requestId)).run();
    this.db.delete(requestExamples).where(eq(requestExamples.requestId, requestId)).run();
  }

  createRequest(collectionId: string, folderId: string | null, draft: RequestDraft, sortOrder?: number): RequestModel {
    this.requireCollection(collectionId);
    if (folderId) {
      const folder = this.requireFolder(folderId);
      if (folder.collectionId !== collectionId) throw new AppError('VALIDATION_FAILED', 'Folder belongs to a different collection.');
    }
    const id = newId();
    const ts = this.now();
    this.db
      .insert(requests)
      .values({
        id,
        collectionId,
        folderId,
        name: draft.name,
        description: draft.description,
        method: draft.method,
        url: draft.url,
        sortOrder: sortOrder ?? this.nextSortOrder(collectionId, folderId),
        settingsJson: toJson(draft.settings),
        metadataJson: toJson(draft.metadata),
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    this.writeChildren(id, draft, id);
    return this.requireRequest(id);
  }

  updateRequest(id: string, draft: RequestDraft): RequestModel {
    this.requireRequest(id);
    this.db
      .update(requests)
      .set({
        name: draft.name,
        description: draft.description,
        method: draft.method,
        url: draft.url,
        settingsJson: toJson(draft.settings),
        metadataJson: toJson(draft.metadata),
        updatedAt: this.now(),
      })
      .where(eq(requests.id, id))
      .run();
    // Secret refs inside draft.auth are resolved by sealAuth BEFORE the old rows/secrets are removed.
    const sealedAuth = this.vault.sealAuth(draft.auth, id);
    this.deleteChildren(id);
    this.writeChildren(id, { ...draft, auth: sealedAuth }, id);
    return this.requireRequest(id);
  }

  deleteRequest(id: string): void {
    this.vault.deleteAuth(id);
    this.db.delete(requests).where(eq(requests.id, id)).run();
  }

  duplicateRequest(id: string): RequestModel {
    const src = this.requireRequest(id, 'resolve');
    const { id: _id, collectionId, folderId, sortOrder: _s, createdAt: _c, updatedAt: _u, ...draft } = src;
    return this.createRequest(collectionId, folderId, { ...draft, name: `${src.name} Copy` });
  }

  // ----------------------------------------------------------------------- tree

  /** Flat, lightweight rows for the whole collection tree (cheap even for 10k+ requests). */
  getTreeRows(collectionId: string): TreeRow[] {
    const f = this.db
      .select({ id: folders.id, parentId: folders.parentFolderId, name: folders.name, sortOrder: folders.sortOrder })
      .from(folders)
      .where(eq(folders.collectionId, collectionId))
      .all()
      .map((r): TreeRow => ({ id: r.id, kind: 'folder', collectionId, parentId: r.parentId, name: r.name, sortOrder: r.sortOrder }));
    const r = this.db
      .select({ id: requests.id, parentId: requests.folderId, name: requests.name, method: requests.method, sortOrder: requests.sortOrder })
      .from(requests)
      .where(eq(requests.collectionId, collectionId))
      .all()
      .map((x): TreeRow => ({ id: x.id, kind: 'request', collectionId, parentId: x.parentId, name: x.name, method: x.method, sortOrder: x.sortOrder }));
    return [...f, ...r].sort((a, b) => a.sortOrder - b.sortOrder || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1));
  }

  /**
   * Move a folder or request into `targetParentId` (null = collection root) at
   * position `index` among the target's children. Re-numbers siblings.
   */
  move(kind: 'folder' | 'request', id: string, targetParentId: string | null, index: number): void {
    const item = kind === 'folder' ? this.requireFolder(id) : this.requireRequest(id);
    const collectionId = item.collectionId;
    if (targetParentId) {
      const target = this.requireFolder(targetParentId);
      if (target.collectionId !== collectionId) throw new AppError('VALIDATION_FAILED', 'Cannot move between collections here. Use moveToCollection.');
      if (kind === 'folder' && this.descendantFolderIds(id).includes(targetParentId)) {
        throw new AppError('VALIDATION_FAILED', 'A folder cannot be moved into itself or its descendants.');
      }
    }
    const siblings = this.getTreeRows(collectionId)
      .filter((r) => r.parentId === targetParentId && !(r.kind === kind && r.id === id));
    const clamped = Math.max(0, Math.min(index, siblings.length));
    siblings.splice(clamped, 0, { id, kind, collectionId, parentId: targetParentId, name: '', sortOrder: 0 });
    siblings.forEach((s, i) => {
      if (s.kind === 'folder') {
        this.db.update(folders).set(s.id === id && kind === 'folder' ? { parentFolderId: targetParentId, sortOrder: i, updatedAt: this.now() } : { sortOrder: i }).where(eq(folders.id, s.id)).run();
      } else {
        this.db.update(requests).set(s.id === id && kind === 'request' ? { folderId: targetParentId, sortOrder: i, updatedAt: this.now() } : { sortOrder: i }).where(eq(requests.id, s.id)).run();
      }
    });
  }

  /**
   * Move a folder (with its whole subtree) or a request into `targetCollectionId`, under
   * `targetParentId` (null = root) at `index`. Folder variables, scripts and vaulted auth
   * travel with their owner because they are keyed by folder/request id, not by collection.
   * Call inside a transaction.
   */
  moveToCollection(kind: 'folder' | 'request', id: string, targetCollectionId: string, targetParentId: string | null, index: number): void {
    this.requireCollection(targetCollectionId);
    const item = kind === 'folder' ? this.requireFolder(id) : this.requireRequest(id);
    if (item.collectionId === targetCollectionId) {
      this.move(kind, id, targetParentId, index);
      return;
    }
    if (targetParentId) {
      const target = this.requireFolder(targetParentId);
      if (target.collectionId !== targetCollectionId) throw new AppError('VALIDATION_FAILED', 'The target folder belongs to a different collection.');
      if (kind === 'folder' && this.descendantFolderIds(id).includes(targetParentId)) {
        throw new AppError('VALIDATION_FAILED', 'A folder cannot be moved into itself or its descendants.');
      }
    }
    const ts = this.now();
    if (kind === 'folder') {
      for (const part of chunk(this.descendantFolderIds(id))) {
        this.db.update(folders).set({ collectionId: targetCollectionId, updatedAt: ts }).where(inArray(folders.id, part)).run();
        this.db.update(requests).set({ collectionId: targetCollectionId, updatedAt: ts }).where(inArray(requests.folderId, part)).run();
      }
      this.db.update(folders).set({ parentFolderId: targetParentId }).where(eq(folders.id, id)).run();
    } else {
      this.db.update(requests).set({ collectionId: targetCollectionId, folderId: targetParentId, updatedAt: ts }).where(eq(requests.id, id)).run();
    }
    // Re-number the siblings in the new parent.
    this.move(kind, id, targetParentId, index);
  }

  // ------------------------------------------------------------- find & replace

  /**
   * Find & replace across one collection. Secret references (`secretref:`) and secret variables are
   * never read or written; auth parameters are out of scope by design. Call inside a transaction
   * when `apply` is true so a failure halfway rolls everything back.
   */
  findReplace(collectionId: string, options: FindReplaceOptions): FindReplaceResult {
    const collection = this.requireCollection(collectionId);
    const scopes = new Set(options.scopes);
    const { replacer, apply } = options;
    const maxSamples = options.maxSamples ?? 25;
    const result = emptyFindReplaceResult(apply);

    let entityMatches = 0;
    /**
     * Substitute inside one field. Empty strings and `secretref:` values are left untouched and never
     * counted; the replaced text is always computed (it is pure) so the preview can show an excerpt.
     */
    const tx = (text: string, scope: FindReplaceScope, location: string): string => {
      if (text === '' || isSecretRef(text)) return text;
      const n = replacer.count(text);
      if (n === 0) return text;
      entityMatches += n;
      result.byScope[scope] += n;
      const replaced = replacer.apply(text);
      if (result.samples.length < maxSamples) {
        const at = Math.max(0, replacer.firstIndex(text));
        result.samples.push({ location, before: excerpt(text, at, 1), after: excerpt(replaced, at, 1) });
      }
      return apply ? replaced : text;
    };
    const kv = (list: readonly KeyValueEntry[], scope: FindReplaceScope, location: string): KeyValueEntry[] =>
      list.map((e) => ({
        ...e,
        key: tx(e.key, scope, `${location} › ${e.key || '(empty key)'}`),
        value: tx(e.value, scope, `${location} › ${e.key || '(empty key)'}`),
        ...(e.description !== undefined && scopes.has('descriptions') ? { description: tx(e.description, 'descriptions', `${location} › ${e.key} description`) } : {}),
      }));
    const scripts = (list: readonly ScriptEntry[], location: string): ScriptEntry[] =>
      list.map((s) => ({ ...s, source: tx(s.source, 'scripts', `${location} › ${s.type === 'prerequest' ? 'pre-request script' : 'tests'}`) }));
    const variables = (ownerId: string, location: string, store: { list(id: string, mode: SecretMode): VariableEntry[]; replaceAll(id: string, entries: readonly VariableEntry[]): VariableEntry[] }): void => {
      if (!scopes.has('variables')) return;
      const entries = store.list(ownerId, 'refs');
      let touched = 0;
      const next = entries.map((v) => {
        // Secret variables are never read, counted or written.
        if (v.isSecret) return v;
        const before = entityMatches;
        const out: VariableEntry = { ...v, initialValue: tx(v.initialValue, 'variables', `${location} › variable ${v.key}`) };
        if (v.currentValue !== undefined) out.currentValue = tx(v.currentValue, 'variables', `${location} › variable ${v.key} (current)`);
        if (entityMatches > before) touched += 1;
        return out;
      });
      if (touched > 0) {
        result.variables += touched;
        if (apply) store.replaceAll(ownerId, next);
      }
    };

    // Collection level
    const colLoc = `Collection "${collection.name}"`;
    entityMatches = 0;
    const colPatch: Partial<Pick<Collection, 'description' | 'scripts'>> = {};
    if (scopes.has('descriptions')) colPatch.description = tx(collection.description, 'descriptions', `${colLoc} › description`);
    if (scopes.has('scripts')) colPatch.scripts = scripts(collection.scripts, colLoc);
    if (entityMatches > 0) {
      result.matches += entityMatches;
      result.collection = true;
      if (apply) this.updateCollection(collectionId, colPatch);
    }
    entityMatches = 0;
    variables(collectionId, colLoc, this.vars.collection);
    result.matches += entityMatches;

    // Folders
    for (const folder of this.listFolders(collectionId, 'refs')) {
      const loc = `Folder "${folder.name}"`;
      entityMatches = 0;
      const patch: Partial<Pick<Folder, 'description' | 'scripts'>> = {};
      if (scopes.has('descriptions')) patch.description = tx(folder.description, 'descriptions', `${loc} › description`);
      if (scopes.has('scripts')) patch.scripts = scripts(folder.scripts, loc);
      if (entityMatches > 0) {
        result.matches += entityMatches;
        result.folders += 1;
        if (apply) this.updateFolder(folder.id, patch);
      }
      entityMatches = 0;
      variables(folder.id, loc, this.vars.folder);
      result.matches += entityMatches;
    }

    // Requests. Auth is carried over untouched (credentials are never part of a replace).
    for (const req of this.listRequests(collectionId, 'refs')) {
      const loc = `Request "${req.name}"`;
      entityMatches = 0;
      const { id, collectionId: _c, folderId: _f, sortOrder: _s, createdAt: _ca, updatedAt: _ua, ...draft } = req;
      const next: RequestDraft = { ...draft };
      if (scopes.has('url')) next.url = tx(req.url, 'url', `${loc} › url`);
      if (scopes.has('params')) {
        next.queryParams = kv(req.queryParams, 'params', `${loc} › query`);
        next.pathVariables = kv(req.pathVariables, 'params', `${loc} › path variable`);
      }
      if (scopes.has('headers')) next.headers = kv(req.headers, 'headers', `${loc} › header`);
      if (scopes.has('body')) {
        next.body = {
          ...req.body,
          ...(req.body.raw !== undefined ? { raw: tx(req.body.raw, 'body', `${loc} › body`) } : {}),
          ...(req.body.graphql ? { graphql: { ...req.body.graphql, query: tx(req.body.graphql.query, 'body', `${loc} › GraphQL query`), variables: tx(req.body.graphql.variables, 'body', `${loc} › GraphQL variables`) } } : {}),
          ...(req.body.urlencoded ? { urlencoded: kv(req.body.urlencoded, 'body', `${loc} › form field`) } : {}),
          ...(req.body.formData
            ? { formData: req.body.formData.map((f) => (f.type === 'file' ? f : { ...f, key: tx(f.key, 'body', `${loc} › form field ${f.key}`), value: tx(f.value, 'body', `${loc} › form field ${f.key}`) })) }
            : {}),
        };
      }
      if (scopes.has('scripts')) next.scripts = scripts(req.scripts, loc);
      if (scopes.has('descriptions')) next.description = tx(req.description, 'descriptions', `${loc} › description`);
      if (entityMatches > 0) {
        result.matches += entityMatches;
        result.requests += 1;
        if (apply) this.updateRequest(id, next);
      }
    }
    result.collections = result.matches > 0 ? 1 : 0;
    result.summary = summarizeFindReplace(result);
    return result;
  }

  // -------------------------------------------------------------------- bundles

  /** A folder and everything below it as a portable node (ids stripped). */
  loadFolderNode(folderId: string, mode: SecretMode): FolderNode {
    const root = this.requireFolder(folderId, mode);
    const ids = new Set(this.descendantFolderIds(folderId));
    const folderList = this.listFolders(root.collectionId, mode).filter((f) => ids.has(f.id));
    const requestList = this.listRequests(root.collectionId, mode).filter((r) => r.folderId !== null && ids.has(r.folderId));
    const foldersByParent = new Map<string | null, Folder[]>();
    for (const f of folderList) foldersByParent.set(f.parentFolderId, [...(foldersByParent.get(f.parentFolderId) ?? []), f]);
    const requestsByParent = new Map<string | null, RequestModel[]>();
    for (const r of requestList) requestsByParent.set(r.folderId, [...(requestsByParent.get(r.folderId) ?? []), r]);
    const toNode = (f: Folder): FolderNode => {
      const entries: Array<{ sortOrder: number; make: () => ItemNode }> = [];
      for (const child of foldersByParent.get(f.id) ?? []) entries.push({ sortOrder: child.sortOrder, make: () => toNode(child) });
      for (const r of requestsByParent.get(f.id) ?? []) {
        const { id: _i, collectionId: _c, folderId: _f, sortOrder: _s, createdAt: _ca, updatedAt: _ua, ...draft } = r;
        entries.push({ sortOrder: r.sortOrder, make: () => ({ kind: 'request', request: draft }) });
      }
      return {
        kind: 'folder',
        name: f.name,
        description: f.description,
        auth: f.auth,
        scripts: f.scripts,
        variables: stripIds(this.vars.folder.list(f.id, mode)),
        metadata: f.metadata,
        items: entries.sort((a, b) => a.sortOrder - b.sortOrder).map((e) => e.make()),
      };
    };
    return toNode(root);
  }

  /** Deep copy of a folder placed right after its siblings. Secrets are re-vaulted for the new owners. Call inside a transaction. */
  duplicateFolder(id: string): string {
    const src = this.requireFolder(id);
    const node = this.loadFolderNode(id, 'resolve');
    const stats: ImportStats = { folders: 0, requests: 0, variables: 0, scripts: 0, examples: 0 };
    const created = this.insertFolderNode(src.collectionId, src.parentFolderId, { ...node, name: `${node.name} Copy` }, this.nextSortOrder(src.collectionId, src.parentFolderId), stats);
    return created.id;
  }

  private insertFolderNode(collectionId: string, parentFolderId: string | null, item: FolderNode, index: number, stats: ImportStats, progress?: { total: number; onProgress?: (p: ImportProgress) => void }): Folder {
    const folder = this.createFolder(collectionId, parentFolderId, item, index);
    stats.folders += 1;
    stats.scripts += item.scripts.filter((s) => s.source.trim()).length;
    if (item.variables.length) this.vars.folder.replaceAll(folder.id, item.variables);
    stats.variables += item.variables.length;
    this.insertItems(collectionId, item.items, folder.id, stats, progress);
    return folder;
  }

  private insertItems(collectionId: string, items: readonly ItemNode[], parentFolderId: string | null, stats: ImportStats, progress?: { total: number; onProgress?: (p: ImportProgress) => void }): void {
    items.forEach((item, index) => {
      if (item.kind === 'folder') {
        this.insertFolderNode(collectionId, parentFolderId, item, index, stats, progress);
      } else {
        this.createRequest(collectionId, parentFolderId, item.request, index);
        stats.requests += 1;
        stats.scripts += item.request.scripts.filter((s) => s.source.trim()).length;
        stats.examples += item.request.examples.length;
        if (progress && stats.requests % 50 === 0) progress.onProgress?.({ stage: 'Saving', current: stats.requests, total: progress.total });
      }
    });
  }

  /** Load a whole collection as a portable bundle (for export / duplicate / backup). */
  loadBundle(collectionId: string, mode: SecretMode): CollectionBundle {
    const collection = this.requireCollection(collectionId, mode);
    const folderList = this.listFolders(collectionId, mode);
    const folderVars = new Map(folderList.map((f) => [f.id, this.vars.folder.list(f.id, mode)] as const));
    const requestList = this.listRequests(collectionId, mode);

    const foldersByParent = new Map<string | null, Folder[]>();
    for (const f of folderList) foldersByParent.set(f.parentFolderId, [...(foldersByParent.get(f.parentFolderId) ?? []), f]);
    const requestsByParent = new Map<string | null, RequestModel[]>();
    for (const r of requestList) requestsByParent.set(r.folderId, [...(requestsByParent.get(r.folderId) ?? []), r]);

    const itemsOf = (parent: string | null): ItemNode[] => {
      const entries: Array<{ sortOrder: number; make: () => ItemNode }> = [];
      for (const f of foldersByParent.get(parent) ?? []) {
        entries.push({
          sortOrder: f.sortOrder,
          make: () => ({
            kind: 'folder',
            name: f.name,
            description: f.description,
            auth: f.auth,
            scripts: f.scripts,
            variables: stripIds(folderVars.get(f.id) ?? []),
            metadata: f.metadata,
            items: itemsOf(f.id),
          }),
        });
      }
      for (const r of requestsByParent.get(parent) ?? []) {
        const { id: _i, collectionId: _c, folderId: _f, sortOrder: _s, createdAt: _ca, updatedAt: _ua, ...draft } = r;
        entries.push({ sortOrder: r.sortOrder, make: () => ({ kind: 'request', request: draft }) });
      }
      return entries.sort((a, b) => a.sortOrder - b.sortOrder).map((e) => e.make());
    };

    return {
      name: collection.name,
      description: collection.description,
      uid: collection.uid,
      ...(collection.postmanSchemaVersion ? { postmanSchemaVersion: collection.postmanSchemaVersion } : {}),
      variables: stripIds(this.vars.collection.list(collectionId, mode)),
      auth: collection.auth,
      scripts: collection.scripts,
      sourceMetadata: collection.sourceMetadata,
      items: itemsOf(null),
    };
  }

  /** Insert a bundle as a new collection. Call inside a transaction for atomicity. */
  insertBundle(workspaceId: string, bundle: CollectionBundle, onProgress?: (p: ImportProgress) => void): InsertBundleResult {
    const stats: ImportStats = { folders: 0, requests: 0, variables: 0, scripts: 0, examples: 0 };
    const total = countRequests(bundle.items);
    const collection = this.createCollection(workspaceId, {
      name: bundle.name,
      description: bundle.description,
      ...(bundle.uid ? { uid: bundle.uid } : {}),
      postmanSchemaVersion: bundle.postmanSchemaVersion ?? null,
      sourceMetadata: bundle.sourceMetadata,
      auth: bundle.auth,
      scripts: bundle.scripts,
    });
    stats.scripts += bundle.scripts.filter((s) => s.source.trim()).length;
    this.vars.collection.replaceAll(collection.id, bundle.variables);
    stats.variables += bundle.variables.length;

    this.insertItems(collection.id, bundle.items, null, stats, { total, ...(onProgress ? { onProgress } : {}) });
    onProgress?.({ stage: 'Saving', current: stats.requests, total });
    return { collectionId: collection.id, stats };
  }

  duplicateCollection(id: string): string {
    const source = this.requireCollection(id);
    const bundle = this.loadBundle(id, 'resolve');
    const { uid: _uid, ...rest } = bundle;
    const result = this.insertBundle(source.workspaceId, { ...rest, name: `${bundle.name} Copy` });
    return result.collectionId;
  }

  // ---------------------------------------------------------------------- search

  search(workspaceId: string, term: string, limit = 50): SearchHit[] {
    const t = term.trim();
    if (!t) return [];
    const pattern = likePattern(t);
    const hits: SearchHit[] = [];
    const lk = (col: Parameters<typeof like>[0]) => sql`${col} like ${pattern} escape '\\'`;

    const cols = this.db
      .select()
      .from(collections)
      .where(and(eq(collections.workspaceId, workspaceId), or(lk(collections.name), lk(collections.description))))
      .limit(limit)
      .all();
    for (const c of cols) hits.push({ kind: 'collection', id: c.id, name: c.name, subtitle: 'Collection', collectionId: c.id });

    const fol = this.db
      .select({ id: folders.id, name: folders.name, collectionId: folders.collectionId, cname: collections.name })
      .from(folders)
      .innerJoin(collections, eq(collections.id, folders.collectionId))
      .where(and(eq(collections.workspaceId, workspaceId), or(lk(folders.name), lk(folders.description))))
      .limit(limit)
      .all();
    for (const f of fol) hits.push({ kind: 'folder', id: f.id, name: f.name, subtitle: `Folder in ${f.cname}`, collectionId: f.collectionId });

    const reqs = this.db
      .select({ id: requests.id, name: requests.name, url: requests.url, method: requests.method, collectionId: requests.collectionId, cname: collections.name })
      .from(requests)
      .innerJoin(collections, eq(collections.id, requests.collectionId))
      .where(and(eq(collections.workspaceId, workspaceId), or(lk(requests.name), lk(requests.url), lk(requests.description))))
      .limit(limit)
      .all();
    for (const r of reqs) hits.push({ kind: 'request', id: r.id, name: r.name, subtitle: `${r.url} — ${r.cname}`, collectionId: r.collectionId, method: r.method });

    const envs = this.db
      .select()
      .from(environments)
      .where(and(eq(environments.workspaceId, workspaceId), or(lk(environments.name), lk(environments.description))))
      .limit(limit)
      .all();
    for (const e of envs) hits.push({ kind: 'environment', id: e.id, name: e.name, subtitle: 'Environment' });

    return hits.slice(0, limit * 2);
  }
}

function stripIds<T extends { id?: string }>(entries: T[]): T[] {
  return entries.map((e) => {
    const { id: _id, ...rest } = e;
    return rest as T;
  });
}

export function countRequests(items: readonly ItemNode[]): number {
  let n = 0;
  for (const item of items) n += item.kind === 'request' ? 1 : countRequests(item.items);
  return n;
}
