import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import {
  buildJsonReport,
  cliReporter,
  escapeHtml,
  escapeXml,
  formatCliItem,
  formatCliSummary,
  htmlReporter,
  isReporterName,
  jsonReporter,
  junitReporter,
  renderReport,
  reporterExtension,
  sanitizeForTerminal,
  type ReportMeta,
  type RunItem,
  type RunReport,
} from '@aegis/testing';

/** Hostile strings that must never reach the HTML/XML output unescaped. */
const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
  "' onmouseover='alert(1)",
  'javascript:alert(1)',
  '</td></tr></table><iframe src="https://evil.example"></iframe>',
  '&lt;already-escaped&gt;',
  ']]><!--',
  '<!ENTITY xxe SYSTEM "file:///etc/passwd">',
  '`${process.env.SECRET}`',
  'ctrl\u0000\u0007chars\u001b[31mred',
];

function item(over: Partial<RunItem> & { name?: string } = {}): RunItem {
  const { name, ...rest } = over;
  return {
    index: 0,
    iteration: 0,
    request: { id: 'r1', name: name ?? 'Login', method: 'POST', url: 'https://api.example.test/login' },
    statusCode: 200,
    durationMs: 182,
    method: 'POST',
    url: 'https://api.example.test/login',
    passed: true,
    tests: [{ name: 'status is 200', passed: true, durationMs: 1 }],
    ...rest,
  };
}

function report(items: RunItem[], over: Partial<RunReport> = {}): RunReport {
  const failedTests = items.reduce((n, i) => n + i.tests.filter((t) => !t.passed && !t.skipped).length, 0);
  const passedTests = items.reduce((n, i) => n + i.tests.filter((t) => t.passed).length, 0);
  return {
    status: 'completed',
    items,
    totalRequests: items.length,
    passedTests,
    failedTests,
    failedRequests: items.filter((i) => !i.passed).length,
    durationMs: 1234,
    iterationCount: items.reduce((n, i) => Math.max(n, i.iteration + 1), 0),
    ...over,
  };
}

const meta: ReportMeta = { name: 'Kitchen sink', environment: 'Staging', startedAt: '2026-10-12T10:00:00.000Z', finishedAt: '2026-10-12T10:00:01.234Z', generator: 'test' };

/** One report whose every free-text field carries a payload. */
function hostileReport(): { report: RunReport; meta: ReportMeta } {
  const items = XSS.map((p, idx) =>
    item({
      index: idx,
      iteration: idx % 2,
      name: `req ${p}`,
      url: `https://x.test/${p}`,
      method: idx === 0 ? `GET${p}` : 'GET',
      passed: false,
      error: `boom ${p}`,
      tests: [
        { name: `test ${p}`, passed: false, durationMs: 2, error: `expected ${p}` },
        { name: `skipped ${p}`, passed: false, skipped: true, durationMs: 0 },
      ],
    }),
  );
  return { report: report(items, { status: 'failed' }), meta: { ...meta, name: `Suite ${XSS[0]}`, environment: `Env ${XSS[1]}` } };
}

describe('escaping primitives', () => {
  it('escapes every HTML metacharacter including quotes and backticks', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&\`</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
  it('escapes XML metacharacters and strips illegal control characters / lone surrogates', () => {
    expect(escapeXml(`<x a="1" b='2'>&</x>`)).toBe('&lt;x a=&quot;1&quot; b=&apos;2&apos;&gt;&amp;&lt;/x&gt;');
    expect(escapeXml('a\u0000b\u0007c\u001bd')).toBe('a�b�c�d');
    expect(escapeXml('tab\tand\nnewline')).toBe('tab\tand\nnewline');
    expect(escapeXml('lone\uD800surrogate')).toBe('lone�surrogate');
    expect(escapeXml('pair😀ok')).toBe('pair😀ok');
  });
  it('strips terminal control sequences from names', () => {
    expect(sanitizeForTerminal('a\u001b[31mred\u0007\u0000b')).toBe('a[31mredb');
    expect(sanitizeForTerminal('tab\there')).toBe('tab here');
  });
});

describe('cli reporter', () => {
  it('prints one line per request in the ✓ name status ms style and a summary', () => {
    const r = report([item(), item({ index: 1, name: 'Update User', statusCode: 400, durationMs: 12, passed: false, tests: [{ name: 'is 200', passed: false, durationMs: 1, error: 'expected 400 to equal 200' }] })]);
    const text = cliReporter(r, meta);
    expect(text).toMatch(/^✓ Login\s+200\s+182ms$/m);
    expect(text).toMatch(/^✗ Update User\s+400\s+12ms$/m);
    expect(text).toContain('    ✓ status is 200');
    expect(text).toContain('    ✗ is 200  expected 400 to equal 200');
    expect(text).toMatch(/^\s+requests\s+2 executed, 1 failed$/m);
    expect(text).toMatch(/^\s+tests\s+1 passed, 1 failed$/m);
    expect(text).toMatch(/^\s+collection\s+Kitchen sink$/m);
    expect(text).toMatch(/^\s+environment\s+Staging$/m);
    expect(text).toContain('FAILED');
    expect(text).not.toContain('\u001b[');
  });
  it('shows the transport error on the request line and PASSED when everything is green', () => {
    expect(formatCliItem(item({ statusCode: null, durationMs: null, passed: false, error: 'ECONNREFUSED', tests: [] }))).toMatch(/^✗ Login\s+---\s+ECONNREFUSED$/);
    expect(formatCliSummary(report([item()]), meta)).toContain('PASSED');
    expect(formatCliSummary(report([item()], { status: 'stopped' }), meta)).toContain('FAILED');
  });
  it('uses ANSI colours only when asked', () => {
    const r = report([item()]);
    expect(cliReporter(r, meta, { color: true })).toContain('\u001b[32m✓\u001b[0m');
    expect(cliReporter(r, meta, { color: false })).not.toContain('\u001b[');
    expect(cliReporter(r, meta)).not.toContain('\u001b[');
  });
  it('never emits control characters from hostile names', () => {
    const { report: r, meta: m } = hostileReport();
    const text = cliReporter(r, m);
    expect(text).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F]/);
    expect(text).toContain('✗ req <script>alert(1)</script>');
  });
});

describe('json reporter', () => {
  it('produces a stable, parseable document with summary and per-test details', () => {
    const r = report([item({ tests: [{ name: 'ok', passed: true, durationMs: 1 }, { name: 'skip', passed: false, skipped: true, durationMs: 0 }] })]);
    const doc = JSON.parse(jsonReporter(r, meta));
    expect(doc).toMatchObject({
      format: 'aegis-run-report',
      version: 1,
      collection: 'Kitchen sink',
      environment: 'Staging',
      startedAt: meta.startedAt,
      status: 'completed',
      summary: { iterations: 1, requests: 1, failedRequests: 0, tests: 2, passedTests: 1, failedTests: 0, skippedTests: 1, durationMs: 1234 },
    });
    expect(doc.items[0]).toMatchObject({ name: 'Login', method: 'POST', statusCode: 200, passed: true, error: null, tests: [{ name: 'ok', passed: true, skipped: false }, { name: 'skip', skipped: true }] });
    expect(buildJsonReport(r, { name: 'x' }).environment).toBeNull();
  });
  it('keeps hostile strings verbatim (JSON is the escaping)', () => {
    const { report: r, meta: m } = hostileReport();
    const doc = JSON.parse(jsonReporter(r, m));
    expect(doc.items[0].name).toBe(`req ${XSS[0]}`);
    expect(doc.items[0].tests[0].error).toBe(`expected ${XSS[0]}`);
  });
});

describe('junit reporter', () => {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

  it('is well-formed, one suite per iteration, one case per test, failures and skips marked', () => {
    const r = report([
      item({ tests: [{ name: 'ok', passed: true, durationMs: 5 }, { name: 'bad', passed: false, durationMs: 1, error: 'nope' }, { name: 'skip', passed: false, skipped: true, durationMs: 0 }], passed: false }),
      item({ index: 1, iteration: 1, name: 'No tests', tests: [], statusCode: null, durationMs: null, passed: false, error: 'socket hang up' }),
      item({ index: 2, iteration: 1, name: 'Script crash', tests: [{ name: 'ok', passed: true, durationMs: 1 }], passed: false, error: 'test script failed' }),
    ]);
    const xml = junitReporter(r, meta);
    expect(XMLValidator.validate(xml)).toBe(true);
    const doc = parser.parse(xml);
    expect(doc.testsuites['@_name']).toBe('Kitchen sink');
    expect(doc.testsuites['@_tests']).toBe('6');
    expect(doc.testsuites['@_failures']).toBe('3');
    expect(doc.testsuites['@_skipped']).toBe('1');
    const suites = doc.testsuites.testsuite;
    expect(suites).toHaveLength(2);
    expect(suites[0]['@_name']).toBe('Kitchen sink (iteration 1)');
    expect(suites[0]['@_timestamp']).toBe(meta.startedAt);
    expect(suites[0].properties.property['@_value']).toBe('Staging');
    const cases = suites[0].testcase;
    expect(cases.map((c: Record<string, unknown>) => c['@_name'])).toEqual(['ok', 'bad', 'skip']);
    expect(cases[1].failure['@_message']).toBe('nope');
    expect(cases[2].skipped).toBe('');
    expect(cases[0]['system-out']).toContain('POST https://api.example.test/login -> 200 (182ms)');
    const second = suites[1].testcase;
    expect(second[0]['@_name']).toBe('No tests');
    expect(second[0].failure['@_type']).toBe('RequestError');
    expect(second.map((c: Record<string, unknown>) => c['@_name'])).toContain('Script crash (request)');
  });

  it('escapes XSS / XXE payloads in names, tests, errors and URLs and stays well-formed', () => {
    const { report: r, meta: m } = hostileReport();
    const xml = junitReporter(r, m);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).not.toContain('<script');
    expect(xml).not.toContain('<iframe');
    expect(xml).not.toContain('<!ENTITY');
    expect(xml).not.toContain(']]>');
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(xml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(xml).toContain('name="test &lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(xml).toContain('https://x.test/&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(xml).toContain('&amp;lt;already-escaped&amp;gt;');
    // Nothing but our own element names appears as a tag.
    const tags = new Set([...xml.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m2) => m2[1]));
    expect([...tags].sort()).toEqual(['failure', 'properties', 'property', 'skipped', 'system-out', 'testcase', 'testsuite', 'testsuites']);
    const doc = parser.parse(xml);
    expect(doc.testsuites['@_name']).toBe(`Suite ${XSS[0]}`);
    expect(doc.testsuites.testsuite[0].testcase[0]['@_classname']).toBe(`Suite ${XSS[0]}.req ${XSS[0]}`);
  });
});

describe('html reporter', () => {
  it('is a single self-contained document: inline CSS, no scripts, no remote assets, no links', () => {
    const html = htmlReporter(report([item()]), meta);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<a\s/i);
    expect(html).not.toMatch(/\b(src|href)\s*=/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('Kitchen sink');
    expect(html).toContain('Environment: Staging');
    expect(html).toContain('PASSED');
    expect(html).toContain('status is 200');
    expect(html).toContain('182&nbsp;ms');
  });

  it('escapes every XSS payload in collection/env names, request names, URLs, methods, tests and errors', () => {
    const { report: r, meta: m } = hostileReport();
    const html = htmlReporter(r, m);
    for (const p of XSS) {
      if (p === '&lt;already-escaped&gt;') {
        expect(html).toContain('&amp;lt;already-escaped&amp;gt;');
        continue;
      }
      if (p.startsWith('ctrl')) continue;
      if (escapeHtml(p) !== p) expect(html, p).not.toContain(p); // payloads without metacharacters are harmless text
      expect(html, p).toContain(escapeHtml(p));
    }
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<svg/i);
    expect(html).not.toMatch(/<[^>]*\bon\w+\s*=/i); // no event handler attribute inside any tag
    // `javascript:` can only do harm inside an attribute; it must never appear in one.
    expect(html).not.toMatch(/=\s*["']?\s*javascript:/i);
    expect(html).not.toMatch(/<[^>]*\b(href|src)\s*=/i);
    // Only our own tags appear anywhere in the document.
    const tags = new Set([...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m2) => m2[1]!.toLowerCase()));
    const allowed = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'h1', 'h2', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'code', 'details', 'summary', 'ul', 'li', 'footer']);
    for (const t of tags) expect(allowed.has(t), `unexpected tag <${t}>`).toBe(true);
    expect(html).toContain('FAILED');
  });
});

describe('dispatch helpers', () => {
  it('renders by name and knows the file extensions', () => {
    const r = report([item()]);
    expect(renderReport('cli', r, meta)).toContain('✓ Login');
    expect(renderReport('json', r, meta)).toContain('"aegis-run-report"');
    expect(renderReport('junit', r, meta)).toContain('<testsuites');
    expect(renderReport('html', r, meta)).toContain('<!DOCTYPE html>');
    expect((['cli', 'json', 'junit', 'html'] as const).map((n) => reporterExtension(n))).toEqual(['txt', 'json', 'xml', 'html']);
    expect(isReporterName('html')).toBe(true);
    expect(isReporterName('xunit')).toBe(false);
  });
});
