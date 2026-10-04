import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { emptyRequestDraft, type HttpResponse } from '@aegis/core';
import { applyAuthToSpec, assertValidHeader, buildHttpRequestSpec } from '@aegis/http-client';
import { CookieJarService, ResponseStore, applySnapshot, collectDraftStrings, draftToSnapshot, historySnapshot, mergeChanges, parseChromiumProxy, parseSetCookie } from '@aegis/app';
import { createTestStorage } from '../helpers/storage';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'aegis-support-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const limits = { timeoutMs: 1000, followRedirects: true, maxRedirects: 5, maxResponseBytes: 1e6, maxRequestBytes: 1e6 };
const opts = { id: 'x', limits, tls: { rejectUnauthorized: true } };

describe('request preparation', () => {
  it('rejects CRLF header injection and invalid header names', () => {
    expect(() => assertValidHeader('X-Test', 'a\r\nInjected: 1')).toThrow(/control characters/);
    expect(() => assertValidHeader('Bad Name', 'x')).toThrow(/Invalid header name/);
    expect(() => buildHttpRequestSpec(emptyRequestDraft({ url: 'http://h/', headers: [{ key: 'X', value: 'a\nb', enabled: true }] }), opts)).toThrow();
    expect(() => assertValidHeader('X-Ok', 'fine value')).not.toThrow();
  });
  it('builds defaults, content types, skips disabled rows, never mutates the draft', () => {
    const draft = emptyRequestDraft({
      method: 'post',
      url: 'http://h/a/:id',
      pathVariables: [{ key: 'id', value: '7', enabled: true }],
      headers: [{ key: 'X-On', value: '1', enabled: true }, { key: 'X-Off', value: '1', enabled: false }],
      body: { mode: 'raw', rawLanguage: 'json', raw: '{}' },
    });
    const before = JSON.stringify(draft);
    const spec = buildHttpRequestSpec(draft, opts);
    expect(spec.method).toBe('POST');
    expect(spec.url).toBe('http://h/a/7');
    const names = spec.headers.map((h) => h.name.toLowerCase());
    expect(names).toEqual(expect.arrayContaining(['x-on', 'content-type', 'user-agent', 'accept', 'accept-encoding']));
    expect(names).not.toContain('x-off');
    expect(spec.headers.find((h) => h.name === 'Content-Type')!.value).toBe('application/json');
    expect(JSON.stringify(draft)).toBe(before);
  });
  it('user headers win; invalid URL and missing files are validation errors', () => {
    const spec = buildHttpRequestSpec(emptyRequestDraft({ url: 'http://h/', headers: [{ key: 'accept', value: 'text/csv', enabled: true }], body: { mode: 'raw', raw: 'x', rawLanguage: 'json', contentType: 'application/vnd.api+json' } }), opts);
    expect(spec.headers.filter((h) => h.name.toLowerCase() === 'accept')).toEqual([{ name: 'accept', value: 'text/csv' }]);
    expect(spec.headers.find((h) => h.name === 'Content-Type')!.value).toBe('application/vnd.api+json');
    expect(() => buildHttpRequestSpec(emptyRequestDraft({ url: 'http://exa mple.com/' }), opts)).toThrow(/not valid/);
    expect(() => buildHttpRequestSpec(emptyRequestDraft({ url: 'http://h/', body: { mode: 'binary' } }), opts)).toThrow(/No file selected/);
    expect(() => buildHttpRequestSpec(emptyRequestDraft({ url: 'http://h/', body: { mode: 'formdata', formData: [{ key: 'f', type: 'file', value: '', enabled: true }] } }), opts)).toThrow(/No file selected/);
  });
  it('auth results replace same-named headers and append query params', () => {
    const spec = buildHttpRequestSpec(emptyRequestDraft({ url: 'http://h/p?a=1', headers: [{ key: 'Authorization', value: 'old', enabled: true }] }), opts);
    const out = applyAuthToSpec(spec, { headers: [{ name: 'authorization', value: 'Bearer new' }], query: [{ name: 'k', value: 'v w' }] });
    expect(out.headers.filter((h) => h.name.toLowerCase() === 'authorization')).toEqual([{ name: 'authorization', value: 'Bearer new' }]);
    expect(out.url).toBe('http://h/p?a=1&k=v+w');
  });
});

describe('executor helpers', () => {
  it('pre-request request mutations are applied back onto the draft', () => {
    const draft = emptyRequestDraft({ url: 'http://h/x', queryParams: [{ key: 'a', value: '1', enabled: true }, { key: 'off', value: 'z', enabled: false }], headers: [{ key: 'A', value: '1', enabled: true }] });
    const before = draftToSnapshot(draft);
    expect(before.url).toBe('http://h/x?a=1');
    const after = { ...before, method: 'PUT', url: 'http://h/y?b=2', headers: [...before.headers, { key: 'B', value: '2', enabled: true }], body: { mode: 'raw' as const, raw: 'hi' } };
    const next = applySnapshot(draft, before, after);
    expect(next.method).toBe('PUT');
    expect(next.url).toBe('http://h/y');
    expect(next.queryParams.map((q) => [q.key, q.enabled])).toEqual([['b', true], ['off', false]]);
    expect(next.headers).toHaveLength(2);
    expect(next.body).toMatchObject({ mode: 'raw', raw: 'hi' });
    expect(applySnapshot(draft, before, before)).toBe(draft); // no change => same object
  });
  it('merges script variable changes in order', () => {
    const a = { set: { x: '1', y: '2' }, unset: ['gone'], cleared: false };
    expect(mergeChanges(a, { set: { y: '3' }, unset: ['x'], cleared: false })).toEqual({ set: { y: '3' }, unset: ['gone', 'x'], cleared: false });
    expect(mergeChanges(a, { set: { z: '9' }, unset: [], cleared: true })).toEqual({ set: { z: '9' }, unset: [], cleared: true });
  });
  it('history snapshots mask sensitive literals but keep {{variable}} references (so replay works) and omit bodies by default', () => {
    const draft = emptyRequestDraft({
      url: 'http://h/',
      headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }, { key: 'X-Api-Key', value: 'literal-key-123', enabled: true }],
      queryParams: [{ key: 'api_key', value: 'qk-999', enabled: true }],
      body: { mode: 'raw', raw: '{"password":"hunter2"}' },
      auth: { type: 'basic', params: { username: 'u', password: 'p-literal' } },
    });
    const snap = JSON.stringify(historySnapshot(draft, false));
    expect(snap).toContain('Bearer {{token}}');
    for (const s of ['literal-key-123', 'qk-999', 'hunter2', 'p-literal']) expect(snap).not.toContain(s);
    expect(snap).toContain('"omitted":true');
    expect(JSON.stringify(historySnapshot(draft, true))).not.toContain('hunter2'); // key-based redaction still applies to stored bodies
  });
  it('finds unresolved-variable candidates and parses proxy/cookie strings', () => {
    expect(collectDraftStrings(emptyRequestDraft({ url: '{{a}}/x', headers: [{ key: 'k', value: 'plain', enabled: true }, { key: 'k2', value: '{{b}}', enabled: false }] }))).toEqual(['{{a}}/x']);
    expect(parseChromiumProxy('PROXY proxy.corp:3128; DIRECT')).toBe('http://proxy.corp:3128');
    expect(parseChromiumProxy('DIRECT')).toBeUndefined();
    expect(parseChromiumProxy('SOCKS5 h:1080')).toBeUndefined();
    expect(parseSetCookie('sid=abc; Path=/; Domain=x.test; Secure; HttpOnly; SameSite=Lax')).toMatchObject({ name: 'sid', value: 'abc', secure: true, httpOnly: true, sameSite: 'Lax', domain: 'x.test' });
  });
});

describe('response store', () => {
  const res = (body: Buffer, extra: Partial<HttpResponse> = {}): HttpResponse => ({
    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], body, size: body.length, truncated: false, url: 'u', redirects: [],
    timings: { startedAt: 0, waitingMs: 0, downloadMs: 0, totalMs: 0 }, requestSize: 0, setCookies: [], notes: [], ...extra,
  });
  it('serves chunks without splitting multi-byte characters, from memory and from a spilled file', async () => {
    const store = new ResponseStore();
    const text = 'héllo wörld €€€ '.repeat(50);
    const entry = store.put(res(Buffer.from(text)));
    let offset = 0;
    let out = '';
    for (;;) {
      const c = await store.readChunk(entry.id, offset, 37);
      if (c.bytesRead === 0) break;
      out += c.text;
      offset += c.bytesRead;
    }
    expect(out).toBe(text);

    const file = path.join(tmp, 'spill.body');
    writeFileSync(file, Buffer.from(text));
    const spilled = store.put(res(Buffer.from('preview'), { bodyFilePath: file, size: Buffer.byteLength(text), truncated: true }));
    expect((await store.readChunk(spilled.id, 0, 10)).total).toBe(Buffer.byteLength(text));
    expect((await store.head(spilled.id, 5)).toString()).toBe(Buffer.from(text).subarray(0, 5).toString());
    await store.release(spilled.id);
    await expect(store.readChunk(spilled.id, 0, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('cookie jar service (persistence + script visibility)', () => {
  it('stores cookies per workspace, sends them back, persists values encrypted, hides httpOnly from scripts', async () => {
    const storage = createTestStorage();
    const ws = storage.repos.workspaces.create('W');
    const jar = new CookieJarService(storage.repos.cookies);
    const hook = jar.hookFor(ws.id);
    await hook.storeSetCookies('http://api.test/login', ['sid=SESSION-VALUE-1; Path=/; HttpOnly', 'theme=dark; Path=/', 'old=1; Max-Age=0']);
    expect(await hook.getCookieHeader('http://api.test/x')).toBe('sid=SESSION-VALUE-1; theme=dark');
    expect(await hook.getCookieHeader('http://other.test/')).toBeUndefined();
    expect((await jar.cookiesForScripts(ws.id, 'http://api.test/x')).map((c) => c.name)).toEqual(['theme']);

    // persisted, but the value never sits in an ordinary column
    const rows = storage.repos.cookies.list(ws.id);
    expect(rows.map((r) => r.name).sort()).toEqual(['sid', 'theme']);
    expect(rows.every((r) => r.value === '')).toBe(true);
    expect(JSON.stringify(storage.opened.client.native.prepare('select * from cookies').all())).not.toContain('SESSION-VALUE-1');
    // a new service instance (app restart) loads the same cookies
    const jar2 = new CookieJarService(storage.repos.cookies);
    expect(await jar2.hookFor(ws.id).getCookieHeader('http://api.test/')).toBe('sid=SESSION-VALUE-1; theme=dark');
    // another workspace is isolated
    const ws2 = storage.repos.workspaces.create('W2');
    expect(await jar2.hookFor(ws2.id).getCookieHeader('http://api.test/')).toBeUndefined();
    storage.repos.cookies.clear(ws.id);
    jar2.invalidate(ws.id);
    expect(await jar2.hookFor(ws.id).getCookieHeader('http://api.test/')).toBeUndefined();
    storage.close();
  });
});

describe('certificate repository', () => {
  it('keeps keys in secret storage and matches host patterns most-specific first', () => {
    const storage = createTestStorage();
    const certs = storage.repos.certificates;
    const pem = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----';
    certs.add({ kind: 'client', name: 'wild', hostPattern: '*.corp.test', certPem: pem, keyPem: 'KEY-WILD' });
    certs.add({ kind: 'client', name: 'exact', hostPattern: 'api.corp.test', certPem: pem, keyPem: 'KEY-EXACT', passphrase: 'pw' });
    certs.add({ kind: 'ca', name: 'corp ca', certPem: pem });
    expect(certs.clientCertificateFor('api.corp.test')).toMatchObject({ key: 'KEY-EXACT', passphrase: 'pw' });
    expect(certs.clientCertificateFor('other.corp.test')).toMatchObject({ key: 'KEY-WILD' });
    expect(certs.clientCertificateFor('elsewhere.test')).toBeUndefined();
    expect(certs.trustedCAs()).toEqual([pem]);
    expect(JSON.stringify(storage.opened.client.native.prepare('select * from certificates').all())).not.toContain('KEY-EXACT');
    const exact = certs.list().find((c) => c.name === 'exact')!;
    certs.setEnabled(exact.id, false);
    expect(certs.clientCertificateFor('api.corp.test')).toMatchObject({ key: 'KEY-WILD' });
    certs.delete(exact.id);
    expect(storage.secrets.getSync(`cert:${exact.id}:key`)).toBeNull();
    storage.close();
  });
});
