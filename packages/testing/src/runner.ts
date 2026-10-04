import type { TestResult } from '@aegis/core';
import type { DataRow } from './iteration-data';

export interface RunnableRequest {
  id: string;
  name: string;
  method: string;
  url: string;
}

export interface ExecutionOutcome {
  statusCode?: number | null;
  durationMs?: number | null;
  method?: string;
  url?: string;
  tests: TestResult[];
  /** Transport / script failure message. */
  error?: string;
  skipped?: boolean;
  /** From `pm.execution.setNextRequest`: request name/id to jump to, `null` to end the run, `undefined` to continue. */
  nextRequest?: string | null;
}

export interface RunItem {
  index: number;
  iteration: number;
  request: RunnableRequest;
  statusCode: number | null;
  durationMs: number | null;
  method: string;
  url: string;
  passed: boolean;
  error?: string;
  tests: TestResult[];
}

export interface RunConfig {
  requests: readonly RunnableRequest[];
  /** Requested iteration count (>= 1). When data rows are given the count is capped by the number of rows. */
  iterations: number;
  data: readonly DataRow[];
  delayMs: number;
  stopOnFailure: boolean;
  execute(request: RunnableRequest, context: { iteration: number; iterationCount: number; data: DataRow }): Promise<ExecutionOutcome>;
  onItem?(item: RunItem): void;
  signal?: AbortSignal;
  sleep?(ms: number): Promise<void>;
  /** Guard against `setNextRequest` loops. */
  maxStepsPerIteration?: number;
}

export interface RunReport {
  status: 'completed' | 'stopped' | 'failed';
  items: RunItem[];
  totalRequests: number;
  passedTests: number;
  failedTests: number;
  failedRequests: number;
  durationMs: number;
  iterationCount: number;
}

export function resolveIterationCount(requested: number, rows: number): number {
  const r = Math.max(1, Math.floor(requested || 1));
  if (rows === 0) return r;
  return Math.min(r, rows);
}

/** Pure runner loop: request ordering, iteration data, flow control, delays, stop-on-failure, summary. */
export async function runCollection(config: RunConfig): Promise<RunReport> {
  const started = Date.now();
  const sleep = config.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const iterationCount = resolveIterationCount(config.iterations, config.data.length);
  const items: RunItem[] = [];
  let passedTests = 0;
  let failedTests = 0;
  let failedRequests = 0;
  let status: RunReport['status'] = 'completed';
  let ended = false;
  const maxSteps = config.maxStepsPerIteration ?? Math.max(1000, config.requests.length * 100);

  outer: for (let iteration = 0; iteration < iterationCount && !ended; iteration++) {
    const row = config.data[iteration] ?? {};
    let i = 0;
    let steps = 0;
    while (i < config.requests.length) {
      if (config.signal?.aborted) {
        status = 'stopped';
        break outer;
      }
      if (++steps > maxSteps) {
        status = 'failed';
        break outer;
      }
      const request = config.requests[i]!;
      let outcome: ExecutionOutcome;
      try {
        outcome = await config.execute(request, { iteration, iterationCount, data: row });
      } catch (error) {
        outcome = { tests: [], error: error instanceof Error ? error.message : 'Unexpected error' };
      }
      const failedHere = outcome.tests.filter((t) => !t.passed && !t.skipped).length;
      const passedHere = outcome.tests.filter((t) => t.passed).length;
      passedTests += passedHere;
      failedTests += failedHere;
      const item: RunItem = {
        index: items.length,
        iteration,
        request,
        statusCode: outcome.statusCode ?? null,
        durationMs: outcome.durationMs ?? null,
        method: outcome.method ?? request.method,
        url: outcome.url ?? request.url,
        passed: !outcome.error && failedHere === 0,
        ...(outcome.error ? { error: outcome.error } : {}),
        tests: outcome.tests,
      };
      if (!item.passed) failedRequests++;
      items.push(item);
      config.onItem?.(item);

      if (!item.passed && config.stopOnFailure) {
        status = 'stopped';
        break outer;
      }

      if (outcome.nextRequest === null) {
        ended = true;
        break;
      }
      if (typeof outcome.nextRequest === 'string') {
        const target = outcome.nextRequest;
        const idx = config.requests.findIndex((r) => r.name === target || r.id === target);
        if (idx !== -1) {
          i = idx;
          if (config.delayMs > 0) await sleep(config.delayMs);
          continue;
        }
      }
      i++;
      if (config.delayMs > 0 && (i < config.requests.length || iteration < iterationCount - 1)) await sleep(config.delayMs);
    }
  }

  return {
    status,
    items,
    totalRequests: items.length,
    passedTests,
    failedTests,
    failedRequests,
    durationMs: Date.now() - started,
    iterationCount,
  };
}

/** Plain-text report, one line per request: `✓ Login   200   182ms`. */
export function formatRunReport(report: RunReport): string {
  const lines = report.items.map((i) => {
    const mark = i.passed ? '✓' : '✗';
    const status = i.statusCode ?? '---';
    const ms = i.durationMs === null ? '' : `${i.durationMs}ms`;
    return `${mark} ${i.request.name.padEnd(28)} ${String(status).padStart(3)} ${ms.padStart(8)}${i.error ? `  ${i.error}` : ''}`;
  });
  lines.push('', `${report.totalRequests} requests, ${report.passedTests} tests passed, ${report.failedTests} failed, ${report.durationMs}ms`);
  return lines.join('\n');
}

/** JUnit XML for CI consumers. */
export function toJUnitXml(name: string, report: RunReport): string {
  const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
  const cases = report.items.flatMap((item) => {
    if (item.tests.length === 0) {
      return [`<testcase classname="${esc(name)}" name="${esc(item.request.name)}" time="${((item.durationMs ?? 0) / 1000).toFixed(3)}">${item.error ? `<failure message="${esc(item.error)}"/>` : ''}</testcase>`];
    }
    return item.tests.map(
      (t) => `<testcase classname="${esc(`${name}.${item.request.name}`)}" name="${esc(t.name)}" time="${(t.durationMs / 1000).toFixed(3)}">${t.passed ? '' : t.skipped ? '<skipped/>' : `<failure message="${esc(t.error ?? 'failed')}"/>`}</testcase>`,
    );
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${esc(name)}" tests="${cases.length}" failures="${report.failedTests + (report.items.filter((i) => i.error).length)}">\n${cases.join('\n')}\n</testsuite>\n`;
}
