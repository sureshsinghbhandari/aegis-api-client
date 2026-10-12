import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  BACKUP_HISTORY_LIMIT_DEFAULT,
  BACKUP_HISTORY_LIMIT_MAX,
  newId,
  toSerializedError,
  type AegisApi,
  type CollectionBundle,
  type ImportCommitResult,
  type ImportDocumentKind,
  type ImportPreview,
  type ImportSourceKind,
  type ImportStats,
  type ImportWarningModel,
  type VariableEntry,
} from '@aegis/core';
import { exportPostmanCollection, exportPostmanEnvironment, importDocument, serializePostmanJson, type ImportFormat, type ImportedDocuments } from '@aegis/postman';
import { decryptWithPassphrase, encryptWithPassphrase, isEncryptedEnvelope, sanitizeFileName } from '@aegis/security';
import type { AppContext } from '../context';
import type { Repositories } from '@aegis/storage';

const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const SESSION_TTL_MS = 15 * 60 * 1000;
const BACKUP_FORMAT = 'aegis-backup';

interface BackupWorkspace {
  name: string;
  description: string;
  collections: CollectionBundle[];
  environments: Array<{ name: string; description: string; isProduction: boolean; isActive: boolean; variables: VariableEntry[] }>;
  globals: VariableEntry[];
  history?: Array<{ method: string; url: string; statusCode: number | null; statusText: string | null; durationMs: number | null; createdAt: string; requestName: string | null; environmentName: string | null }>;
}

interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  includesHistory: boolean;
  /** Newest history rows per workspace that were included (only when `includesHistory`). */
  historyLimit?: number;
  includesSecrets: boolean;
  settings: { appearance: unknown; history: unknown };
  workspaces: BackupWorkspace[];
}

type Session =
  | { kind: 'documents'; fileName: string; docs: ImportedDocuments; warnings: ImportWarningModel[]; stats: ImportStats; at: number }
  | { kind: 'aegis-backup'; fileName: string; backup?: BackupFile; envelope?: unknown; warnings: ImportWarningModel[]; stats: ImportStats; at: number };

const ZERO: ImportStats = { folders: 0, requests: 0, variables: 0, scripts: 0, examples: 0 };

/** Which document families each user-facing import kind accepts (`auto` accepts everything). */
const EXPECTED: Record<Exclude<ImportSourceKind, 'backup' | 'auto'>, ImportFormat[]> = {
  'postman-collection': ['postman-collection', 'postman-v1'],
  'postman-environment': ['postman-environment', 'postman-globals'],
  openapi: ['openapi', 'swagger'],
  har: ['har'],
  insomnia: ['insomnia'],
  'postman-v1': ['postman-v1'],
  'postman-dump': ['postman-dump'],
  'aegis-workspace': ['aegis-workspace'],
};

const FILTERS: Record<ImportSourceKind, { title: string; filters: Array<{ name: string; extensions: string[] }> }> = {
  'postman-collection': { title: 'Import Postman collection', filters: [{ name: 'Postman collection (JSON)', extensions: ['json'] }] },
  'postman-environment': { title: 'Import Postman environment', filters: [{ name: 'Postman environment (JSON)', extensions: ['json'] }] },
  backup: { title: 'Restore backup', filters: [{ name: 'Aegis backup', extensions: ['json', 'aegisbackup'] }] },
  openapi: { title: 'Import OpenAPI / Swagger', filters: [{ name: 'OpenAPI 3.x / Swagger 2.0 (JSON, YAML)', extensions: ['json', 'yaml', 'yml'] }] },
  har: { title: 'Import HAR archive', filters: [{ name: 'HTTP Archive (HAR 1.2)', extensions: ['har', 'json'] }] },
  insomnia: { title: 'Import Insomnia export', filters: [{ name: 'Insomnia v4 export (JSON, YAML)', extensions: ['json', 'yaml', 'yml'] }] },
  'postman-v1': { title: 'Import Postman collection (v1)', filters: [{ name: 'Postman collection v1 (JSON)', extensions: ['json'] }] },
  'postman-dump': { title: 'Import Postman data dump', filters: [{ name: 'Postman data dump (JSON)', extensions: ['json'] }] },
  'aegis-workspace': { title: 'Import Aegis workspace', filters: [{ name: 'Aegis workspace file', extensions: ['json'] }] },
  auto: { title: 'Import (auto-detect format)', filters: [{ name: 'All supported files', extensions: ['json', 'yaml', 'yml', 'har'] }, { name: 'All files', extensions: ['*'] }] },
};

function countWarnings(w: ImportWarningModel[]) {
  const c = { INFO: 0, WARNING: 0, ERROR: 0 };
  for (const x of w) c[x.severity]++;
  return c;
}

/** `ImportedDocuments.format` and `ImportDocumentKind` share their names. */
function documentKind(docs: ImportedDocuments): ImportDocumentKind {
  return docs.format;
}

function uniqueName(existing: Set<string>, name: string, suffix: string): string {
  let out = name;
  for (let n = 1; existing.has(out); n++) out = n === 1 ? `${name} (${suffix})` : `${name} (${suffix} ${n})`;
  existing.add(out);
  return out;
}

export function createImportExportService(ctx: AppContext): AegisApi['importExport'] {
  const repos = () => ctx.storage.repos;
  const { audit, policy, platform } = ctx.deps;
  const sessions = new Map<string, Session>();

  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v.at > SESSION_TTL_MS) sessions.delete(k);
  };

  const preview = async (kind: ImportSourceKind, fileName: string, content: string): Promise<ImportPreview> => {
    sweep();
    if (content.length > MAX_IMPORT_BYTES) throw new AppError('IMPORT_TOO_LARGE', `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
    const token = newId();
    let session: Session;
    let name: string;
    const extra: Partial<ImportPreview> = {};

    if (kind === 'backup') {
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch (cause) {
        throw new AppError('IMPORT_INVALID', 'The backup file is not valid JSON.', {}, { cause });
      }
      if (isEncryptedEnvelope(json)) {
        session = { kind: 'aegis-backup', fileName, envelope: json, warnings: [], stats: ZERO, at: Date.now() };
        name = 'Encrypted backup (passphrase required to restore)';
      } else {
        const backup = validateBackup(json);
        session = { kind: 'aegis-backup', fileName, backup, warnings: [], stats: backupStats(backup), at: Date.now() };
        name = `Backup from ${backup.createdAt}`;
      }
    } else {
      const expect = kind === 'auto' ? undefined : EXPECTED[kind];
      const docs = importDocument(content, { fileName, maxBytes: MAX_IMPORT_BYTES, onProgress: (p) => ctx.progress(p, token), ...(expect ? { expect } : {}) });
      session = { kind: 'documents', fileName, docs, warnings: docs.warnings, stats: docs.stats, at: Date.now() };
      name = docs.name;
      if (docs.schemaVersion) extra.schemaVersion = docs.schemaVersion;
      if (docs.collections.length !== 1 || docs.environments.length > 0 || docs.globals) {
        extra.collections = docs.collections.length;
        extra.environments = docs.environments.length;
      }
    }
    sessions.set(token, session);
    return {
      token,
      kind: session.kind === 'documents' ? documentKind(session.docs) : 'aegis-backup',
      fileName,
      name,
      stats: session.stats,
      warnings: session.warnings,
      warningCounts: countWarnings(session.warnings),
      ...extra,
    };
  };

  const readLimited = async (file: string): Promise<string> => {
    const s = await stat(file);
    if (s.size > MAX_IMPORT_BYTES) throw new AppError('IMPORT_TOO_LARGE', `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
    return readFile(file, 'utf8');
  };

  const recordFailure = (workspaceId: string | null, sourceType: string, fileName: string, error: unknown) => {
    try {
      const jobId = repos().imports.createJob({ workspaceId, sourceType, fileName });
      const details = toSerializedError(error);
      const warnings = (details.details?.warnings as ImportWarningModel[] | undefined) ?? [];
      repos().imports.addWarnings(jobId, warnings);
      repos().imports.finishJob(jobId, { status: 'failed', errorMessage: details.message });
    } catch {
      /* diagnostics only */
    }
  };

  /** Store every collection / environment / global of a parsed file into `workspaceId` (caller runs this inside a transaction). */
  const storeDocuments = (r: Repositories, workspaceId: string, docs: ImportedDocuments, token: string): { collectionId?: string; environmentId?: string; stats: ImportStats } => {
    const stats = { ...ZERO };
    let collectionId: string | undefined;
    let environmentId: string | undefined;
    for (const bundle of docs.collections) {
      const res = r.collections.insertBundle(workspaceId, bundle, (p) => ctx.progress(p, token));
      collectionId ??= res.collectionId;
      stats.folders += res.stats.folders;
      stats.requests += res.stats.requests;
      stats.variables += res.stats.variables;
      stats.scripts += res.stats.scripts;
      stats.examples += res.stats.examples;
    }
    const existing = new Set(r.environments.list(workspaceId).map((e) => e.name));
    for (const env of docs.environments) {
      const created = r.environments.create(workspaceId, { name: uniqueName(existing, env.name, 'imported'), description: env.description ?? '' }, env.variables);
      environmentId ??= created.id;
      stats.variables += env.variables.length;
    }
    if (docs.globals && docs.globals.length) {
      const current = r.vars.global.list(workspaceId, 'resolve');
      const byKey = new Map(current.map((v) => [v.key, v]));
      for (const v of docs.globals) byKey.set(v.key, { ...(byKey.get(v.key) ?? {}), ...v });
      r.vars.global.replaceAll(workspaceId, [...byKey.values()]);
      stats.variables += docs.globals.length;
    }
    return { ...(collectionId ? { collectionId } : {}), ...(environmentId ? { environmentId } : {}), stats };
  };

  return {
    async pickAndPreview({ kind }) {
      const cfg = FILTERS[kind] ?? FILTERS.auto;
      const picked = await platform.pickFile(cfg);
      if (!picked) return null;
      if (picked.size > MAX_IMPORT_BYTES) throw new AppError('IMPORT_TOO_LARGE', `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
      try {
        return await preview(kind, picked.name, await readLimited(picked.path));
      } catch (error) {
        recordFailure(null, kind, picked.name, error);
        throw error;
      }
    },

    async previewContent({ kind, fileName, content }) {
      try {
        return await preview(kind, fileName, content);
      } catch (error) {
        recordFailure(null, kind, fileName, error);
        throw error;
      }
    },

    async commit({ token, workspaceId, passphrase }) {
      sweep();
      const session = sessions.get(token);
      if (!session) throw new AppError('NOT_FOUND', 'This import expired. Choose the file again.');
      repos().workspaces.require(workspaceId);
      const kind: ImportDocumentKind = session.kind === 'documents' ? documentKind(session.docs) : 'aegis-backup';
      const jobId = repos().imports.createJob({ workspaceId, sourceType: kind, fileName: session.fileName });
      try {
        let result: Omit<ImportCommitResult, 'jobId' | 'kind' | 'warnings'> & { stats: ImportStats };
        if (session.kind === 'aegis-backup') {
          let backup = session.backup;
          if (!backup) {
            if (!passphrase) throw new AppError('VALIDATION_FAILED', 'This backup is encrypted. Enter its passphrase.');
            backup = validateBackup(JSON.parse(decryptWithPassphrase(session.envelope as never, passphrase).toString('utf8')));
          }
          const stats = restoreBackup(ctx, backup);
          audit.log('RESTORE_BACKUP', { workspaces: backup.workspaces.length, requests: stats.requests });
          result = { stats };
        } else if (session.docs.format === 'aegis-workspace') {
          // A workspace file restores into a NEW workspace (like a backup); existing data is never touched.
          const { docs } = session;
          const stored = ctx.storage.transaction((r) => {
            const names = new Set(r.workspaces.list().map((w) => w.name));
            const ws = r.workspaces.create(uniqueName(names, docs.workspace?.name ?? 'Imported workspace', 'imported'), docs.workspace?.description ?? '');
            return { workspaceId: ws.id, ...storeDocuments(r, ws.id, docs, token) };
          });
          ctx.progress({ stage: 'Finalizing', current: stored.stats.requests, total: stored.stats.requests }, token);
          audit.log('IMPORT_COLLECTION', { source: 'aegis-workspace', workspace: docs.workspace?.name ?? null, collections: docs.collections.length, environments: docs.environments.length, requests: stored.stats.requests, warnings: session.warnings.length });
          result = stored;
        } else {
          const { docs } = session;
          const stored = ctx.storage.transaction((r) => storeDocuments(r, workspaceId, docs, token));
          ctx.progress({ stage: 'Finalizing', current: stored.stats.requests, total: stored.stats.requests }, token);
          if (docs.collections.length) {
            audit.log('IMPORT_COLLECTION', { source: docs.format, name: docs.collections[0]!.name, collections: docs.collections.length, requests: stored.stats.requests, folders: stored.stats.folders, warnings: session.warnings.length });
          }
          for (const env of docs.environments) audit.log('IMPORT_ENVIRONMENT', { source: docs.format, name: env.name, variables: env.variables.length });
          if (docs.globals) audit.log('IMPORT_ENVIRONMENT', { source: docs.format, name: 'Globals', variables: docs.globals.length });
          result = stored;
        }
        repos().imports.addWarnings(jobId, session.warnings);
        repos().imports.finishJob(jobId, { status: 'completed', stats: result.stats, ...(result.collectionId ? { collectionId: result.collectionId } : {}) });
        sessions.delete(token);
        return { jobId, kind, ...result, warnings: session.warnings };
      } catch (error) {
        // The transaction already rolled back: nothing half-imported remains.
        repos().imports.finishJob(jobId, { status: 'failed', errorMessage: toSerializedError(error).message });
        throw error instanceof AppError ? error : new AppError('IMPORT_FAILED', 'The import failed and was rolled back. No data was changed.', {}, { cause: error });
      }
    },

    async discard({ token }) {
      sessions.delete(token);
    },

    async exportCollection({ collectionId, includeSecrets }) {
      const collection = repos().collections.requireCollection(collectionId);
      if (includeSecrets) policy.assertCanExportSecrets();
      const target = await platform.saveFile({ title: 'Export collection (Postman v2.1)', defaultName: `${sanitizeFileName(collection.name, 'collection')}.postman_collection.json`, filters: [{ name: 'Postman collection', extensions: ['json'] }] });
      if (!target) return null;
      const bundle = repos().collections.loadBundle(collectionId, includeSecrets ? 'resolve' : 'blank');
      await writeFile(target, serializePostmanJson(exportPostmanCollection(bundle, { includeSecrets })));
      if (includeSecrets) audit.log('EXPORT_SECRETS', { target: 'collection', name: collection.name });
      audit.log('EXPORT_COLLECTION', { name: collection.name, format: 'postman-v2.1', includeSecrets });
      return target;
    },

    async exportEnvironment({ environmentId, includeSecrets }) {
      const env = repos().environments.require(environmentId);
      if (includeSecrets) policy.assertCanExportSecrets();
      const target = await platform.saveFile({ title: 'Export environment', defaultName: `${sanitizeFileName(env.name, 'environment')}.postman_environment.json`, filters: [{ name: 'Postman environment', extensions: ['json'] }] });
      if (!target) return null;
      const variables = repos().environments.variables(environmentId, includeSecrets ? 'resolve' : 'blank');
      await writeFile(target, serializePostmanJson(exportPostmanEnvironment({ name: env.name, description: env.description, variables }, { includeSecrets })));
      if (includeSecrets) audit.log('EXPORT_SECRETS', { target: 'environment', name: env.name });
      audit.log('EXPORT_ENVIRONMENT', { name: env.name, includeSecrets });
      return target;
    },

    async createBackup({ includeHistory, passphrase, historyLimit }) {
      // Secrets only travel inside a passphrase-encrypted backup, and only if policy allows exporting them.
      const withSecrets = !!passphrase && policy.current.allowSecretExport;
      const mode = withSecrets ? 'resolve' : 'blank';
      const limit = Math.min(Math.max(Math.floor(historyLimit ?? BACKUP_HISTORY_LIMIT_DEFAULT), 0), BACKUP_HISTORY_LIMIT_MAX);
      const s = ctx.rawSettings();
      const backup: BackupFile = {
        format: BACKUP_FORMAT,
        version: 1,
        createdAt: new Date().toISOString(),
        includesHistory: includeHistory,
        ...(includeHistory ? { historyLimit: limit } : {}),
        includesSecrets: withSecrets,
        settings: { appearance: s.appearance, history: s.history },
        workspaces: repos().workspaces.list().map((w) => ({
          name: w.name,
          description: w.description,
          collections: repos().collections.listCollections(w.id).map((c) => repos().collections.loadBundle(c.id, mode)),
          environments: repos().environments.list(w.id).map((e) => ({
            name: e.name,
            description: e.description,
            isProduction: e.isProduction,
            isActive: e.isActive,
            variables: repos().environments.variables(e.id, mode).map(({ id: _id, ...rest }) => rest),
          })),
          globals: repos().vars.global.list(w.id, mode).map(({ id: _id, ...rest }) => rest),
          ...(includeHistory ? { history: newestHistory(repos(), w.id, limit) } : {}),
        })),
      };
      await mkdir(ctx.deps.paths.backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `aegis-backup-${stamp}${passphrase ? '.aegisbackup' : '.json'}`;
      const file = path.join(ctx.deps.paths.backupsDir, fileName);
      const text = JSON.stringify(backup);
      await writeFile(file, passphrase ? JSON.stringify(encryptWithPassphrase(text, passphrase)) : text, { mode: 0o600 });
      const size = (await stat(file)).size;
      const id = repos().backups.record({ fileName, path: file, sizeBytes: size, includesHistory: includeHistory, encrypted: !!passphrase });
      if (withSecrets) audit.log('EXPORT_SECRETS', { target: 'backup' });
      audit.log('CREATE_BACKUP', { fileName, includeHistory, ...(includeHistory ? { historyLimit: limit } : {}), encrypted: !!passphrase, includesSecrets: withSecrets });
      return { id, fileName, path: file, sizeBytes: size, includesHistory: includeHistory, encrypted: !!passphrase, createdAt: new Date().toISOString() };
    },

    async listBackups() {
      return repos().backups.list();
    },
  };
}

/** Newest `limit` history rows of a workspace (paged, because one search returns at most 500). */
function newestHistory(r: Repositories, workspaceId: string, limit: number): NonNullable<BackupWorkspace['history']> {
  const out: NonNullable<BackupWorkspace['history']> = [];
  for (let offset = 0; out.length < limit; ) {
    const page = r.history.search({ workspaceId, limit: Math.min(500, limit - out.length), offset });
    for (const h of page.items) out.push({ method: h.method, url: h.url, statusCode: h.statusCode, statusText: h.statusText, durationMs: h.durationMs, createdAt: h.createdAt, requestName: h.requestName, environmentName: h.environmentName });
    if (page.items.length === 0 || offset + page.items.length >= page.total) break;
    offset += page.items.length;
  }
  return out;
}

function validateBackup(json: unknown): BackupFile {
  const b = json as Partial<BackupFile> | null;
  if (b && typeof b === 'object' && (b as { format?: unknown }).format === 'aegis-workspace') {
    throw new AppError('IMPORT_INVALID', 'This is an Aegis workspace file, not a backup. Use File -> Import -> Aegis workspace (or auto-detect).');
  }
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT || b.version !== 1 || !Array.isArray(b.workspaces)) {
    throw new AppError('IMPORT_INVALID', 'This is not a valid Aegis backup file.');
  }
  return b as BackupFile;
}

function backupStats(b: BackupFile): ImportStats {
  const stats = { ...ZERO };
  const walk = (items: CollectionBundle['items']) => {
    for (const i of items) {
      if (i.kind === 'folder') {
        stats.folders++;
        walk(i.items);
      } else {
        stats.requests++;
        stats.examples += i.request.examples.length;
      }
    }
  };
  for (const w of b.workspaces) {
    for (const c of w.collections) {
      walk(c.items);
      stats.variables += c.variables.length;
    }
    stats.variables += w.globals.length + w.environments.reduce((n, e) => n + e.variables.length, 0);
  }
  return stats;
}

/** Restore into NEW workspaces inside one transaction (never overwrites existing data). */
function restoreBackup(ctx: AppContext, backup: BackupFile): ImportStats {
  const total = ZERO;
  const stats = { ...total };
  ctx.storage.transaction((r) => {
    const existing = new Set(r.workspaces.list().map((w) => w.name));
    for (const w of backup.workspaces) {
      let name = w.name;
      for (let n = 1; existing.has(name); n++) name = n === 1 ? `${w.name} (restored)` : `${w.name} (restored ${n})`;
      existing.add(name);
      const ws = r.workspaces.create(name, w.description);
      for (const c of w.collections) {
        const res = r.collections.insertBundle(ws.id, c);
        stats.folders += res.stats.folders;
        stats.requests += res.stats.requests;
        stats.variables += res.stats.variables;
        stats.scripts += res.stats.scripts;
        stats.examples += res.stats.examples;
      }
      for (const e of w.environments) {
        const env = r.environments.create(ws.id, { name: e.name, description: e.description, isProduction: e.isProduction }, e.variables);
        if (e.isActive) r.environments.setActive(ws.id, env.id);
        stats.variables += e.variables.length;
      }
      if (w.globals.length) r.vars.global.replaceAll(ws.id, w.globals);
      for (const h of w.history ?? []) {
        r.history.add({ workspaceId: ws.id, method: h.method, url: h.url, statusCode: h.statusCode, statusText: h.statusText, durationMs: h.durationMs, createdAt: h.createdAt, requestName: h.requestName, environmentName: h.environmentName });
      }
    }
    // Only presentation/history preferences are restored; security and network settings are never changed by a backup.
    r.settings.update({ appearance: backup.settings?.appearance, history: backup.settings?.history });
  });
  return stats;
}
