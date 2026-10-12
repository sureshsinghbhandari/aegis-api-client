import { and, asc, desc, eq, like, lt, sql } from 'drizzle-orm';
import { AppError, DEFAULT_SETTINGS, mergeSettings, newId, type AppSettings, type ImportWarningModel, type ImportStats } from '@aegis/core';
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

export type CookieAttributes = Omit<StoredCookie, 'id' | 'createdAt' | 'workspaceId'>;

const COOKIE_SAME_SITE = ['Strict', 'Lax', 'None'] as const;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const COOKIE_NAME = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Validate a cookie domain typed by hand. Returns the normalised form (lower-case, leading dot kept). */
export function normalizeCookieDomain(input: string): string {
  const raw = input.trim().toLowerCase();
  if (raw === '' || raw === '*' || raw === '.') throw new AppError('VALIDATION_FAILED', 'A cookie needs a domain (for example api.example.com).');
  if (raw.length > 253) throw new AppError('VALIDATION_FAILED', 'The cookie domain is too long.');
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw) || raw.includes('/') || raw.includes(':') || raw.includes('@') || /\s/.test(raw)) {
    throw new AppError('VALIDATION_FAILED', 'Enter a host name only (no scheme, port or path).');
  }
  if (raw.includes('*')) throw new AppError('VALIDATION_FAILED', 'Wildcards are not allowed in a cookie domain.');
  const host = raw.replace(/^\./, '');
  if (host === '') throw new AppError('VALIDATION_FAILED', 'A cookie needs a domain (for example api.example.com).');
  const ipv4 = /^(\d{1,3})(\.\d{1,3}){3}$/.test(host);
  if (!ipv4 && !host.split('.').every((label) => label !== '' && DOMAIN_LABEL.test(label))) {
    throw new AppError('VALIDATION_FAILED', 'The cookie domain contains invalid characters.');
  }
  return raw;
}

/**
 * Validate and normalise attributes of a cookie entered in the manager. Throws `VALIDATION_FAILED`
 * with a user-facing message. `value` is checked for cookie-octet safety only (it is stored in the vault).
 */
export function normalizeCookieInput(input: {
  domain: string;
  path?: string | undefined;
  name: string;
  value: string;
  hostOnly?: boolean | undefined;
  secure?: boolean | undefined;
  httpOnly?: boolean | undefined;
  sameSite?: string | null | undefined;
  expiresAt?: string | null | undefined;
}): CookieAttributes {
  const domain = normalizeCookieDomain(input.domain);
  const name = input.name.trim();
  if (name === '') throw new AppError('VALIDATION_FAILED', 'A cookie needs a name.');
  if (name.length > 4096 || !COOKIE_NAME.test(name)) throw new AppError('VALIDATION_FAILED', 'The cookie name contains characters that are not allowed (no spaces, "=", ";" or ",").');
  if (input.value.length > 64 * 1024) throw new AppError('VALIDATION_FAILED', 'The cookie value is too long.');
  if (CONTROL_CHARS.test(input.value) || /[;]/.test(input.value) || /\s/.test(input.value)) {
    throw new AppError('VALIDATION_FAILED', 'The cookie value must not contain spaces, semicolons or control characters.');
  }
  const path = (input.path ?? '').trim() || '/';
  if (!path.startsWith('/') || CONTROL_CHARS.test(path) || path.includes(';') || /\s/.test(path) || path.length > 2000) {
    throw new AppError('VALIDATION_FAILED', 'The cookie path must start with "/" and contain no spaces or semicolons.');
  }
  let sameSite: string | null = null;
  if (input.sameSite) {
    const match = COOKIE_SAME_SITE.find((s) => s.toLowerCase() === input.sameSite!.trim().toLowerCase());
    if (!match) throw new AppError('VALIDATION_FAILED', 'SameSite must be Strict, Lax or None.');
    sameSite = match;
  }
  const secure = input.secure ?? false;
  if (sameSite === 'None' && !secure) throw new AppError('VALIDATION_FAILED', 'A SameSite=None cookie must also be Secure.');
  let expiresAt: string | null = null;
  if (input.expiresAt) {
    const t = Date.parse(input.expiresAt);
    if (Number.isNaN(t)) throw new AppError('VALIDATION_FAILED', 'The expiry date is not valid.');
    if (t > Date.UTC(9999, 11, 31)) throw new AppError('VALIDATION_FAILED', 'The expiry date is too far in the future.');
    expiresAt = new Date(t).toISOString();
  }
  return {
    domain,
    path,
    name,
    value: input.value,
    hostOnly: input.hostOnly ?? !domain.startsWith('.'),
    secure,
    httpOnly: input.httpOnly ?? false,
    sameSite,
    expiresAt,
  };
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

  /** One cookie with its value masked (empty). */
  get(id: string): StoredCookie | null {
    const r = this.db.select().from(cookies).where(eq(cookies.id, id)).get();
    if (!r) return null;
    return this.list(r.workspaceId).find((c) => c.id === id) ?? null;
  }

  private findIdentity(workspaceId: string, domain: string, path: string, name: string): { id: string } | undefined {
    return this.db
      .select({ id: cookies.id })
      .from(cookies)
      .where(and(eq(cookies.workspaceId, workspaceId), eq(cookies.domain, domain), eq(cookies.path, path), eq(cookies.name, name)))
      .get();
  }

  /**
   * Manual add from the cookie manager. Attributes are validated (`normalizeCookieInput`), the value goes
   * to secret storage; duplicates (same domain/path/name) are refused.
   */
  add(input: { workspaceId: string } & Parameters<typeof normalizeCookieInput>[0]): StoredCookie {
    const c = normalizeCookieInput(input);
    if (this.findIdentity(input.workspaceId, c.domain, c.path, c.name)) {
      throw new AppError('VALIDATION_FAILED', `A cookie named "${c.name}" already exists for ${c.domain}${c.path}. Edit it instead.`);
    }
    this.upsert({ ...c, workspaceId: input.workspaceId });
    const created = this.findIdentity(input.workspaceId, c.domain, c.path, c.name);
    return this.get(created!.id)!;
  }

  /**
   * Manual edit. `value` undefined keeps the stored value (it is never read back for validation);
   * the merged attributes are validated and checked against the uniqueness of domain/path/name.
   */
  update(id: string, patch: Partial<CookieAttributes>): StoredCookie {
    const row = this.db.select().from(cookies).where(eq(cookies.id, id)).get();
    if (!row) throw new AppError('NOT_FOUND', 'Cookie not found.', { id });
    const c = normalizeCookieInput({
      domain: patch.domain ?? row.domain,
      path: patch.path ?? row.path,
      name: patch.name ?? row.name,
      value: patch.value ?? '',
      hostOnly: patch.hostOnly ?? row.hostOnly,
      secure: patch.secure ?? row.secure,
      httpOnly: patch.httpOnly ?? row.httpOnly,
      sameSite: patch.sameSite === undefined ? row.sameSite : patch.sameSite,
      expiresAt: patch.expiresAt === undefined ? row.expiresAt : patch.expiresAt,
    });
    const clash = this.findIdentity(row.workspaceId, c.domain, c.path, c.name);
    if (clash && clash.id !== id) throw new AppError('VALIDATION_FAILED', `A cookie named "${c.name}" already exists for ${c.domain}${c.path}.`);
    this.db
      .update(cookies)
      .set({ domain: c.domain, path: c.path, name: c.name, hostOnly: c.hostOnly, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expiresAt: c.expiresAt })
      .where(eq(cookies.id, id))
      .run();
    if (patch.value !== undefined) this.secretStore.setSync(row.valueRef, patch.value);
    return this.get(id)!;
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
  /** Redacted response head (already stripped of sensitive headers by the caller); stored as JSON. */
  response?: unknown;
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
        responseJson: item.response === undefined ? null : toJson(item.response),
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
      .map((r) => ({ ...r, tests: parseJson<unknown>(r.testsJson, []), response: r.responseJson === null ? null : parseJson<unknown>(r.responseJson, null) }));
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
