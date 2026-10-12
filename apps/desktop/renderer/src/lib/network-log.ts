/**
 * Builds the console's network log from execution results (renderer side, no engine changes).
 * Every entry carries redacted headers only: credentials never reach the console store.
 */
import { newId, type ConsoleEntry, type ExecutionResult, type HeaderPair, type RunnerItemEvent } from '@aegis/core';

export const REDACTED_VALUE = '[REDACTED]';

/** Header names whose values are never shown in the network log (case-insensitive). */
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-amz-security-token|x-csrf-token|x-xsrf-token)$|token$|secret|password|credential|api[-_]?key/i;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER.test(name.trim());
}

export function redactHeaderPairs(headers: readonly HeaderPair[]): HeaderPair[] {
  return headers.map((h) => (isSensitiveHeader(h.name) ? { name: h.name, value: REDACTED_VALUE } : { name: h.name, value: h.value }));
}

export interface NetworkLogEntry {
  id: string;
  kind: 'network';
  timestamp: number;
  /** Where the call came from. */
  source: 'request' | 'runner' | 'script';
  /** Label shown in the "request" column (request name or runner item name). */
  request: string;
  executionId?: string;
  method: string;
  url: string;
  status: number | null;
  statusText: string;
  durationMs: number | null;
  /** Response body size in bytes when known. */
  size: number | null;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  error?: string;
  note?: string;
}

const base = (): Pick<NetworkLogEntry, 'id' | 'kind' | 'requestHeaders' | 'responseHeaders' | 'statusText' | 'size' | 'durationMs' | 'status'> => ({
  id: newId(),
  kind: 'network',
  status: null,
  statusText: '',
  durationMs: null,
  size: null,
  requestHeaders: [],
  responseHeaders: [],
});

/** Nested `pm.sendRequest` calls as logged by the sandbox (`-> METHOD url` followed by `<- STATUS ... N ms`). */
export function parseScriptRequests(entries: readonly ConsoleEntry[]): Array<{ method: string; url: string; status: number | null; statusText: string; durationMs: number | null; timestamp: number; origin?: string }> {
  const out: Array<{ method: string; url: string; status: number | null; statusText: string; durationMs: number | null; timestamp: number; origin?: string }> = [];
  let pending: { method: string; url: string; timestamp: number; origin?: string } | null = null;
  for (const e of entries) {
    const open = /^->\s+([A-Za-z]+)\s+(\S+)/.exec(e.message);
    if (open) {
      if (pending) out.push({ ...pending, status: null, statusText: '', durationMs: null });
      pending = { method: open[1]!.toUpperCase(), url: open[2]!, timestamp: e.timestamp, ...(e.origin ? { origin: e.origin } : {}) };
      continue;
    }
    const close = /^<-\s+(\d{3})\b(.*)$/.exec(e.message);
    if (close && pending) {
      const rest = close[2] ?? '';
      const duration = /(\d+(?:\.\d+)?)\s*ms\b/.exec(rest);
      const statusText = rest
        .replace(/\(?\s*\d+(?:\.\d+)?\s*ms\s*\)?/, '')
        .replace(/[()·|-]+$/g, '')
        .trim();
      out.push({ ...pending, status: Number(close[1]), statusText, durationMs: duration ? Number(duration[1]) : null });
      pending = null;
    }
  }
  if (pending) out.push({ ...pending, status: null, statusText: '', durationMs: null });
  return out;
}

/** Entries for one send: the main request (even when it failed) plus any `pm.sendRequest` calls visible in the console. */
export function entriesFromResult(result: ExecutionResult, options: { request: string; executionId: string; now?: () => number; fallbackMethod?: string; fallbackUrl?: string }): NetworkLogEntry[] {
  const now = options.now ?? Date.now;
  const out: NetworkLogEntry[] = [];
  const response = result.response;
  const main: NetworkLogEntry = {
    ...base(),
    timestamp: response?.timings.startedAt ?? now(),
    source: 'request',
    request: options.request,
    executionId: options.executionId,
    method: result.request?.method ?? options.fallbackMethod ?? '?',
    url: result.request?.url ?? options.fallbackUrl ?? '',
    requestHeaders: redactHeaderPairs(result.request?.headers ?? []),
  };
  if (response) {
    main.status = response.status;
    main.statusText = response.statusText;
    main.durationMs = response.timings.totalMs;
    main.size = response.size;
    main.responseHeaders = redactHeaderPairs(response.headers);
    if (response.redirects.length) main.note = `${response.redirects.length} redirect(s) · final URL ${response.url}`;
  }
  if (result.error) main.error = `${result.error.code}: ${result.error.message}`;
  if (result.skipped) main.note = 'Skipped by a pre-request script';
  for (const s of parseScriptRequests(result.console)) {
    out.push({
      ...base(),
      timestamp: s.timestamp,
      source: 'script',
      request: `${options.request} · pm.sendRequest`,
      executionId: options.executionId,
      method: s.method,
      url: s.url,
      status: s.status,
      statusText: s.statusText,
      durationMs: s.durationMs,
      ...(s.origin ? { note: s.origin } : {}),
    });
  }
  // Keep chronological order: nested calls from the pre-request phase happen before the main request.
  out.push(main);
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

export function entryFromRunnerItem(ev: RunnerItemEvent, options: { now?: () => number; label?: string } = {}): NetworkLogEntry {
  const now = options.now ?? Date.now;
  return {
    ...base(),
    timestamp: now(),
    source: 'runner',
    request: `${options.label ?? 'Runner'} #${ev.iteration + 1}.${ev.index + 1} ${ev.name}`,
    method: ev.method,
    url: ev.url,
    status: ev.statusCode,
    statusText: ev.passed ? '' : 'failed',
    durationMs: ev.durationMs,
    ...(ev.error ? { error: ev.error } : {}),
    note: `${ev.tests.filter((t) => t.passed).length}/${ev.tests.length} tests passed`,
  };
}

export type ConsoleKindFilter = 'all' | 'scripts' | 'network';
export type ConsoleLevelFilter = 'all' | 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ScriptConsoleLine extends ConsoleEntry {
  id: string;
  request: string;
}

export type ConsoleRow<L extends ScriptConsoleLine = ScriptConsoleLine> = { kind: 'script'; line: L } | { kind: 'network'; entry: NetworkLogEntry };

/** Script output and the network log, merged chronologically and filtered. Pure, so it can be unit tested. */
export function mergeConsoleRows<L extends ScriptConsoleLine>(lines: readonly L[], network: readonly NetworkLogEntry[], filter: { kind: ConsoleKindFilter; level: ConsoleLevelFilter; text: string }): Array<ConsoleRow<L>> {
  const q = filter.text.trim().toLowerCase();
  const rows: Array<ConsoleRow<L>> = [];
  if (filter.kind !== 'network') {
    for (const line of lines) {
      if (filter.level !== 'all' && line.level !== filter.level) continue;
      if (q && !line.message.toLowerCase().includes(q) && !line.request.toLowerCase().includes(q)) continue;
      rows.push({ kind: 'script', line });
    }
  }
  if (filter.kind !== 'scripts' && (filter.level === 'all' || filter.level === 'error')) {
    for (const entry of network) {
      if (filter.level === 'error' && !entry.error && (entry.status === null || entry.status < 400)) continue;
      const hay = `${entry.method} ${entry.url} ${entry.request} ${entry.status ?? ''} ${entry.error ?? ''}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      rows.push({ kind: 'network', entry });
    }
  }
  return rows.sort((a, b) => (a.kind === 'script' ? a.line.timestamp : a.entry.timestamp) - (b.kind === 'script' ? b.line.timestamp : b.entry.timestamp));
}

/** One-line text form (for "Copy all"). */
export function networkEntryText(e: NetworkLogEntry): string {
  const status = e.status !== null ? `${e.status}${e.statusText ? ' ' + e.statusText : ''}` : e.error ? 'ERROR' : '-';
  const dur = e.durationMs !== null ? `${Math.round(e.durationMs)} ms` : '-';
  const size = e.size !== null ? `${e.size} B` : '-';
  return `${e.method} ${e.url} → ${status} · ${dur} · ${size}${e.error ? ` · ${e.error}` : ''}`;
}
