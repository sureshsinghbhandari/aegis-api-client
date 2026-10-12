import type { RunnerItemEvent, TreeNode } from '@aegis/core';

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

/** Escape for XML attribute and text content. */
export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** Escape for HTML text and attribute values (quotes included so it is safe inside attributes). */
export function escapeHtml(s: string): string {
  return s.replace(/[<>&"'`]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
}

/** Control characters are not allowed in XML 1.0; strip them so CI parsers accept the file. */
function xmlSafe(s: string): string {
  return escapeXml(s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''));
}

/**
 * JUnit XML of a run: one `<testsuite>` per iteration, one `<testcase>` per test
 * (a request without tests is one case; a transport error is a `<failure>`).
 */
export function resultsToJUnit(items: RunnerItemEvent[], suiteName: string): string {
  const groups = groupByIteration(items);
  const suites = groups.map((g) => {
    const cases: string[] = [];
    let failures = 0;
    let skipped = 0;
    for (const it of g.items) {
      const cls = xmlSafe(`${suiteName}.${it.name}`);
      if (it.tests.length === 0) {
        if (it.error) failures++;
        cases.push(`    <testcase classname="${cls}" name="${xmlSafe(`${it.method} ${it.url || it.name}`)}" time="${((it.durationMs ?? 0) / 1000).toFixed(3)}">${it.error ? `<failure message="${xmlSafe(it.error)}"/>` : ''}</testcase>`);
        continue;
      }
      for (const t of it.tests) {
        let inner = '';
        if (t.skipped) {
          skipped++;
          inner = '<skipped/>';
        } else if (!t.passed) {
          failures++;
          inner = `<failure message="${xmlSafe(t.error ?? 'failed')}"/>`;
        }
        cases.push(`    <testcase classname="${cls}" name="${xmlSafe(t.name)}" time="${(t.durationMs / 1000).toFixed(3)}">${inner}</testcase>`);
      }
      if (it.error && !it.tests.some((t) => !t.passed && !t.skipped)) {
        failures++;
        cases.push(`    <testcase classname="${cls}" name="${xmlSafe('request')}" time="0.000"><failure message="${xmlSafe(it.error)}"/></testcase>`);
      }
    }
    const time = (g.items.reduce((n, i) => n + (i.durationMs ?? 0), 0) / 1000).toFixed(3);
    return `  <testsuite name="${xmlSafe(groups.length > 1 ? `${suiteName} (iteration ${g.iteration + 1})` : suiteName)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${time}">\n${cases.join('\n')}\n  </testsuite>`;
  });
  const total = suites.length ? items.reduce((n, i) => n + Math.max(1, i.tests.length), 0) : 0;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xmlSafe(suiteName)}" tests="${total}">\n${suites.join('\n')}\n</testsuites>\n`;
}

/**
 * Self-contained HTML report (no scripts, no external resources). Every value
 * that comes from the run (names, URLs, errors, response bodies) is escaped.
 */
export function resultsToHtml(items: RunnerItemEvent[], meta: { label: string; status?: string; startedAt?: number }): string {
  const s = summarizeItems(items);
  const groups = groupByIteration(items);
  const e = escapeHtml;
  const rows = groups
    .map((g) => {
      const head = groups.length > 1 ? `<tr class="iter"><th colspan="6">Iteration ${g.iteration + 1}${g.failed ? ` · ${g.failed} failed` : ''}</th></tr>` : '';
      const body = g.items
        .map((it) => {
          const tests = it.tests.map((t) => `<li class="${t.skipped ? 'skip' : t.passed ? 'pass' : 'fail'}">${t.skipped ? '○' : t.passed ? '✓' : '✗'} ${e(t.name)}${t.error ? `<div class="err">${e(t.error)}</div>` : ''}</li>`).join('');
          const response = it.response
            ? `<details><summary>Response ${it.response.status} ${e(it.response.statusText)} · ${e(it.response.contentType || 'no content type')} · ${it.response.size} bytes${it.response.bodyTruncated ? ' (truncated)' : ''}</summary><pre class="hdr">${it.response.headers.map((h) => `${e(h.name)}: ${e(h.value)}`).join('\n')}</pre><pre>${e(it.response.body)}</pre></details>`
            : '';
          return `<tr class="${it.passed ? 'pass' : 'fail'}"><td>${it.passed ? '✓' : '✗'}</td><td>${e(it.name)}</td><td><code>${e(it.method)}</code> ${e(it.url)}</td><td>${it.statusCode ?? 'ERR'}</td><td>${it.durationMs === null ? '—' : `${Math.round(it.durationMs)} ms`}</td><td>${it.error ? `<div class="err">${e(it.error)}</div>` : ''}${tests ? `<ul>${tests}</ul>` : ''}${response}</td></tr>`;
        })
        .join('');
      return head + body;
    })
    .join('');
  const when = meta.startedAt ? new Date(meta.startedAt).toISOString() : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${e(meta.label)} - run report</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 8px;vertical-align:top;text-align:left}tr.pass>td:first-child{color:#1a7f37}tr.fail>td:first-child{color:#c62828}tr.iter th{background:#f3f3f3}ul{margin:4px 0;padding-left:18px}li.fail{color:#c62828}li.skip{color:#777}.err{color:#c62828;white-space:pre-wrap}pre{background:#f7f7f7;padding:6px;overflow:auto;max-height:240px;white-space:pre-wrap;word-break:break-all}pre.hdr{color:#555}summary{cursor:pointer}.sum span{margin-right:16px}</style></head>
<body><h1>${e(meta.label)}</h1>
<p class="sum"><span>Status: <strong>${e(meta.status ?? 'completed')}</strong></span><span>Requests: ${s.requests}</span><span>Failed requests: ${s.failedRequests}</span><span>Tests passed: ${s.testsPassed}</span><span>Tests failed: ${s.testsFailed}</span><span>Duration: ${Math.round(s.durationMs)} ms</span>${when ? `<span>Started: ${e(when)}</span>` : ''}</p>
<table><thead><tr><th></th><th>Request</th><th>URL</th><th>Status</th><th>Time</th><th>Tests / details</th></tr></thead><tbody>${rows}</tbody></table>
<p>Generated by Aegis API Client. Stored responses are redacted: sensitive headers are removed and credential patterns masked.</p>
</body></html>
`;
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

// ----------------------------------------------------------------------------- request selection

export interface RunnableNode {
  id: string;
  name: string;
  method: string;
  /** Folder path for display, e.g. "Users / Admin". */
  path: string;
}

/** Requests of a collection (or one folder subtree) in depth-first tree order: the order the runner uses by default. */
export function runnableRequestsInScope(tree: readonly TreeNode[], folderId: string | null): RunnableNode[] {
  const byParent = new Map<string | null, TreeNode[]>();
  for (const n of tree) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n]);
  for (const list of byParent.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
  const out: RunnableNode[] = [];
  const walk = (parent: string | null, path: string) => {
    for (const n of byParent.get(parent) ?? []) {
      if (n.kind === 'folder') walk(n.id, path ? `${path} / ${n.name}` : n.name);
      else out.push({ id: n.id, name: n.name, method: n.method ?? 'GET', path });
    }
  };
  walk(folderId, '');
  return out;
}

/** Move `id` by `delta` positions (negative = up); unknown ids and out-of-range moves return the same array. */
export function moveId(order: readonly string[], id: string, delta: number): string[] {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= order.length) return [...order];
  const out = [...order];
  out.splice(from, 1);
  out.splice(to, 0, id);
  return out;
}

/**
 * The `requestIds` to send: `undefined` when the selection equals the default
 * (every request, tree order), otherwise the selected ids in the chosen order.
 */
export function requestIdsForRun(order: readonly string[], selected: ReadonlySet<string>, defaultOrder: readonly string[]): string[] | undefined {
  const chosen = order.filter((id) => selected.has(id));
  if (chosen.length === defaultOrder.length && chosen.every((id, i) => id === defaultOrder[i])) return undefined;
  return chosen;
}

/** Iterations that will actually run: capped by the number of data rows when a data file is used. */
export function effectiveIterations(requested: number, dataRows: number | null): number {
  const n = Math.max(1, Math.floor(requested) || 1);
  return dataRows && dataRows > 0 ? Math.min(n, dataRows) : n;
}
