import { describe, expect, it } from 'vitest';
import type { RunnerItemEvent } from '@aegis/core';
import { csvCell, effectiveIterations, formatRunnerRow, groupByIteration, parseCsv, previewDataFile, resultsToCsv, resultsToJson, summarizeItems } from '../../apps/desktop/renderer/src/lib/runner-helpers';

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

describe('formatRunnerRow', () => {
  it('uses the live row style', () => {
    expect(formatRunnerRow(item())).toBe('✓ Login   200   182ms');
    expect(formatRunnerRow(item({ name: 'Update User', passed: false, statusCode: 400, durationMs: 121 }))).toBe('✗ Update User   400   121ms');
  });
  it('shows ERR and a dash when there is no response', () => {
    expect(formatRunnerRow(item({ passed: false, statusCode: null, durationMs: null }))).toBe('✗ Login   ERR   —');
  });
});

describe('grouping and summary', () => {
  const items = [
    item({ index: 2, iteration: 1, name: 'B', passed: false, tests: [{ name: 't', passed: false, durationMs: 1, error: 'x' }] }),
    item({ index: 0, iteration: 0, name: 'A', tests: [{ name: 't1', passed: true, durationMs: 1 }, { name: 't2', passed: true, skipped: true, durationMs: 0 }] }),
    item({ index: 1, iteration: 0, name: 'C', durationMs: 18 }),
  ];
  it('groups by iteration, ordered by index', () => {
    const g = groupByIteration(items);
    expect(g.map((x) => x.iteration)).toEqual([0, 1]);
    expect(g[0]!.items.map((i) => i.name)).toEqual(['A', 'C']);
    expect(g[1]!.failed).toBe(1);
  });
  it('summarizes requests, tests and duration (skipped tests ignored)', () => {
    expect(summarizeItems(items)).toEqual({ requests: 3, failedRequests: 1, testsPassed: 1, testsFailed: 1, durationMs: 182 + 182 + 18 });
  });
});

describe('export', () => {
  it('escapes csv cells and neutralizes formula injection', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
  it('builds csv and json documents', () => {
    const csv = resultsToCsv([item({ name: 'Evil,"name"' })]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('iteration,index,name,method,url,status,durationMs,passed,testsPassed,testsFailed,error');
    expect(lines[1]).toContain('"Evil,""name"""');
    const parsed = JSON.parse(resultsToJson([item()], { runId: 'r1', label: 'Col', status: 'completed' })) as { summary: { requests: number }; results: unknown[] };
    expect(parsed.summary.requests).toBe(1);
    expect(parsed.results).toHaveLength(1);
  });
});

describe('data file preview', () => {
  it('parses quoted csv', () => {
    expect(parseCsv('a,b\r\n1,"x,y"\n"he said ""hi""",3\n')).toEqual([
      ['a', 'b'],
      ['1', 'x,y'],
      ['he said "hi"', '3'],
    ]);
  });
  it('previews csv with row count', () => {
    const res = previewDataFile('data.csv', 'user,pw\nu1,p1\nu2,p2\nu3,p3', 2);
    expect(res).toMatchObject({ format: 'csv', headers: ['user', 'pw'], rowCount: 3 });
    expect('rows' in res && res.rows).toHaveLength(2);
  });
  it('previews json arrays and rejects bad input', () => {
    const res = previewDataFile('d.json', '[{"id":1,"n":"a"},{"id":2,"extra":true}]');
    expect(res).toMatchObject({ format: 'json', headers: ['id', 'n', 'extra'], rowCount: 2 });
    expect(previewDataFile('d.json', '{"a":1}')).toHaveProperty('error');
    expect(previewDataFile('d.json', '[')).toHaveProperty('error');
    expect(previewDataFile('d.csv', 'only,header')).toHaveProperty('error');
  });
  it('caps iterations by data rows', () => {
    expect(effectiveIterations(10, 3)).toBe(3);
    expect(effectiveIterations(2, 3)).toBe(2);
    expect(effectiveIterations(5, null)).toBe(5);
    expect(effectiveIterations(0, null)).toBe(1);
  });
});
