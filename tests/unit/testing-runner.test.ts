import { describe, expect, it } from 'vitest';
import { formatRunReport, parseCsv, parseIterationData, parseJsonData, resolveIterationCount, runCollection, toJUnitXml, type ExecutionOutcome, type RunnableRequest } from '@aegis/testing';

const reqs = (...names: string[]): RunnableRequest[] => names.map((n, i) => ({ id: `id${i}`, name: n, method: 'GET', url: `http://x/${n}` }));
const pass = (name = 't'): ExecutionOutcome['tests'][number] => ({ name, passed: true, durationMs: 1 });
const fail = (name = 't'): ExecutionOutcome['tests'][number] => ({ name, passed: false, durationMs: 1, error: 'nope' });

describe('iteration data', () => {
  it('parses RFC 4180 CSV: quotes, escaped quotes, CRLF, embedded newlines, BOM', () => {
    const rows = parseCsv('﻿username,note\r\nuser1,"hello, ""world"""\r\nuser2,"line1\nline2"\r\n\r\n');
    expect(rows).toEqual([
      { username: 'user1', note: 'hello, "world"' },
      { username: 'user2', note: 'line1\nline2' },
    ]);
    expect(parseCsv('a,b\n1')).toEqual([{ a: '1', b: '' }]);
    expect(parseCsv('')).toEqual([]);
  });
  it('rejects malformed CSV and blocks prototype keys', () => {
    expect(() => parseCsv('a\n"unterminated')).toThrow(/unterminated/);
    expect(() => parseCsv('a,,c\n1,2,3')).toThrow(/empty column/);
    expect(Object.keys(parseCsv('__proto__,x\n1,2')[0]!)).toEqual(['x']);
  });
  it('parses JSON arrays/objects and stringifies values', () => {
    expect(parseJsonData('[{"a":1,"b":{"c":2},"d":null}]')).toEqual([{ a: '1', b: '{"c":2}', d: '' }]);
    expect(parseJsonData('{"a":"x"}')).toEqual([{ a: 'x' }]);
    expect(() => parseJsonData('[1]')).toThrow(/must be an object/);
    expect(() => parseJsonData('{')).toThrow(/valid JSON/);
    expect(parseIterationData('d.json', '[{"a":1}]')).toHaveLength(1);
    expect(parseIterationData('d.csv', 'a\n1\n2')).toHaveLength(2);
    expect(parseIterationData('data', '[{"a":1}]')).toHaveLength(1); // sniffed
  });
  it('iteration count: capped by data rows', () => {
    expect(resolveIterationCount(5, 0)).toBe(5);
    expect(resolveIterationCount(5, 2)).toBe(2);
    expect(resolveIterationCount(0, 0)).toBe(1);
  });
});

describe('runCollection', () => {
  const base = { delayMs: 0, stopOnFailure: false, data: [] as Array<Record<string, string>>, iterations: 1 };

  it('runs requests in order and summarises pass/fail', async () => {
    const order: string[] = [];
    const report = await runCollection({
      ...base,
      requests: reqs('Login', 'Get User', 'Update User', 'Logout'),
      async execute(r) {
        order.push(r.name);
        return { statusCode: r.name === 'Update User' ? 400 : 200, durationMs: 10, tests: [r.name === 'Update User' ? fail() : pass()] };
      },
    });
    expect(order).toEqual(['Login', 'Get User', 'Update User', 'Logout']);
    expect(report).toMatchObject({ status: 'completed', totalRequests: 4, passedTests: 3, failedTests: 1, failedRequests: 1 });
    const text = formatRunReport(report);
    expect(text).toContain('✓ Login');
    expect(text).toContain('✗ Update User');
  });

  it('stops on first failure when asked', async () => {
    const report = await runCollection({ ...base, stopOnFailure: true, requests: reqs('a', 'b', 'c'), execute: async (r) => ({ tests: [r.name === 'b' ? fail() : pass()] }) });
    expect(report.status).toBe('stopped');
    expect(report.items.map((i) => i.request.name)).toEqual(['a', 'b']);
  });

  it('iterates over data rows and passes each row', async () => {
    const seen: string[] = [];
    const report = await runCollection({
      ...base,
      iterations: 10,
      data: [{ u: 'a' }, { u: 'b' }, { u: 'c' }],
      requests: reqs('one'),
      async execute(_r, c) {
        seen.push(`${c.iteration}:${c.data.u}:${c.iterationCount}`);
        return { tests: [] };
      },
    });
    expect(seen).toEqual(['0:a:3', '1:b:3', '2:c:3']);
    expect(report.iterationCount).toBe(3);
  });

  it('supports setNextRequest jumps, null to end, and guards infinite loops', async () => {
    const calls: string[] = [];
    await runCollection({
      ...base,
      requests: reqs('a', 'b', 'c'),
      async execute(r) {
        calls.push(r.name);
        return { tests: [], ...(r.name === 'a' ? { nextRequest: 'c' } : {}) };
      },
    });
    expect(calls).toEqual(['a', 'c']);

    const ended: string[] = [];
    await runCollection({ ...base, iterations: 3, requests: reqs('a', 'b'), async execute(r) { ended.push(r.name); return { tests: [], ...(r.name === 'a' ? { nextRequest: null } : {}) }; } });
    expect(ended).toEqual(['a']);

    const loop = await runCollection({ ...base, requests: reqs('a'), maxStepsPerIteration: 5, async execute() { return { tests: [], nextRequest: 'a' }; } });
    expect(loop.status).toBe('failed');
  });

  it('honours delay, abort and executor exceptions', async () => {
    const sleeps: number[] = [];
    await runCollection({ ...base, delayMs: 250, requests: reqs('a', 'b', 'c'), sleep: async (ms) => void sleeps.push(ms), execute: async () => ({ tests: [] }) });
    expect(sleeps).toEqual([250, 250]);

    const ac = new AbortController();
    const aborted = await runCollection({ ...base, requests: reqs('a', 'b', 'c'), signal: ac.signal, execute: async (r) => { if (r.name === 'a') ac.abort(); return { tests: [] }; } });
    expect(aborted.status).toBe('stopped');
    expect(aborted.totalRequests).toBe(1);

    const thrown = await runCollection({ ...base, requests: reqs('a'), execute: async () => { throw new Error('boom'); } });
    expect(thrown.items[0]).toMatchObject({ passed: false, error: 'boom' });
  });

  it('produces JUnit XML with escaping', () => {
    const xml = toJUnitXml('Suite <1>', {
      status: 'completed', totalRequests: 1, passedTests: 0, failedTests: 1, failedRequests: 1, durationMs: 5, iterationCount: 1,
      items: [{ index: 0, iteration: 0, request: reqs('R&D')[0]!, statusCode: 200, durationMs: 5, method: 'GET', url: 'u', passed: false, tests: [fail('a "q"')] }],
    });
    expect(xml).toContain('Suite &lt;1&gt;');
    expect(xml).toContain('a &quot;q&quot;');
    expect(xml).toContain('<failure');
  });
});
