import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import { newId, type HistoryRetention } from '@aegis/core';
import type { DbHandle } from '../database';
import { history, testResults } from '../schema';
import { likePattern, parseJson, toJson } from './common';

export interface HistoryEntryInput {
  workspaceId: string;
  requestId?: string | null;
  environmentId?: string | null;
  environmentName?: string | null;
  requestName?: string | null;
  method: string;
  url: string;
  statusCode?: number | null;
  statusText?: string | null;
  errorCode?: string | null;
  durationMs?: number | null;
  requestSize?: number | null;
  responseSize?: number | null;
  requestSnapshot?: unknown;
  responseMetadata?: unknown;
  createdAt?: string;
}

export interface HistoryEntry {
  id: string;
  workspaceId: string;
  requestId: string | null;
  environmentId: string | null;
  environmentName: string | null;
  requestName: string | null;
  method: string;
  url: string;
  statusCode: number | null;
  statusText: string | null;
  errorCode: string | null;
  durationMs: number | null;
  requestSize: number | null;
  responseSize: number | null;
  createdAt: string;
  requestSnapshot: unknown;
  responseMetadata: unknown;
}

export interface HistoryQuery {
  workspaceId: string;
  text?: string;
  method?: string;
  /** Exact code, or a class like `2xx`. */
  status?: string;
  environmentId?: string;
  from?: string;
  to?: string;
  sortBy?: 'createdAt' | 'durationMs' | 'statusCode' | 'method';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface HistoryPage {
  items: HistoryEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface TestResultInput {
  historyId?: string | null;
  runItemId?: string | null;
  requestId?: string | null;
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string | null;
}

type Row = typeof history.$inferSelect;

export class HistoryRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => string,
  ) {}

  private map(r: Row): HistoryEntry {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      requestId: r.requestId,
      environmentId: r.environmentId,
      environmentName: r.environmentName,
      requestName: r.requestName,
      method: r.method,
      url: r.url,
      statusCode: r.statusCode,
      statusText: r.statusText,
      errorCode: r.errorCode,
      durationMs: r.durationMs,
      requestSize: r.requestSize,
      responseSize: r.responseSize,
      createdAt: r.createdAt,
      requestSnapshot: parseJson<unknown>(r.requestSnapshotJson, null),
      responseMetadata: parseJson<unknown>(r.responseMetadataJson, null),
    };
  }

  add(input: HistoryEntryInput): string {
    const id = newId();
    this.db
      .insert(history)
      .values({
        id,
        workspaceId: input.workspaceId,
        requestId: input.requestId ?? null,
        environmentId: input.environmentId ?? null,
        environmentName: input.environmentName ?? null,
        requestName: input.requestName ?? null,
        method: input.method,
        url: input.url,
        statusCode: input.statusCode ?? null,
        statusText: input.statusText ?? null,
        errorCode: input.errorCode ?? null,
        durationMs: input.durationMs ?? null,
        requestSize: input.requestSize ?? null,
        responseSize: input.responseSize ?? null,
        createdAt: input.createdAt ?? this.now(),
        requestSnapshotJson: input.requestSnapshot === undefined ? null : toJson(input.requestSnapshot),
        responseMetadataJson: input.responseMetadata === undefined ? null : toJson(input.responseMetadata),
      })
      .run();
    return id;
  }

  get(id: string): HistoryEntry | null {
    const r = this.db.select().from(history).where(eq(history.id, id)).get();
    return r ? this.map(r) : null;
  }

  /** Paginated, indexed search. Never loads unbounded rows. */
  search(q: HistoryQuery): HistoryPage {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const offset = Math.max(q.offset ?? 0, 0);
    const conds: SQL[] = [eq(history.workspaceId, q.workspaceId)];
    if (q.text?.trim()) {
      const p = likePattern(q.text.trim());
      conds.push(sql`(${history.url} like ${p} escape '\\' or ${history.requestName} like ${p} escape '\\')`);
    }
    if (q.method) conds.push(eq(history.method, q.method.toUpperCase()));
    if (q.status) {
      const m = /^([1-5])xx$/i.exec(q.status);
      if (m) conds.push(and(gte(history.statusCode, Number(m[1]) * 100), lt(history.statusCode, Number(m[1]) * 100 + 100))!);
      else if (/^\d+$/.test(q.status)) conds.push(eq(history.statusCode, Number(q.status)));
      else if (q.status.toLowerCase() === 'error') conds.push(sql`${history.errorCode} is not null`);
    }
    if (q.environmentId) conds.push(eq(history.environmentId, q.environmentId));
    if (q.from) conds.push(gte(history.createdAt, q.from));
    if (q.to) conds.push(lte(history.createdAt, q.to));
    const where = and(...conds);
    const col = { createdAt: history.createdAt, durationMs: history.durationMs, statusCode: history.statusCode, method: history.method }[q.sortBy ?? 'createdAt'];
    const dir = (q.sortDir ?? 'desc') === 'asc' ? asc : desc;
    const items = this.db.select().from(history).where(where).orderBy(dir(col), desc(history.createdAt)).limit(limit).offset(offset).all();
    const total = this.db.select({ n: sql<number>`count(*)` }).from(history).where(where).get()?.n ?? 0;
    return { items: items.map((r) => this.map(r)), total, limit, offset };
  }

  delete(id: string): void {
    this.db.delete(history).where(eq(history.id, id)).run();
  }

  /** Clear all history of a workspace; returns the number of rows removed. */
  clear(workspaceId: string): number {
    const n = this.db.select({ n: sql<number>`count(*)` }).from(history).where(eq(history.workspaceId, workspaceId)).get()?.n ?? 0;
    this.db.delete(history).where(eq(history.workspaceId, workspaceId)).run();
    return n;
  }

  /** Delete entries older than the retention window. `unlimited` is a no-op. */
  prune(retention: HistoryRetention, nowMs = Date.now()): number {
    const days: Record<HistoryRetention, number | null> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365, unlimited: null };
    const d = days[retention];
    if (d === null) return 0;
    const cutoff = new Date(nowMs - d * 86_400_000).toISOString();
    const n = this.db.select({ n: sql<number>`count(*)` }).from(history).where(lt(history.createdAt, cutoff)).get()?.n ?? 0;
    this.db.delete(history).where(lt(history.createdAt, cutoff)).run();
    return n;
  }

  // ---------------------------------------------------------------- test results

  addTestResults(results: readonly TestResultInput[]): void {
    if (results.length === 0) return;
    const ts = this.now();
    this.db
      .insert(testResults)
      .values(
        results.map((r) => ({
          id: newId(),
          historyId: r.historyId ?? null,
          runItemId: r.runItemId ?? null,
          requestId: r.requestId ?? null,
          name: r.name,
          passed: r.passed,
          durationMs: r.durationMs,
          error: r.error ?? null,
          createdAt: ts,
        })),
      )
      .run();
  }

  testResultsFor(historyIds: readonly string[]) {
    if (historyIds.length === 0) return [];
    return this.db.select().from(testResults).where(inArray(testResults.historyId, [...historyIds])).all();
  }
}
