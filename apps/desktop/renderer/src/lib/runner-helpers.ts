import type { RunnerItemEvent } from '@aegis/core';

/** One line in the exact live style: "✓ Login   200   182ms" / "✗ Update User  400  121ms". */
export function formatRunnerRow(item: Pick<RunnerItemEvent, 'name' | 'passed' | 'statusCode' | 'durationMs'>): string {
  const mark = item.passed ? '✓' : '✗';
  const status = item.statusCode === null ? 'ERR' : String(item.statusCode);
  const ms = item.durationMs === null ? '—' : `${Math.round(item.durationMs)}ms`;
  return `${mark} ${item.name}   ${status}   ${ms}`;
}

export interface IterationGroup {
  iteration: number;
  items: RunnerItemEvent[];
  failed: number;
}

/** Group items by iteration (ascending); within an iteration items are ordered by index. */
export function groupByIteration(items: RunnerItemEvent[]): IterationGroup[] {
  const map = new Map<number, RunnerItemEvent[]>();
  for (const it of items) {
    const list = map.get(it.iteration) ?? [];
    list.push(it);
    map.set(it.iteration, list);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([iteration, list]) => {
      const sorted = list.slice().sort((a, b) => a.index - b.index);
      return { iteration, items: sorted, failed: sorted.filter((i) => !i.passed).length };
    });
}

export interface RunSummaryStats {
  requests: number;
  failedRequests: number;
  testsPassed: number;
  testsFailed: number;
  durationMs: number;
}

export function summarizeItems(items: RunnerItemEvent[]): RunSummaryStats {
  let testsPassed = 0;
  let testsFailed = 0;
  let durationMs = 0;
  let failedRequests = 0;
  for (const it of items) {
    if (!it.passed) failedRequests++;
    durationMs += it.durationMs ?? 0;
    for (const t of it.tests) {
      if (t.skipped) continue;
      if (t.passed) testsPassed++;
      else testsFailed++;
    }
  }
  return { requests: items.length, failedRequests, testsPassed, testsFailed, durationMs };
}

/** Quote a CSV cell and neutralize spreadsheet formula injection (cells starting with = + - @ or control chars). */
export function csvCell(value: string | number | boolean | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function resultsToCsv(items: RunnerItemEvent[]): string {
  const header = ['iteration', 'index', 'name', 'method', 'url', 'status', 'durationMs', 'passed', 'testsPassed', 'testsFailed', 'error'];
  const lines = [header.join(',')];
  for (const it of items) {
    const failed = it.tests.filter((t) => !t.passed && !t.skipped).length;
    const ok = it.tests.filter((t) => t.passed && !t.skipped).length;
    lines.push([it.iteration, it.index, it.name, it.method, it.url, it.statusCode, it.durationMs, it.passed, ok, failed, it.error ?? ''].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export function resultsToJson(items: RunnerItemEvent[], meta: { runId?: string; label?: string; status?: string }): string {
  return JSON.stringify({ ...meta, summary: summarizeItems(items), results: items }, null, 2);
}

// ----------------------------------------------------------------------------- data file preview

export interface DataPreview {
  format: 'csv' | 'json';
  headers: string[];
  rows: string[][];
  /** Total number of data rows in the file (rows.length is limited to the preview size). */
  rowCount: number;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/** Preview a CSV (first row = header) or JSON (array of objects) data file. Returns an error string on failure. */
export function previewDataFile(fileName: string, content: string, maxRows = 5): DataPreview | { error: string } {
  const isJson = /\.json$/i.test(fileName) || /^\s*[[{]/.test(content);
  if (isJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { error: 'The file is not valid JSON.' };
    }
    if (!Array.isArray(parsed)) return { error: 'The JSON data file must be an array of objects, e.g. [{"user":"a"},{"user":"b"}].' };
    const objects = parsed.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x));
    if (objects.length === 0) return { error: 'The JSON array contains no objects.' };
    const headers: string[] = [];
    for (const o of objects.slice(0, 200)) for (const k of Object.keys(o)) if (!headers.includes(k)) headers.push(k);
    const cell = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    return { format: 'json', headers, rows: objects.slice(0, maxRows).map((o) => headers.map((h) => cell(o[h]))), rowCount: objects.length };
  }
  const table = parseCsv(content);
  if (table.length < 2) return { error: 'The CSV needs a header row and at least one data row.' };
  const [headers, ...data] = table as [string[], ...string[][]];
  return { format: 'csv', headers, rows: data.slice(0, maxRows), rowCount: data.length };
}

/** Iterations that will actually run: capped by the number of data rows when a data file is used. */
export function effectiveIterations(requested: number, dataRows: number | null): number {
  const n = Math.max(1, Math.floor(requested) || 1);
  return dataRows && dataRows > 0 ? Math.min(n, dataRows) : n;
}
