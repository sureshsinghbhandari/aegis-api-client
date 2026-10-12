import { describe, expect, it } from 'vitest';
import type { RunnerItemEvent, TreeNode } from '@aegis/core';
import { escapeHtml, escapeXml, moveId, requestIdsForRun, resultsToHtml, resultsToJUnit, runnableRequestsInScope } from '../../apps/desktop/renderer/src/lib/runner-helpers';

const item = (over: Partial<RunnerItemEvent> = {}): RunnerItemEvent => ({
  runId: 'r1',
  index: 0,
  iteration: 0,
  requestId: 'q',
  name: 'Login',
  method: 'POST',
  url: 'https://api.example.com/login',
  statusCode: 200,
  durationMs: 182,
  passed: true,
  tests: [],
  ...over,
});

const EVIL = '<script>alert("x")</script>&\'"`';

describe('escaping', () => {
  it('escapes every XML/HTML special character', () => {
    expect(escapeXml(EVIL)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&apos;&quot;`');
    expect(escapeHtml(EVIL)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;&quot;&#96;');
  });
});

describe('JUnit export', () => {
  const items = [
    item({ index: 0, name: EVIL, url: 'http://x/?a=<b>', tests: [{ name: 'ok', passed: true, durationMs: 10 }, { name: 'bad "quote"', passed: false, durationMs: 5, error: 'expected 1 <to> equal 2' }, { name: 'skip', passed: true, skipped: true, durationMs: 0 }] }),
    item({ index: 1, name: 'No tests', passed: false, statusCode: null, error: 'ECONNREFUSED & more' }),
    item({ index: 2, iteration: 1, name: 'Second', tests: [{ name: 't', passed: true, durationMs: 1 }] }),
  ];
  const xml = resultsToJUnit(items, 'Suite <1>');

  it('produces one suite per iteration with counts and escaped content', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<testsuites name="Suite &lt;1&gt;" tests="5">');
    expect(xml).toContain('<testsuite name="Suite &lt;1&gt; (iteration 1)" tests="4" failures="2" skipped="1"');
    expect(xml).toContain('<testsuite name="Suite &lt;1&gt; (iteration 2)" tests="1" failures="0" skipped="0"');
    expect(xml).toContain('name="bad &quot;quote&quot;"');
    expect(xml).toContain('<failure message="expected 1 &lt;to&gt; equal 2"/>');
    expect(xml).toContain('<failure message="ECONNREFUSED &amp; more"/>');
    expect(xml).toContain('<skipped/>');
    expect(xml).not.toContain('<script>');
    expect(xml).not.toContain('alert("x")');
  });

  it('strips control characters that XML 1.0 forbids', () => {
    expect(resultsToJUnit([item({ name: 'a\u0000b\u0007c' })], 's')).toContain('name="POST https://api.example.com/login"');
    expect(resultsToJUnit([item({ tests: [{ name: 'x\u0001y', passed: true, durationMs: 1 }] })], 's')).toContain('name="xy"');
  });
});

describe('HTML export', () => {
  it('escapes everything that comes from the run, including stored responses, and ships no script', () => {
    const items = [
      item({
        name: EVIL,
        url: `http://x/?q=${EVIL}`,
        error: EVIL,
        tests: [{ name: EVIL, passed: false, durationMs: 1, error: EVIL }],
        response: { status: 200, statusText: EVIL, contentType: EVIL, headers: [{ name: EVIL, value: EVIL }], body: EVIL, bodyTruncated: true, size: 10 },
      }),
    ];
    const html = resultsToHtml(items, { label: EVIL, status: 'completed', startedAt: 0 });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert("x")');
    expect(html.match(/&lt;script&gt;/g)!.length).toBeGreaterThanOrEqual(9);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('(truncated)');
    expect(html).toContain('Iteration'.length ? 'Tests failed: 1' : '');
  });

  it('groups iterations and summarises', () => {
    const html = resultsToHtml([item({ iteration: 0 }), item({ index: 1, iteration: 1, passed: false, statusCode: 500 })], { label: 'Run' });
    expect(html).toContain('Iteration 1');
    expect(html).toContain('Iteration 2 · 1 failed');
    expect(html).toContain('Failed requests: 1');
  });
});

describe('request selection helpers', () => {
  const tree: TreeNode[] = [
    { id: 'f1', kind: 'folder', collectionId: 'c', parentId: null, name: 'Folder', sortOrder: 1 },
    { id: 'r1', kind: 'request', collectionId: 'c', parentId: null, name: 'Root first', method: 'GET', sortOrder: 0 },
    { id: 'r3', kind: 'request', collectionId: 'c', parentId: 'f1', name: 'In folder', method: 'POST', sortOrder: 0 },
    { id: 'r2', kind: 'request', collectionId: 'c', parentId: null, name: 'Root last', method: 'DELETE', sortOrder: 2 },
    { id: 'f2', kind: 'folder', collectionId: 'c', parentId: 'f1', name: 'Nested', sortOrder: 1 },
    { id: 'r4', kind: 'request', collectionId: 'c', parentId: 'f2', name: 'Deep', method: 'PUT', sortOrder: 0 },
  ];

  it('lists requests depth-first in tree order with folder paths', () => {
    expect(runnableRequestsInScope(tree, null).map((r) => `${r.id}:${r.path}`)).toEqual(['r1:', 'r3:Folder', 'r4:Folder / Nested', 'r2:']);
    expect(runnableRequestsInScope(tree, 'f1').map((r) => r.id)).toEqual(['r3', 'r4']);
    expect(runnableRequestsInScope(tree, 'f2')[0]).toMatchObject({ id: 'r4', method: 'PUT', path: '' });
  });

  it('moves ids within bounds', () => {
    expect(moveId(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], 'zzz', 1)).toEqual(['a', 'b', 'c']);
  });

  it('sends requestIds only when the selection differs from the default', () => {
    const def = ['a', 'b', 'c'];
    expect(requestIdsForRun(def, new Set(def), def)).toBeUndefined();
    expect(requestIdsForRun(['b', 'a', 'c'], new Set(def), def)).toEqual(['b', 'a', 'c']);
    expect(requestIdsForRun(def, new Set(['a', 'c']), def)).toEqual(['a', 'c']);
    expect(requestIdsForRun(def, new Set(), def)).toEqual([]);
  });
});
