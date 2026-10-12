import {
  AppError,
  emptyRequestDraft,
  type AegisApi,
  type ExecutionResult,
  type HistoryItem,
  type RequestDraft,
  type RunnerItemEvent,
  type RunnerItemResponse,
  type VariableEntry,
} from '@aegis/core';
import { isSensitiveKey, redactText } from '@aegis/security';
import { parseIterationData, runCollection, type RunnableRequest } from '@aegis/testing';
import type { HistoryEntry } from '@aegis/storage';
import type { AppContext } from '../context';
import type { RequestExecutor } from '../executor';

/** Bytes of response body kept per run item when `keepResponses` is on. */
export const KEEP_RESPONSE_BYTES = 64 * 1024;

function toItem(h: HistoryEntry): HistoryItem {
  return {
    id: h.id,
    workspaceId: h.workspaceId,
    requestId: h.requestId,
    requestName: h.requestName,
    environmentName: h.environmentName,
    method: h.method,
    url: h.url,
    statusCode: h.statusCode,
    statusText: h.statusText,
    errorCode: h.errorCode,
    durationMs: h.durationMs,
    requestSize: h.requestSize,
    responseSize: h.responseSize,
    createdAt: h.createdAt,
  };
}

/** Rebuild an (unresolved) draft from a history snapshot. Bodies/secrets are only present if the user chose to store them. */
function draftFromSnapshot(entry: HistoryEntry): { draft: RequestDraft; warnings: string[] } {
  const warnings: string[] = [];
  const snap = (entry.requestSnapshot as { draft?: Partial<RequestDraft> & { body?: { mode?: string; omitted?: boolean } } } | null)?.draft;
  if (!snap) {
    warnings.push('No request snapshot was stored; replaying the recorded URL only.');
    return { draft: emptyRequestDraft({ name: entry.requestName ?? 'Replayed request', method: entry.method, url: entry.url }), warnings };
  }
  const body = snap.body as Partial<RequestDraft['body']> & { omitted?: boolean };
  if (body?.omitted) warnings.push('The request body was not stored (history privacy setting); it is empty in this replay.');
  const draft = emptyRequestDraft({
    ...(snap as Partial<RequestDraft>),
    name: snap.name ?? entry.requestName ?? 'Replayed request',
    body: body && !body.omitted && body.mode ? (body as RequestDraft['body']) : { mode: 'none' },
  });
  if (JSON.stringify(draft.headers).includes('[REDACTED]')) warnings.push('Some sensitive header values were masked in history and are empty/masked in this replay.');
  return { draft, warnings };
}

export function createHistoryService(ctx: AppContext, executor: RequestExecutor): AegisApi['history'] {
  const repos = () => ctx.storage.repos;
  return {
    async search(input) {
      const page = repos().history.search(input);
      return { items: page.items.map(toItem), total: page.total, limit: page.limit, offset: page.offset };
    },
    async get({ id }) {
      const h = repos().history.get(id);
      if (!h) throw new AppError('NOT_FOUND', 'History entry not found.');
      return { ...toItem(h), requestSnapshot: h.requestSnapshot, responseMetadata: h.responseMetadata };
    },
    async delete({ id }) {
      repos().history.delete(id);
      ctx.deps.audit.log('DELETE_HISTORY', { scope: 'entry' });
    },
    async clear({ workspaceId }) {
      const n = repos().history.clear(workspaceId);
      ctx.deps.audit.log('DELETE_HISTORY', { scope: 'workspace', removed: n });
      return n;
    },
    async replay({ id, executionId, confirmProduction }) {
      const h = repos().history.get(id);
      if (!h) throw new AppError('NOT_FOUND', 'History entry not found.');
      const env = h.environmentId && repos().environments.get(h.environmentId) ? h.environmentId : undefined;
      const base = { executionId, workspaceId: h.workspaceId, ...(env ? { environmentId: env } : {}), ...(confirmProduction ? { confirmProduction } : {}) };
      if (h.requestId && repos().collections.getRequest(h.requestId)) {
        return (await executor.execute({ ...base, requestId: h.requestId })).result;
      }
      const { draft, warnings } = draftFromSnapshot(h);
      const out = (await executor.execute({ ...base, draft })).result;
      out.warnings.unshift(...warnings);
      return out;
    },
    async saveToCollection({ id, collectionId, folderId }) {
      const h = repos().history.get(id);
      if (!h) throw new AppError('NOT_FOUND', 'History entry not found.');
      const { draft } = draftFromSnapshot(h);
      return repos().collections.createRequest(collectionId, folderId, draft);
    },
  };
}

/**
 * Build the stored response head for a run item: status, non-sensitive headers
 * and the redacted first {@link KEEP_RESPONSE_BYTES} of the body. Sensitive
 * headers (Authorization, Cookie, Set-Cookie, tokens, API keys, ...) are
 * removed entirely; known secret values and credential patterns are masked.
 */
export function redactRunResponse(result: ExecutionResult, secretValues: readonly string[], extraPatterns: readonly string[]): RunnerItemResponse | undefined {
  const r = result.response;
  if (!r) return undefined;
  const headers = r.headers.filter((h) => !isSensitiveKey(h.name, extraPatterns)).map((h) => ({ name: h.name, value: h.value }));
  // bodyPreview is UTF-8 text of the first 512 KiB (empty for binary bodies); keep at most 64 KiB of it.
  const rawBody = r.isBinary ? '' : Buffer.from(r.bodyPreview, 'utf8').subarray(0, KEEP_RESPONSE_BYTES).toString('utf8');
  const body = redactText(rawBody, secretValues, extraPatterns);
  return {
    status: r.status,
    statusText: r.statusText,
    contentType: r.contentType,
    headers,
    body,
    bodyTruncated: r.isBinary ? r.size > 0 : r.size > Buffer.byteLength(rawBody, 'utf8'),
    size: r.size,
  };
}

export function createRunnerService(ctx: AppContext, executor: RequestExecutor): AegisApi['runner'] {
  const repos = () => ctx.storage.repos;
  const runs = new Map<string, { abort: AbortController; current?: string }>();

  /** Depth-first, tree-ordered requests of a collection (optionally restricted to one folder subtree). */
  function collectRequests(collectionId: string, folderId: string | null | undefined): RunnableRequest[] {
    const rows = repos().collections.getTreeRows(collectionId);
    const byParent = new Map<string | null, typeof rows>();
    for (const r of rows) byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);
    const out: RunnableRequest[] = [];
    const walk = (parent: string | null) => {
      for (const r of byParent.get(parent) ?? []) {
        if (r.kind === 'folder') walk(r.id);
        else out.push({ id: r.id, name: r.name, method: r.method ?? 'GET', url: '' });
      }
    };
    walk(folderId ?? null);
    return out;
  }

  /** Apply `requestIds`: keep only the listed requests, in the listed order (unknown ids are ignored). */
  function selectRequests(all: RunnableRequest[], requestIds: readonly string[] | undefined): RunnableRequest[] {
    if (!requestIds || requestIds.length === 0) return all;
    const byId = new Map(all.map((r) => [r.id, r]));
    const seen = new Set<string>();
    const out: RunnableRequest[] = [];
    for (const id of requestIds) {
      const r = byId.get(id);
      if (r && !seen.has(id)) {
        seen.add(id);
        out.push(r);
      }
    }
    return out;
  }

  /** Secret variable values of every scope the run can touch, for redacting stored responses. */
  function secretValues(workspaceId: string, collectionId: string, environmentId: string | null): string[] {
    const r = repos();
    const pick = (list: VariableEntry[]) => list.filter((v) => v.isSecret).flatMap((v) => [v.initialValue, v.currentValue ?? '']).filter((v) => v.length >= 3);
    const out = [...pick(r.vars.global.list(workspaceId, 'resolve')), ...pick(r.vars.collection.list(collectionId, 'resolve'))];
    if (environmentId) out.push(...pick(r.environments.variables(environmentId, 'resolve')));
    for (const row of r.collections.getTreeRows(collectionId)) if (row.kind === 'folder') out.push(...pick(r.vars.folder.list(row.id, 'resolve')));
    return [...new Set(out)];
  }

  return {
    async start(options) {
      const collection = repos().collections.requireCollection(options.collectionId);
      const requests = selectRequests(collectRequests(options.collectionId, options.folderId), options.requestIds);
      if (requests.length === 0) throw new AppError('VALIDATION_FAILED', options.requestIds?.length ? 'None of the selected requests exist in this collection.' : 'There are no requests to run.');
      const data = options.dataFile ? parseIterationData(options.dataFile.name, options.dataFile.content) : [];
      const env = options.environmentId !== undefined ? options.environmentId : (repos().environments.getActive(options.workspaceId)?.id ?? null);
      const keepResponses = options.keepResponses === true;
      const secrets = keepResponses ? secretValues(options.workspaceId, collection.id, env) : [];
      const redactionPatterns = ctx.settings().security.redactionPatterns;
      const runId = repos().runs.create({
        workspaceId: options.workspaceId,
        collectionId: collection.id,
        collectionName: collection.name,
        environmentId: env,
        iterations: options.iterations,
        delayMs: options.delayMs,
        stopOnFailure: options.stopOnFailure,
      });
      const abort = new AbortController();
      const state: { abort: AbortController; current?: string } = { abort };
      runs.set(runId, state);
      const startedAt = Date.now();
      const responses = new Map<number, RunnerItemResponse>(); // step counter -> redacted response

      // Run in the background; progress is streamed with events.
      void (async () => {
        let locals: Record<string, string> = {};
        let lastIteration = -1;
        let n = 0;
        try {
          const report = await runCollection({
            requests,
            iterations: options.iterations,
            data,
            delayMs: options.delayMs,
            stopOnFailure: options.stopOnFailure,
            signal: abort.signal,
            async execute(req, c) {
              // Local variables live for exactly one iteration: reset when the iteration changes,
              // never because a particular request (e.g. a setNextRequest jump back to the first one) runs.
              if (c.iteration !== lastIteration) {
                locals = {};
                lastIteration = c.iteration;
              }
              const step = n++;
              const executionId = `${runId}:${step}`;
              state.current = executionId;
              try {
                const out = await executor.execute(
                  { executionId, workspaceId: options.workspaceId, requestId: req.id, ...(env !== null ? { environmentId: env } : { environmentId: null }), ...(options.confirmProduction ? { confirmProduction: true } : {}) },
                  { localVariables: locals, iterationData: c.data, iteration: { index: c.iteration, count: c.iterationCount }, signal: abort.signal },
                );
                locals = out.localVariables;
                const r = out.result;
                if (keepResponses) {
                  const head = redactRunResponse(r, secrets, redactionPatterns);
                  if (head) responses.set(step, head);
                }
                return {
                  statusCode: r.response?.status ?? null,
                  durationMs: r.response?.timings.totalMs ?? null,
                  method: r.request?.method ?? req.method,
                  url: r.request?.url ?? '',
                  tests: r.tests,
                  ...(r.error ? { error: r.error.message } : {}),
                  ...(r.nextRequest !== undefined ? { nextRequest: r.nextRequest } : {}),
                  ...(r.skipped ? { skipped: true } : {}),
                };
              } catch (error) {
                return { tests: [], error: error instanceof Error ? error.message : 'Unexpected error' };
              }
            },
            onItem(item) {
              const response = responses.get(item.index);
              responses.delete(item.index);
              repos().runs.addItem(runId, {
                iteration: item.iteration,
                requestId: item.request.id,
                requestName: item.request.name,
                method: item.method,
                url: item.url,
                statusCode: item.statusCode,
                durationMs: item.durationMs,
                passed: item.passed,
                error: item.error ?? null,
                tests: item.tests,
                sortOrder: item.index,
                ...(response ? { response } : {}),
              });
              const event: RunnerItemEvent = {
                runId,
                index: item.index,
                iteration: item.iteration,
                requestId: item.request.id,
                name: item.request.name,
                method: item.method,
                url: item.url,
                statusCode: item.statusCode,
                durationMs: item.durationMs,
                passed: item.passed,
                ...(item.error ? { error: item.error } : {}),
                tests: item.tests,
                ...(response ? { response } : {}),
              };
              ctx.deps.emit('runner:item', event);
            },
          });
          repos().runs.finish(runId, { status: report.status, totalRequests: report.totalRequests, passedTests: report.passedTests, failedTests: report.failedTests, summary: { failedRequests: report.failedRequests, iterations: report.iterationCount, keepResponses, requestIds: requests.map((r) => r.id) } });
          ctx.deps.emit('runner:done', { runId, status: report.status, totalRequests: report.totalRequests, passedTests: report.passedTests, failedTests: report.failedTests, durationMs: Date.now() - startedAt });
        } catch (error) {
          ctx.deps.logger.error('collection run failed', error);
          repos().runs.finish(runId, { status: 'failed', totalRequests: n, passedTests: 0, failedTests: 0 });
          ctx.deps.emit('runner:done', { runId, status: 'failed', totalRequests: n, passedTests: 0, failedTests: 0, durationMs: Date.now() - startedAt });
        } finally {
          runs.delete(runId);
        }
      })();
      return { runId };
    },

    async stop({ runId }) {
      const r = runs.get(runId);
      if (!r) return;
      r.abort.abort();
      if (r.current) await executor.cancel(r.current);
    },

    async list({ workspaceId }) {
      return repos().runs.list(workspaceId).map((r) => ({
        id: r.id,
        collectionName: r.collectionName,
        status: r.status,
        iterations: r.iterations,
        totalRequests: r.totalRequests,
        passedTests: r.passedTests,
        failedTests: r.failedTests,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      }));
    },

    async items({ runId }) {
      return repos().runs.items(runId).map((i) => ({
        runId,
        index: i.sortOrder,
        iteration: i.iteration,
        requestId: i.requestId,
        name: i.requestName,
        method: i.method,
        url: i.url,
        statusCode: i.statusCode,
        durationMs: i.durationMs,
        passed: i.passed,
        ...(i.error ? { error: i.error } : {}),
        tests: (i.tests as RunnerItemEvent['tests']) ?? [],
        ...(i.response ? { response: i.response as RunnerItemResponse } : {}),
      }));
    },
  };
}
