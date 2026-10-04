import { and, asc, desc, eq, like, lt, sql } from 'drizzle-orm';
import { DEFAULT_SETTINGS, mergeSettings, newId, type AppSettings, type ImportWarningModel, type ImportStats } from '@aegis/core';
import type { AuditSink, AuditAction, SecretBlobStore, SyncSecretStorage } from '@aegis/security';
import type { DbHandle } from '../database';
import { auditLogs, backups, certificates, collectionRunItems, collectionRuns, cookies, importJobs, importWarnings, secrets, settings } from '../schema';
import { parseJson, toJson } from './common';

/** `secrets` table as ciphertext-only blob store. */
export class SecretBlobRepository implements SecretBlobStore {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => string,
  ) {}

  put(key: string, blob: Uint8Array): void {
    const buffer = Buffer.from(blob);
    this.db
      .insert(secrets)
      .values({ key, blob: buffer, updatedAt: this.now() })
      .onConflictDoUpdate({ target: secrets.key, set: { blob: buffer, updatedAt: this.now() } })
      .run();
  }

  get(key: string): Uint8Array | null {
    const r = this.db.select().from(secrets).where(eq(secrets.key, key)).get();
    return r ? new Uint8Array(r.blob) : null;
  }

  delete(key: string): void {
    this.db.delete(secrets).where(eq(secrets.key, key)).run();
  }

  deleteByPrefix(prefix: string): void {
    this.db.delete(secrets).where(sql`substr(${secrets.key}, 1, ${prefix.length}) = ${prefix}`).run();
  }
}

export class SettingsRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => string,
  ) {}

  getRaw<T>(key: string): T | null {
    const r = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return r ? parseJson<T | null>(r.valueJson, null) : null;
  }

  setRaw(key: string, value: unknown): void {
    this.db
      .insert(settings)
      .values({ key, valueJson: toJson(value), updatedAt: this.now() })
      .onConflictDoUpdate({ target: settings.key, set: { valueJson: toJson(value), updatedAt: this.now() } })
      .run();
  }

  deleteRaw(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }

  getAll(): AppSettings {
    return mergeSettings(DEFAULT_SETTINGS, this.getRaw<unknown>('app'));
  }

  update(patch: unknown): AppSettings {
    const next = mergeSettings(this.getAll(), patch);
    this.setRaw('app', next);
    return next;
  }
}

export class AuditRepository implements AuditSink {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => string,
  ) {}

  append(entry: { action: AuditAction; details: Record<string, unknown>; createdAt: string }): void {
    this.db.insert(auditLogs).values({ id: newId(), action: entry.action, detailsJson: toJson(entry.details), createdAt: entry.createdAt || this.now() }).run();
  }

  list(options: { action?: string; limit?: number; offset?: number } = {}) {
    const where = options.action ? eq(auditLogs.action, options.action) : undefined;
    const rows = this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(Math.min(options.limit ?? 100, 1000))
      .offset(options.offset ?? 0)
      .all();
    return rows.map((r) => ({ id: r.id, action: r.action, details: parseJson<Record<string, unknown>>(r.detailsJson, {}), createdAt: r.createdAt }));
  }

  prune(before: string): void {
    this.db.delete(auditLogs).where(lt(auditLogs.createdAt, before)).run();
  }
}

export interface StoredCookie {
  id: string;
  workspaceId: string;
  domain: string;
  path: string;
  name: string;
  value: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** Cookie persistence. Cookie VALUES live in secret storage (they are session credentials). */
export class CookieRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly secretStore: SyncSecretStorage,
    private readonly now: () => string,
  ) {}

  list(workspaceId: string, options: { revealValues?: boolean; domain?: string } = {}): StoredCookie[] {
    const where = options.domain ? and(eq(cookies.workspaceId, workspaceId), eq(cookies.domain, options.domain)) : eq(cookies.workspaceId, workspaceId);
    return this.db
      .select()
      .from(cookies)
      .where(where)
      .orderBy(asc(cookies.domain), asc(cookies.name))
      .all()
      .map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        domain: r.domain,
        path: r.path,
        name: r.name,
        value: options.revealValues ? (this.secretStore.getSync(r.valueRef) ?? '') : '',
        hostOnly: r.hostOnly,
        secure: r.secure,
        httpOnly: r.httpOnly,
        sameSite: r.sameSite,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
      }));
  }

  upsert(c: Omit<StoredCookie, 'id' | 'createdAt'>): void {
    const existing = this.db
      .select()
      .from(cookies)
      .where(and(eq(cookies.workspaceId, c.workspaceId), eq(cookies.domain, c.domain), eq(cookies.path, c.path), eq(cookies.name, c.name)))
      .get();
    const id = existing?.id ?? newId();
    const valueRef = `cookie:${id}`;
    this.secretStore.setSync(valueRef, c.value);
    const values = {
      workspaceId: c.workspaceId,
      domain: c.domain,
      path: c.path,
      name: c.name,
      valueRef,
      hostOnly: c.hostOnly,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expiresAt: c.expiresAt,
    };
    if (existing) this.db.update(cookies).set(values).where(eq(cookies.id, id)).run();
    else this.db.insert(cookies).values({ id, ...values, createdAt: this.now() }).run();
  }

  delete(id: string): void {
    this.secretStore.deleteSync(`cookie:${id}`);
    this.db.delete(cookies).where(eq(cookies.id, id)).run();
  }

  clear(workspaceId: string, domain?: string): number {
    const rows = this.list(workspaceId, domain ? { domain } : {});
    for (const r of rows) this.secretStore.deleteSync(`cookie:${r.id}`);
    this.db
      .delete(cookies)
      .where(domain ? and(eq(cookies.workspaceId, workspaceId), eq(cookies.domain, domain)) : eq(cookies.workspaceId, workspaceId))
      .run();
    return rows.length;
  }

  deleteExpired(nowIso: string): void {
    const expired = this.db.select().from(cookies).where(sql`${cookies.expiresAt} is not null and ${cookies.expiresAt} < ${nowIso}`).all();
    for (const r of expired) this.delete(r.id);
  }
}

export interface CertificateInput {
  kind: 'ca' | 'client';
  name: string;
  hostPattern?: string;
  certPem?: string;
  keyPem?: string;
  pfxBase64?: string;
  passphrase?: string;
  enabled?: boolean;
}

export interface CertificateInfo {
  id: string;
  kind: 'ca' | 'client';
  name: string;
  hostPattern: string;
  certPem: string | null;
  hasKey: boolean;
  hasPfx: boolean;
  hasPassphrase: boolean;
  enabled: boolean;
  createdAt: string;
}

export class CertificateRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly secretStore: SyncSecretStorage,
    private readonly now: () => string,
  ) {}

  list(): CertificateInfo[] {
    return this.db
      .select()
      .from(certificates)
      .orderBy(asc(certificates.name))
      .all()
      .map((r) => ({
        id: r.id,
        kind: r.kind as 'ca' | 'client',
        name: r.name,
        hostPattern: r.hostPattern,
        certPem: r.certPem,
        hasKey: !!r.keyRef,
        hasPfx: !!r.pfxRef,
        hasPassphrase: !!r.passphraseRef,
        enabled: r.enabled,
        createdAt: r.createdAt,
      }));
  }

  add(input: CertificateInput): CertificateInfo {
    const id = newId();
    const store = (suffix: string, value: string | undefined): string | null => {
      if (!value) return null;
      const key = `cert:${id}:${suffix}`;
      this.secretStore.setSync(key, value);
      return key;
    };
    this.db
      .insert(certificates)
      .values({
        id,
        kind: input.kind,
        name: input.name,
        hostPattern: input.hostPattern ?? '*',
        certPem: input.certPem ?? null,
        keyRef: store('key', input.keyPem),
        pfxRef: store('pfx', input.pfxBase64),
        passphraseRef: store('passphrase', input.passphrase),
        enabled: input.enabled ?? true,
        createdAt: this.now(),
      })
      .run();
    return this.list().find((c) => c.id === id)!;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.update(certificates).set({ enabled }).where(eq(certificates.id, id)).run();
  }

  delete(id: string): void {
    this.secretStore.deleteByPrefixSync(`cert:${id}:`);
    this.db.delete(certificates).where(eq(certificates.id, id)).run();
  }

  /** Enabled CA certificates (PEM). */
  trustedCAs(): string[] {
    return this.db
      .select()
      .from(certificates)
      .where(and(eq(certificates.kind, 'ca'), eq(certificates.enabled, true)))
      .all()
      .flatMap((r) => (r.certPem ? [r.certPem] : []));
  }

  /** Client certificate material for a host (first enabled match; most specific pattern wins). */
  clientCertificateFor(hostname: string) {
    const rows = this.db
      .select()
      .from(certificates)
      .where(and(eq(certificates.kind, 'client'), eq(certificates.enabled, true)))
      .all()
      .filter((r) => hostMatches(r.hostPattern, hostname))
      .sort((a, b) => b.hostPattern.length - a.hostPattern.length);
    const r = rows[0];
    if (!r) return undefined;
    const read = (ref: string | null) => (ref ? (this.secretStore.getSync(ref) ?? undefined) : undefined);
    return {
      ...(r.certPem ? { cert: r.certPem } : {}),
      ...(read(r.keyRef) ? { key: read(r.keyRef)! } : {}),
      ...(read(r.pfxRef) ? { pfxBase64: read(r.pfxRef)! } : {}),
      ...(read(r.passphraseRef) ? { passphrase: read(r.passphraseRef)! } : {}),
    };
  }
}

export function hostMatches(pattern: string, hostname: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = hostname.toLowerCase();
  if (p === '*' || p === '') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return p === h;
}

export class ImportRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => string,
  ) {}

  createJob(input: { workspaceId: string | null; sourceType: string; fileName?: string | null }): string {
    const id = newId();
    this.db
      .insert(importJobs)
      .values({ id, workspaceId: input.workspaceId, sourceType: input.sourceType, fileName: input.fileName ?? null, status: 'pending', startedAt: this.now() })
      .run();
    return id;
  }

  finishJob(id: string, result: { status: 'completed' | 'failed' | 'cancelled'; collectionId?: string | null; stats?: ImportStats; errorMessage?: string }): void {
    this.db
      .update(importJobs)
      .set({
        status: result.status,
        collectionId: result.collectionId ?? null,
        statsJson: result.stats ? toJson(result.stats) : null,
        errorMessage: result.errorMessage ?? null,
        finishedAt: this.now(),
      })
      .where(eq(importJobs.id, id))
      .run();
  }

  addWarnings(jobId: string, warnings: readonly ImportWarningModel[]): void {
    if (warnings.length === 0) return;
    const ts = this.now();
    for (let i = 0; i < warnings.length; i += 200) {
      this.db
        .insert(importWarnings)
        .values(
          warnings.slice(i, i + 200).map((w) => ({
            id: newId(),
            importJobId: jobId,
            severity: w.severity,
            path: w.path,
            message: w.message,
            sourceValue: w.sourceValue ?? null,
            createdAt: ts,
          })),
        )
        .run();
    }
  }

  listJobs(limit = 50) {
    return this.db.select().from(importJobs).orderBy(desc(importJobs.startedAt)).limit(limit).all();
  }

  warningsFor(jobId: string): ImportWarningModel[] {
    return this.db
      .select()
      .from(importWarnings)
      .where(eq(importWarnings.importJobId, jobId))
      .all()
      .map((w) => ({
        id: w.id,
        importJobId: w.importJobId,
        severity: w.severity as ImportWarningModel['severity'],
        path: w.path,
        message: w.message,
        ...(w.sourceValue ? { sourceValue: w.sourceValue } : {}),
        createdAt: w.createdAt,
      }));
  }
}

export interface RunInput {
  workspaceId: string;
  collectionId: string | null;
  collectionName: string;
  environmentId: string | null;
  iterations: number;
  delayMs: number;
  stopOnFailure: boolean;
}

export interface RunItemInput {
  iteration: number;
  requestId: string | null;
  requestName: string;
  method: string;
  url: string;
  statusCode: number | null;
  durationMs: number | null;
  passed: boolean;
  error?: string | null;
  tests?: unknown;
  sortOrder: number;
}

export class RunRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => string,
  ) {}

  create(input: RunInput): string {
    const id = newId();
    this.db.insert(collectionRuns).values({ id, ...input, status: 'running', startedAt: this.now() }).run();
    return id;
  }

  addItem(runId: string, item: RunItemInput): string {
    const id = newId();
    this.db
      .insert(collectionRunItems)
      .values({
        id,
        runId,
        iteration: item.iteration,
        requestId: item.requestId,
        requestName: item.requestName,
        method: item.method,
        url: item.url,
        statusCode: item.statusCode,
        durationMs: item.durationMs,
        passed: item.passed,
        error: item.error ?? null,
        testsJson: item.tests === undefined ? null : toJson(item.tests),
        sortOrder: item.sortOrder,
      })
      .run();
    return id;
  }

  finish(runId: string, result: { status: 'completed' | 'stopped' | 'failed'; totalRequests: number; passedTests: number; failedTests: number; summary?: unknown }): void {
    this.db
      .update(collectionRuns)
      .set({
        status: result.status,
        totalRequests: result.totalRequests,
        passedTests: result.passedTests,
        failedTests: result.failedTests,
        finishedAt: this.now(),
        summaryJson: result.summary === undefined ? null : toJson(result.summary),
      })
      .where(eq(collectionRuns.id, runId))
      .run();
  }

  list(workspaceId: string, limit = 50) {
    return this.db.select().from(collectionRuns).where(eq(collectionRuns.workspaceId, workspaceId)).orderBy(desc(collectionRuns.startedAt)).limit(limit).all();
  }

  items(runId: string) {
    return this.db
      .select()
      .from(collectionRunItems)
      .where(eq(collectionRunItems.runId, runId))
      .orderBy(asc(collectionRunItems.sortOrder))
      .all()
      .map((r) => ({ ...r, tests: parseJson<unknown>(r.testsJson, []) }));
  }

  delete(runId: string): void {
    this.db.delete(collectionRuns).where(eq(collectionRuns.id, runId)).run();
  }
}

export class BackupRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => string,
  ) {}

  record(input: { fileName: string; path: string; sizeBytes: number; includesHistory: boolean; encrypted: boolean }): string {
    const id = newId();
    this.db.insert(backups).values({ id, ...input, createdAt: this.now() }).run();
    return id;
  }

  list() {
    return this.db.select().from(backups).orderBy(desc(backups.createdAt)).all();
  }

  delete(id: string): void {
    this.db.delete(backups).where(eq(backups.id, id)).run();
  }
}

// `like` re-exported for callers that build ad-hoc queries
export { like };
