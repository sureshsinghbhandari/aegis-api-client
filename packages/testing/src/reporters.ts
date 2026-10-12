import type { RunItem, RunReport } from './runner';

/**
 * Report renderers shared by the CLI (`apps/cli`) and the desktop runner exports.
 *
 * Security notes
 *  - Every value that ends up in HTML or XML goes through `escapeHtml` / `escapeXml`. Request names,
 *    test names, error messages and URLs all come from untrusted collection files or from remote servers.
 *  - The HTML report is a single self-contained file: inline CSS only, no scripts, no remote assets, and
 *    URLs are rendered as text (never as `href`), so `javascript:` URLs cannot become links.
 */

export type ReporterName = 'cli' | 'json' | 'junit' | 'html';

export const REPORTER_NAMES: readonly ReporterName[] = ['cli', 'json', 'junit', 'html'];

export function isReporterName(value: string): value is ReporterName {
  return (REPORTER_NAMES as readonly string[]).includes(value);
}

/** Context that is not part of `RunReport` but belongs in a report. */
export interface ReportMeta {
  /** Collection (suite) name. */
  name: string;
  environment?: string | null;
  /** ISO timestamps. */
  startedAt?: string;
  finishedAt?: string;
  /** Tool identification shown in the report footer. */
  generator?: string;
}

export interface CliReporterOptions {
  color?: boolean;
  /** Width of the name column. Default 40. */
  nameWidth?: number;
}

// ---------------------------------------------------------------- escaping

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escape for HTML text and attribute values (quoted attributes). */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]!);
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * Escape for XML text and attribute values. Characters that are not legal in XML 1.0 (most C0 control
 * characters, lone surrogates) are replaced so that the document always stays well-formed.
 */
export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '�')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
    .replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

// ---------------------------------------------------------------- cli

const ANSI = {
  reset: '\u001b[0m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
};

function paint(color: boolean, code: string, text: string): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

/** Remove control characters so a hostile request name cannot inject terminal escape sequences. */
export function sanitizeForTerminal(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '').replace(/\t/g, ' ');
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** One line per executed request: `✓ Login                                    200    182ms`. */
export function formatCliItem(item: RunItem, options: CliReporterOptions = {}): string {
  const color = options.color ?? false;
  const width = options.nameWidth ?? 40;
  const mark = item.passed ? paint(color, ANSI.green, '✓') : paint(color, ANSI.red, '✗');
  const name = truncate(sanitizeForTerminal(item.request.name), width).padEnd(width);
  const status = item.statusCode === null ? '---' : String(item.statusCode);
  const ms = item.durationMs === null ? '' : `${item.durationMs}ms`;
  const head = `${mark} ${name} ${status.padStart(3)} ${ms.padStart(8)}`;
  const lines = [item.error ? `${head}  ${paint(color, ANSI.red, sanitizeForTerminal(item.error))}` : head];
  for (const t of item.tests) {
    const tmark = t.passed ? paint(color, ANSI.green, '✓') : t.skipped ? paint(color, ANSI.yellow, '-') : paint(color, ANSI.red, '✗');
    const detail = !t.passed && !t.skipped && t.error ? paint(color, ANSI.dim, `  ${sanitizeForTerminal(t.error)}`) : '';
    lines.push(`    ${tmark} ${sanitizeForTerminal(t.name)}${detail}`);
  }
  return lines.join('\n');
}

/** Summary block printed after the last item. */
export function formatCliSummary(report: RunReport, meta: ReportMeta, options: CliReporterOptions = {}): string {
  const color = options.color ?? false;
  const skipped = report.items.reduce((n, i) => n + i.tests.filter((t) => t.skipped).length, 0);
  const rows: Array<[string, string]> = [
    ['collection', sanitizeForTerminal(meta.name)],
    ...(meta.environment ? ([['environment', sanitizeForTerminal(meta.environment)]] as Array<[string, string]>) : []),
    ['iterations', String(report.iterationCount)],
    ['requests', `${report.totalRequests} executed, ${report.failedRequests} failed`],
    ['tests', `${report.passedTests} passed, ${report.failedTests} failed${skipped ? `, ${skipped} skipped` : ''}`],
    ['duration', `${report.durationMs}ms`],
    ['status', report.status],
  ];
  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  const ok = report.status === 'completed' && report.failedTests === 0 && report.failedRequests === 0;
  const headline = ok ? paint(color, ANSI.green + ANSI.bold, 'PASSED') : paint(color, ANSI.red + ANSI.bold, 'FAILED');
  return ['', ...rows.map(([k, v]) => `  ${k.padEnd(labelWidth)}  ${v}`), '', `  ${headline}`].join('\n');
}

/** Complete text report (items + summary). */
export function cliReporter(report: RunReport, meta: ReportMeta, options: CliReporterOptions = {}): string {
  return [...report.items.map((i) => formatCliItem(i, options)), formatCliSummary(report, meta, options)].join('\n');
}

// ---------------------------------------------------------------- json

export interface JsonReportDocument {
  format: 'aegis-run-report';
  version: 1;
  generator: string;
  collection: string;
  environment: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  status: RunReport['status'];
  summary: {
    iterations: number;
    requests: number;
    failedRequests: number;
    tests: number;
    passedTests: number;
    failedTests: number;
    skippedTests: number;
    durationMs: number;
  };
  items: Array<{
    index: number;
    iteration: number;
    requestId: string;
    name: string;
    method: string;
    url: string;
    statusCode: number | null;
    durationMs: number | null;
    passed: boolean;
    error: string | null;
    tests: Array<{ name: string; passed: boolean; skipped: boolean; durationMs: number; error: string | null }>;
  }>;
}

export function buildJsonReport(report: RunReport, meta: ReportMeta): JsonReportDocument {
  const skippedTests = report.items.reduce((n, i) => n + i.tests.filter((t) => t.skipped).length, 0);
  return {
    format: 'aegis-run-report',
    version: 1,
    generator: meta.generator ?? 'aegis',
    collection: meta.name,
    environment: meta.environment ?? null,
    startedAt: meta.startedAt ?? null,
    finishedAt: meta.finishedAt ?? null,
    status: report.status,
    summary: {
      iterations: report.iterationCount,
      requests: report.totalRequests,
      failedRequests: report.failedRequests,
      tests: report.passedTests + report.failedTests + skippedTests,
      passedTests: report.passedTests,
      failedTests: report.failedTests,
      skippedTests,
      durationMs: report.durationMs,
    },
    items: report.items.map((i) => ({
      index: i.index,
      iteration: i.iteration,
      requestId: i.request.id,
      name: i.request.name,
      method: i.method,
      url: i.url,
      statusCode: i.statusCode,
      durationMs: i.durationMs,
      passed: i.passed,
      error: i.error ?? null,
      tests: i.tests.map((t) => ({ name: t.name, passed: t.passed, skipped: t.skipped === true, durationMs: t.durationMs, error: t.error ?? null })),
    })),
  };
}

export function jsonReporter(report: RunReport, meta: ReportMeta): string {
  return `${JSON.stringify(buildJsonReport(report, meta), null, 2)}\n`;
}

// ---------------------------------------------------------------- junit

/**
 * JUnit XML (the `<testsuites>` dialect understood by Jenkins, GitLab, Azure DevOps, GitHub Actions
 * reporters). One `<testsuite>` per iteration, one `<testcase>` per test; a request without tests becomes
 * a single case that fails when the request itself failed. Request method/URL/status go to `<system-out>`.
 */
export function junitReporter(report: RunReport, meta: ReportMeta): string {
  const suiteName = meta.name;
  const perIteration = new Map<number, RunItem[]>();
  for (const item of report.items) perIteration.set(item.iteration, [...(perIteration.get(item.iteration) ?? []), item]);

  const suites: string[] = [];
  let totalTests = 0;
  let totalFailures = 0;
  let totalSkipped = 0;
  for (const [iteration, items] of [...perIteration.entries()].sort((a, b) => a[0] - b[0])) {
    const cases: string[] = [];
    let failures = 0;
    let skipped = 0;
    let time = 0;
    for (const item of items) {
      const out = `${escapeXml(item.method)} ${escapeXml(item.url)} -> ${item.statusCode ?? 'no response'}${item.durationMs !== null ? ` (${item.durationMs}ms)` : ''}`;
      time += (item.durationMs ?? 0) / 1000;
      const requestFailed = !!item.error;
      if (item.tests.length === 0) {
        if (requestFailed) failures++;
        cases.push(
          `    <testcase classname="${escapeXml(suiteName)}" name="${escapeXml(item.request.name)}" time="${((item.durationMs ?? 0) / 1000).toFixed(3)}">` +
            (requestFailed ? `<failure message="${escapeXml(item.error)}" type="RequestError">${escapeXml(item.error)}</failure>` : '') +
            `<system-out>${out}</system-out></testcase>`,
        );
        continue;
      }
      for (const t of item.tests) {
        let body = '';
        if (t.skipped) {
          skipped++;
          body = '<skipped/>';
        } else if (!t.passed) {
          failures++;
          body = `<failure message="${escapeXml(t.error ?? 'failed')}" type="AssertionError">${escapeXml(t.error ?? 'failed')}</failure>`;
        }
        cases.push(`    <testcase classname="${escapeXml(`${suiteName}.${item.request.name}`)}" name="${escapeXml(t.name)}" time="${(t.durationMs / 1000).toFixed(3)}">${body}<system-out>${out}</system-out></testcase>`);
      }
      if (requestFailed && item.tests.every((t) => t.passed || t.skipped)) {
        // Transport/script error without a failing assertion: still surface it as a failure.
        failures++;
        cases.push(`    <testcase classname="${escapeXml(suiteName)}" name="${escapeXml(`${item.request.name} (request)`)}" time="0.000"><failure message="${escapeXml(item.error)}" type="RequestError">${escapeXml(item.error)}</failure><system-out>${out}</system-out></testcase>`);
      }
    }
    totalTests += cases.length;
    totalFailures += failures;
    totalSkipped += skipped;
    const label = perIteration.size > 1 ? `${suiteName} (iteration ${iteration + 1})` : suiteName;
    suites.push(
      `  <testsuite name="${escapeXml(label)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="${skipped}" time="${time.toFixed(3)}"${meta.startedAt ? ` timestamp="${escapeXml(meta.startedAt)}"` : ''}>\n` +
        (meta.environment ? `    <properties><property name="environment" value="${escapeXml(meta.environment)}"/></properties>\n` : '') +
        `${cases.join('\n')}\n  </testsuite>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="${escapeXml(suiteName)}" tests="${totalTests}" failures="${totalFailures}" errors="0" skipped="${totalSkipped}" time="${(report.durationMs / 1000).toFixed(3)}">\n` +
    `${suites.join('\n')}\n</testsuites>\n`
  );
}

// ---------------------------------------------------------------- html

const HTML_CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--chip:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--chip:#1c2128}}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}.muted{color:var(--muted)}
.summary{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}.card{border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:120px;background:var(--chip)}
.card .k{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}.card .v{font-size:20px;font-weight:600}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--muted);font-size:12px}
code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
details{margin:2px 0}summary{cursor:pointer}ul.tests{margin:4px 0 0 0;padding-left:18px}ul.tests li{margin:2px 0}
.badge{display:inline-block;padding:0 6px;border-radius:10px;font-size:12px;border:1px solid var(--line)}
footer{margin-top:24px;font-size:12px;color:var(--muted)}
`;

/** Self-contained HTML report. No scripts, no external resources; every interpolated value is escaped. */
export function htmlReporter(report: RunReport, meta: ReportMeta): string {
  const e = escapeHtml;
  const skippedTests = report.items.reduce((n, i) => n + i.tests.filter((t) => t.skipped).length, 0);
  const ok = report.status === 'completed' && report.failedTests === 0 && report.failedRequests === 0;
  const card = (k: string, v: string, cls = '') => `<div class="card"><div class="k">${e(k)}</div><div class="v ${cls}">${e(v)}</div></div>`;
  const rows = report.items
    .map((i) => {
      const tests = i.tests.length
        ? `<ul class="tests">${i.tests
            .map((t) => {
              const cls = t.passed ? 'ok' : t.skipped ? 'warn' : 'bad';
              const mark = t.passed ? '&#10003;' : t.skipped ? '&ndash;' : '&#10007;';
              const err = !t.passed && !t.skipped && t.error ? ` <span class="muted">&mdash; ${e(t.error)}</span>` : '';
              return `<li><span class="${cls}">${mark}</span> ${e(t.name)}${err}</li>`;
            })
            .join('')}</ul>`
        : '<span class="muted">no tests</span>';
      const error = i.error ? `<div class="bad">${e(i.error)}</div>` : '';
      const failedCount = i.tests.filter((t) => !t.passed && !t.skipped).length;
      const summary = `${i.tests.length} test${i.tests.length === 1 ? '' : 's'}${failedCount ? `, ${failedCount} failed` : ''}`;
      return (
        `<tr><td>${i.index + 1}</td><td>${i.iteration + 1}</td>` +
        `<td><span class="${i.passed ? 'ok' : 'bad'}">${i.passed ? '&#10003;' : '&#10007;'}</span></td>` +
        `<td>${e(i.request.name)}${error}</td>` +
        `<td><code>${e(i.method)} ${e(i.url)}</code></td>` +
        `<td>${i.statusCode === null ? '<span class="muted">&mdash;</span>' : e(String(i.statusCode))}</td>` +
        `<td>${i.durationMs === null ? '<span class="muted">&mdash;</span>' : `${e(String(i.durationMs))}&nbsp;ms`}</td>` +
        `<td><details><summary>${e(summary)}</summary>${tests}</details></td></tr>`
      );
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${e(meta.name)} &middot; run report</title>
<style>${HTML_CSS}</style>
</head>
<body>
<h1>${e(meta.name)}</h1>
<div class="muted">${meta.environment ? `Environment: ${e(meta.environment)} &middot; ` : ''}${meta.startedAt ? `Started ${e(meta.startedAt)}` : ''}${meta.finishedAt ? ` &middot; Finished ${e(meta.finishedAt)}` : ''}</div>
<div class="summary">
${card('Result', ok ? 'PASSED' : 'FAILED', ok ? 'ok' : 'bad')}
${card('Status', report.status)}
${card('Iterations', String(report.iterationCount))}
${card('Requests', `${report.totalRequests} / ${report.failedRequests} failed`, report.failedRequests ? 'bad' : '')}
${card('Tests passed', String(report.passedTests), 'ok')}
${card('Tests failed', String(report.failedTests), report.failedTests ? 'bad' : '')}
${skippedTests ? card('Tests skipped', String(skippedTests), 'warn') : ''}
${card('Duration', `${report.durationMs} ms`)}
</div>
<h2>Requests</h2>
<table>
<thead><tr><th>#</th><th>Iter.</th><th></th><th>Request</th><th>Method &amp; URL</th><th>Status</th><th>Time</th><th>Tests</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<footer>Generated by ${e(meta.generator ?? 'Aegis API Client')}. This file contains no scripts and loads no external resources.</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------- dispatch

export interface RenderOptions {
  cli?: CliReporterOptions;
}

/** Render `report` with the named reporter. */
export function renderReport(name: ReporterName, report: RunReport, meta: ReportMeta, options: RenderOptions = {}): string {
  switch (name) {
    case 'cli':
      return cliReporter(report, meta, options.cli);
    case 'json':
      return jsonReporter(report, meta);
    case 'junit':
      return junitReporter(report, meta);
    case 'html':
      return htmlReporter(report, meta);
  }
}

/** Conventional file extension for a reporter's export. */
export function reporterExtension(name: ReporterName): string {
  return name === 'cli' ? 'txt' : name === 'junit' ? 'xml' : name;
}
