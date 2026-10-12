import { describe, expect, it } from 'vitest';
import type { ExecutionResult, ResponseView, RunnerItemEvent } from '@aegis/core';
import { entriesFromResult, entryFromRunnerItem, isSensitiveHeader, mergeConsoleRows, networkEntryText, parseScriptRequests, redactHeaderPairs, REDACTED_VALUE } from '../../apps/desktop/renderer/src/lib/network-log';
import { shortcutAction } from '../../apps/desktop/renderer/src/lib/shortcut-keys';

const response = (over: Partial<ResponseView> = {}): ResponseView => ({
  responseId: 'resp1',
  status: 200,
  statusText: 'OK',
  httpVersion: 'HTTP/1.1',
  headers: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Set-Cookie', value: 'session=abc123; HttpOnly' },
    { name: 'X-Api-Key', value: 'key-999' },
  ],
  cookies: [],
  contentType: 'application/json',
  size: 1234,
  requestSize: 100,
  url: 'https://api.test/final',
  redirects: [],
  timings: { waitingMs: 10, downloadMs: 5, totalMs: 15, startedAt: 1_000_000 },
  bodyPreview: '{}',
  previewBytes: 2,
  isBinary: false,
  notes: [],
  ...over,
});

const result = (over: Partial<ExecutionResult> = {}): ExecutionResult => ({
  executionId: 'e1',
  ok: true,
  response: response(),
  request: {
    method: 'POST',
    url: 'https://api.test/items?api_key=[REDACTED]',
    headers: [
      { name: 'Authorization', value: 'Bearer should-not-leak' },
      { name: 'Accept', value: 'application/json' },
      { name: 'Cookie', value: 'a=b' },
    ],
    bodyPreview: '{}',
  },
  tests: [],
  console: [],
  warnings: [],
  unresolvedVariables: [],
  variableChanges: {},
  ...over,
});

describe('network log redaction', () => {
  it('redacts credential headers case-insensitively and keeps the rest', () => {
    for (const h of ['Authorization', 'authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'X-API-Key', 'api-key', 'X-Auth-Token', 'X-Access-Token', 'X-Client-Secret', 'X-Password']) expect(isSensitiveHeader(h), h).toBe(true);
    for (const h of ['Accept', 'Content-Type', 'User-Agent', 'X-Request-Id']) expect(isSensitiveHeader(h), h).toBe(false);
    expect(redactHeaderPairs([{ name: 'Authorization', value: 'Bearer x' }, { name: 'Accept', value: 'json' }])).toEqual([
      { name: 'Authorization', value: REDACTED_VALUE },
      { name: 'Accept', value: 'json' },
    ]);
  });
  it('builds a redacted entry for a successful send', () => {
    const [entry, ...rest] = entriesFromResult(result(), { request: 'Create item', executionId: 'e1' });
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({ kind: 'network', source: 'request', request: 'Create item', method: 'POST', url: 'https://api.test/items?api_key=[REDACTED]', status: 200, statusText: 'OK', durationMs: 15, size: 1234, timestamp: 1_000_000 });
    const dump = JSON.stringify(entry);
    expect(dump).not.toContain('should-not-leak');
    expect(dump).not.toContain('abc123');
    expect(dump).not.toContain('key-999');
    expect(dump).not.toContain('a=b');
    expect(entry!.requestHeaders).toEqual([
      { name: 'Authorization', value: REDACTED_VALUE },
      { name: 'Accept', value: 'application/json' },
      { name: 'Cookie', value: REDACTED_VALUE },
    ]);
    expect(entry!.responseHeaders.find((h) => h.name === 'Set-Cookie')?.value).toBe(REDACTED_VALUE);
    expect(entry!.responseHeaders.find((h) => h.name === 'Content-Type')?.value).toBe('application/json');
  });
  it('logs failed sends (no response) with the error and fallback method/url', () => {
    const [entry] = entriesFromResult(result({ ok: false, response: undefined, request: undefined, error: { code: 'NETWORK_ERROR', message: 'ECONNREFUSED' } }), { request: 'X', executionId: 'e2', now: () => 42, fallbackMethod: 'GET', fallbackUrl: 'http://127.0.0.1:9/' });
    expect(entry).toMatchObject({ status: null, method: 'GET', url: 'http://127.0.0.1:9/', error: 'NETWORK_ERROR: ECONNREFUSED', timestamp: 42 });
    expect(networkEntryText(entry!)).toContain('ERROR');
  });
  it('adds pm.sendRequest calls parsed from the console, in chronological order', () => {
    const r = result({
      console: [
        { level: 'log', message: '-> GET https://auth.test/token', timestamp: 999_990, origin: 'collection pre-request' },
        { level: 'log', message: '<- 201 Created (12 ms)', timestamp: 999_995 },
        { level: 'log', message: 'unrelated', timestamp: 999_996 },
        { level: 'log', message: '-> POST https://x.test/never-answered', timestamp: 1_000_010 },
      ],
    });
    const entries = entriesFromResult(r, { request: 'Main', executionId: 'e3' });
    expect(entries.map((e) => [e.source, e.method, e.status, e.durationMs])).toEqual([
      ['script', 'GET', 201, 12],
      ['request', 'POST', 200, 15],
      ['script', 'POST', null, null],
    ]);
    expect(entries[0]).toMatchObject({ request: 'Main · pm.sendRequest', statusText: 'Created', note: 'collection pre-request' });
    expect(parseScriptRequests([{ level: 'log', message: '<- 200', timestamp: 1 }])).toEqual([]);
  });
  it('builds runner entries', () => {
    const ev: RunnerItemEvent = { runId: 'run', index: 2, iteration: 0, requestId: 'r', name: 'List', method: 'GET', url: 'https://api.test/list', statusCode: 500, durationMs: 80, passed: false, error: 'boom', tests: [{ name: 't', passed: false, durationMs: 1 }] };
    const e = entryFromRunnerItem(ev, { now: () => 7 });
    expect(e).toMatchObject({ source: 'runner', request: 'Runner #1.3 List', method: 'GET', status: 500, durationMs: 80, error: 'boom', note: '0/1 tests passed', timestamp: 7 });
  });
});

describe('console merge and filters', () => {
  const line = (id: string, timestamp: number, level: 'log' | 'error' = 'log') => ({ id, timestamp, level, message: `msg ${id}`, request: 'Req', executionId: 'e' });
  const net = entriesFromResult(result(), { request: 'Net', executionId: 'e1' });
  it('interleaves script lines and network entries by time', () => {
    const rows = mergeConsoleRows([line('a', 999_000), line('b', 1_000_500)], net, { kind: 'all', level: 'all', text: '' });
    expect(rows.map((r) => (r.kind === 'script' ? r.line.id : 'net'))).toEqual(['a', 'net', 'b']);
  });
  it('filters by kind, level and text', () => {
    expect(mergeConsoleRows([line('a', 1)], net, { kind: 'network', level: 'all', text: '' })).toHaveLength(1);
    expect(mergeConsoleRows([line('a', 1)], net, { kind: 'scripts', level: 'all', text: '' })).toHaveLength(1);
    expect(mergeConsoleRows([line('a', 1), line('b', 2, 'error')], net, { kind: 'all', level: 'error', text: '' }).map((r) => r.kind)).toEqual(['script']);
    expect(mergeConsoleRows([line('a', 1)], net, { kind: 'all', level: 'all', text: 'api.test' }).map((r) => r.kind)).toEqual(['network']);
    const failed = entriesFromResult(result({ response: response({ status: 503 }) }), { request: 'Net', executionId: 'e9' });
    expect(mergeConsoleRows([], failed, { kind: 'all', level: 'error', text: '' })).toHaveLength(1);
  });
});

describe('keyboard shortcuts', () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({ key, ctrlKey: true, metaKey: false, shiftKey: false, ...mods });
  it('maps keys to actions', () => {
    expect(shortcutAction(k('w'))).toBe('close-tab');
    expect(shortcutAction(k('Tab'))).toBe('next-tab');
    expect(shortcutAction(k('Tab', { shiftKey: true }))).toBe('prev-tab');
    expect(shortcutAction(k('F', { shiftKey: true }))).toBe('find-replace');
    expect(shortcutAction(k('f'))).toBeNull();
    expect(shortcutAction(k('t', { shiftKey: true }))).toBe('reopen-tab');
    expect(shortcutAction(k('s', { ctrlKey: false, metaKey: true }))).toBe('save');
    expect(shortcutAction(k('s', { ctrlKey: false }))).toBeNull();
  });
});
