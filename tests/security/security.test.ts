import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_CHANNELS, DEFAULT_SETTINGS, emptyRequestDraft, mergeSettings, newId, buildPreviewDocument, sanitizeHtmlForPreview } from '@aegis/core';
import {
  AuditLogger,
  Logger,
  MemoryLogSink,
  PolicyService,
  REDACTED,
  assertSafeFilePath,
  checkImportedFilePath,
  decryptWithPassphrase,
  encryptWithPassphrase,
  isSensitiveKey,
  parsePolicy,
  redactHeaders,
  redactObject,
  redactText,
  redactUrl,
  sanitizeFileName,
  isExecutableExtension,
} from '@aegis/security';
import { resolveHostOverrides } from '@aegis/app';
import { buildHttpRequestSpec, resolveUploadPath } from '@aegis/http-client';
import { IPC_SCHEMAS, assertSchemasComplete } from '../../apps/desktop/main/ipc-schemas';
import { createTestApp, type TestApp } from '../helpers/app';

describe('secret redaction', () => {
  it('masks sensitive headers, keys, urls and free text', () => {
    expect(redactHeaders([{ name: 'Authorization', value: 'Bearer abc' }, { name: 'Cookie', value: 'a=b' }, { name: 'Set-Cookie', value: 'x' }, { name: 'X-Api-Key', value: 'k' }, { name: 'Accept', value: 'json' }])).toEqual([
      { name: 'Authorization', value: REDACTED },
      { name: 'Cookie', value: REDACTED },
      { name: 'Set-Cookie', value: REDACTED },
      { name: 'X-Api-Key', value: REDACTED },
      { name: 'Accept', value: 'json' },
    ]);
    for (const k of ['password', 'client_secret', 'access_token', 'refresh_token', 'api_key', 'private_key', 'authorization', 'cookie', 'set-cookie', 'apiKey', 'x-api-key']) expect(isSensitiveKey(k)).toBe(true);
    for (const k of ['username', 'name', 'id', 'accept']) expect(isSensitiveKey(k)).toBe(false);
    expect(redactUrl('https://u:pw@h.test/p?access_token=abc&x=1&api_key=k#f')).toBe(`https://u:${REDACTED}@h.test/p?access_token=${REDACTED}&x=1&api_key=${REDACTED}#f`);
    const obj = redactObject({ a: { password: 'p', list: [{ token: 't', ok: 1 }] }, 'client_secret': 's' });
    expect(JSON.stringify(obj)).not.toMatch(/"p"|"t"|"s"/);
    expect(redactText('Authorization: Bearer abcdef123456 and password=hunter2 {"refresh_token":"zzz"}')).not.toMatch(/abcdef123456|hunter2|zzz/);
    expect(redactText('value super-secret-1 here', ['super-secret-1'])).toBe(`value ${REDACTED} here`);
    expect(redactText('custom ABC-123', [], ['ABC-\\d+'])).toBe(`custom ${REDACTED}`);
  });
  it('the logger redacts before any sink sees data', () => {
    const sink = new MemoryLogSink();
    const log = new Logger([sink], 'DEBUG');
    log.info('login with password=hunter2', { Authorization: 'Bearer zzz', nested: { client_secret: 'c' }, err: new Error('token=abc123 failed') });
    const dump = JSON.stringify(sink.records);
    for (const s of ['hunter2', 'zzz', '"c"', 'abc123']) expect(dump).not.toContain(s);
  });
  it('audit entries are redacted', () => {
    const entries: unknown[] = [];
    const audit = new AuditLogger({ append: (e) => void entries.push(e) }, () => true);
    audit.log('EXECUTE_REQUEST', { url: 'x', password: 'p4ss', headers: { Authorization: 'Bearer q' } });
    expect(JSON.stringify(entries)).not.toMatch(/p4ss|Bearer q/);
    new AuditLogger({ append: (e) => void entries.push(e) }, () => false).log('EXECUTE_REQUEST', {});
    expect(entries).toHaveLength(1); // disabled logger writes nothing
  });
});

describe('WP-B policy rows: insecure TLS per request, host overrides, working directory', () => {
  it('policy allowHostOverrides parses, defaults to true and disables overrides when false', () => {
    expect(parsePolicy({}).allowHostOverrides).toBe(true);
    expect(parsePolicy({ allowHostOverrides: false }).allowHostOverrides).toBe(false);
    expect(parsePolicy({ allowHostOverrides: 'false' }).allowHostOverrides).toBe(true); // wrong type ignored
    const entries = [{ host: 'api.test', address: '10.0.0.1' }];
    expect(resolveHostOverrides(entries, parsePolicy({})).hosts).toEqual({ 'api.test': '10.0.0.1' });
    const denied = resolveHostOverrides(entries, parsePolicy({ allowHostOverrides: false }));
    expect(denied.hosts).toEqual({});
    expect(denied.notes.join(' ')).toMatch(/disabled by organization policy/);
  });
  it('a per-request strict-SSL=off setting never reaches the engine unless policy allows insecure TLS', () => {
    // The executor derives the TLS options from policy; the engine itself must still default to verification.
    const spec = buildHttpRequestSpec(emptyRequestDraft({ url: 'https://h/', settings: { verifyTls: false } }), { id: 'x', limits: { timeoutMs: 1, followRedirects: true, maxRedirects: 1, maxResponseBytes: 1, maxRequestBytes: 1 }, tls: { rejectUnauthorized: true } });
    expect(spec.tls.rejectUnauthorized).toBe(true); // prepare never flips it; only the policy-aware executor may
  });
  it('relative upload paths are confined to the working directory', () => {
    const root = path.join(os.tmpdir(), 'aegis-workdir');
    expect(() => resolveUploadPath('data/x.bin')).toThrow(/working directory/);
    expect(resolveUploadPath('data/x.bin', { workingDirectory: root })).toBe(path.resolve(root, 'data', 'x.bin'));
    for (const bad of ['../x.bin', 'a/../../x.bin', '..\\x.bin', '\\\\srv\\share\\x', 'file:///x']) {
      expect(() => resolveUploadPath(bad, { workingDirectory: root }), bad).toThrow();
    }
  });
});

describe('file system safety', () => {
  it('rejects traversal, UNC, device and NUL paths for uploads', () => {
    for (const bad of ['\\\\server\\share\\x', '//server/share/x', '\\\\?\\C:\\x', 'C:\\a\0b', 'file:///etc/passwd', 'relative/path.txt', '']) {
      expect(() => assertSafeFilePath(bad), bad).toThrow();
    }
    const root = os.tmpdir();
    expect(() => assertSafeFilePath(path.join(root, '..', '..', 'etc', 'passwd'), { allowedRoots: [path.join(root, 'sandbox')] })).toThrow(/outside/);
    expect(assertSafeFilePath(path.join(root, 'sandbox', 'ok.txt'), { allowedRoots: [path.join(root, 'sandbox')] })).toContain('ok.txt');
    expect(assertSafeFilePath(path.resolve('some.txt'))).toBeTruthy();
  });
  it('validates references found in imported documents', () => {
    const unsafe = ['../../etc/passwd', 'a/../../b', 'C:\\Windows\\win.ini', '/etc/shadow', '\\\\srv\\s\\f', '~/x', '%APPDATA%\\x', '$HOME/x', 'file:///x', 'a\0b'];
    for (const p of unsafe) expect(checkImportedFilePath(p).safe, p).toBe(false);
    for (const p of ['files/ok.txt', 'data.csv', 'a b/c.json']) expect(checkImportedFilePath(p).safe, p).toBe(true);
  });
  it('sanitises file names and flags executables', () => {
    expect(sanitizeFileName('../../evil:name?.json')).not.toMatch(/[\\/:?]/);
    expect(sanitizeFileName('CON')).toBe('file');
    expect(isExecutableExtension('x.EXE')).toBe(true);
    expect(isExecutableExtension('x.json')).toBe(false);
  });
});

describe('HTML / XSS handling', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="https://evil.test"></iframe>',
    '<svg onload=alert(1)>',
    '<body onload="steal()">',
    '<object data="x"></object><embed src="x">',
    '<base href="https://evil.test/"><link rel="stylesheet" href="https://evil.test/x.css">',
  ];
  it('strips scripts, handlers, javascript: URLs, frames and base tags', () => {
    for (const p of payloads) {
      const out = sanitizeHtmlForPreview(`<p>hi</p>${p}`);
      expect(out, p).not.toMatch(/<script|onerror|onload|javascript:|<iframe|<object|<embed|<base|<link/i);
      expect(out).toContain('<p>hi</p>');
    }
  });
  it('wraps the preview with a restrictive CSP (no script, no connect)', () => {
    const doc = buildPreviewDocument('<b>x</b>');
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain('script-src');
  });
});

describe('crypto helpers', () => {
  it('passphrase encryption round-trips, authenticates and fails on a wrong passphrase', () => {
    const env = encryptWithPassphrase('top secret payload', 'correct horse');
    expect(JSON.stringify(env)).not.toContain('top secret');
    expect(decryptWithPassphrase(env, 'correct horse').toString()).toBe('top secret payload');
    expect(() => decryptWithPassphrase(env, 'wrong')).toThrow(/wrong passphrase/);
    expect(() => decryptWithPassphrase({ ...env, data: Buffer.from('tampered').toString('base64') }, 'correct horse')).toThrow();
  });
});

describe('enterprise policy', () => {
  it('forbids disabling TLS verification unless allowed, and clamps effective settings', () => {
    const strict = new PolicyService(parsePolicy({}));
    expect(() => strict.assertCanDisableTlsVerification()).toThrow(/does not allow/);
    const s = strict.effectiveSettings({ ...DEFAULT_SETTINGS, network: { ...DEFAULT_SETTINGS.network, verifyTls: false } });
    expect(s.network.verifyTls).toBe(true); // never silently disabled
    const lenient = new PolicyService(parsePolicy({ allowInsecureTls: true }));
    expect(lenient.effectiveSettings({ ...DEFAULT_SETTINGS, network: { ...DEFAULT_SETTINGS.network, verifyTls: false } }).network.verifyTls).toBe(false);
    expect(strict.effectiveSettings({ ...DEFAULT_SETTINGS, scripting: { ...DEFAULT_SETTINGS.scripting, timeoutMs: 10 ** 9 } }).scripting.timeoutMs).toBe(60_000);
  });
  it('ignores malformed policy fields, blocks hosts, gates production', () => {
    const p = parsePolicy({ allowInsecureTls: 'yes', blockedHosts: ['*.evil.test', 'x.test'], maxScriptTimeoutMs: 'many', junk: 1 });
    expect(p.allowInsecureTls).toBe(false);
    const svc = new PolicyService(p);
    expect(() => svc.assertHostAllowed('a.evil.test')).toThrow(/blocks/);
    expect(() => svc.assertHostAllowed('x.test')).toThrow();
    expect(() => svc.assertHostAllowed('fine.test')).not.toThrow();
    expect(svc.productionGate(false)).toBe('allow');
    expect(svc.productionGate(true)).toBe('confirm');
    expect(new PolicyService(parsePolicy({ blockProductionRequests: true })).productionGate(true)).toBe('block');
    expect(new PolicyService(parsePolicy({ requireProductionConfirmation: false })).productionGate(true)).toBe('allow');
  });
  it('settings merge ignores unknown keys, wrong types and prototype pollution', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, JSON.parse('{"__proto__":{"polluted":true},"appearance":{"theme":"light","evil":1},"network":{"timeoutMs":"fast"},"constructor":{"x":1}}'));
    expect(merged.appearance.theme).toBe('light');
    expect(merged.network.timeoutMs).toBe(DEFAULT_SETTINGS.network.timeoutMs);
    expect((merged as unknown as Record<string, unknown>).evil).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('IPC argument validation', () => {
  it('has a strict schema for every channel (and no extras)', () => {
    expect(() => assertSchemasComplete()).not.toThrow();
    expect(Object.keys(IPC_SCHEMAS).sort()).toEqual([...API_CHANNELS].sort());
  });
  it('rejects wrong types, missing fields, oversized strings and injected enum values', () => {
    const bad: Array<[string, unknown]> = [
      ['requests.get', {}],
      ['requests.get', { id: 5 }],
      ['requests.get', { id: '' }],
      ['requests.get', { id: 'x'.repeat(500) }],
      ['requests.move', { kind: 'table', id: 'a', parentFolderId: null, index: 0 }],
      ['requests.move', { kind: 'folder', id: 'a', parentFolderId: null, index: -1 }],
      ['history.search', { workspaceId: 'w', sortBy: 'created_at; DROP TABLE history' }],
      ['history.search', { workspaceId: 'w', limit: 10 ** 9 }],
      ['importExport.commit', { token: 't' }],
      ['importExport.pickAndPreview', { kind: 'exe' }],
      ['execution.send', { executionId: 'e', workspaceId: 'w', draft: { name: 1 } }],
      ['responses.readChunk', { responseId: 'r', offset: 0, length: 10 ** 10 }],
      ['settings.update', { patch: 'not an object' }],
      ['variables.set', { scope: 'secrets', ownerId: 'x', entries: [] }],
      ['certificates.add', { kind: 'root', name: 'x' }],
    ];
    for (const [channel, args] of bad) {
      expect(IPC_SCHEMAS[channel as keyof typeof IPC_SCHEMAS].safeParse(args).success, `${channel} ${JSON.stringify(args)}`).toBe(false);
    }
  });
  it('strips unknown keys so smuggled fields never reach handlers', () => {
    const parsed = IPC_SCHEMAS['requests.get'].parse({ id: 'abc', isAdmin: true, __proto__: { x: 1 } }) as Record<string, unknown>;
    expect(parsed).toEqual({ id: 'abc' });
  });
  it('accepts well-formed calls', () => {
    expect(IPC_SCHEMAS['requests.create'].safeParse({ collectionId: 'c', folderId: null, draft: emptyRequestDraft() }).success).toBe(true);
    expect(IPC_SCHEMAS['app.info'].safeParse(undefined).success).toBe(true);
    expect(IPC_SCHEMAS['execution.send'].safeParse({ executionId: newId(), workspaceId: 'w', requestId: 'r' }).success).toBe(true);
  });
});

describe('SQL injection resistance & policy enforcement at the service layer', () => {
  let t: TestApp;
  let wsId = '';
  beforeAll(async () => {
    t = createTestApp();
    wsId = (await t.api.workspaces.list())[0]!.id;
  });
  afterAll(async () => t.close());

  const evil = ["'; DROP TABLE requests; --", '" OR 1=1 --', "Robert'); DROP TABLE collections;--", '%', '_', '\\'];

  it('names, searches and history filters containing SQL are treated as data', async () => {
    for (const s of evil) {
      const c = await t.api.collections.create({ workspaceId: wsId, name: s });
      await t.api.requests.create({ collectionId: c.id, folderId: null, draft: emptyRequestDraft({ name: s, url: `http://x.test/${encodeURIComponent(s)}` }) });
      await t.api.collections.search({ workspaceId: wsId, query: s });
      await t.api.history.search({ workspaceId: wsId, text: s, method: s, status: s });
      await t.api.workspaces.search({ query: s });
    }
    const cols = await t.api.collections.list({ workspaceId: wsId });
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(evil));
    const tables = (t.app.ctx.storage.opened.client.native.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['requests', 'collections', 'history']));
    // wildcard characters are escaped: '%' only matches names that contain a literal percent sign
    const hits = await t.api.collections.search({ workspaceId: wsId, query: '%' });
    expect(hits.every((h) => h.name.includes('%') || h.subtitle.includes('%'))).toBe(true);
  });

  it('refuses to disable TLS verification when policy forbids it, and audits setting changes', async () => {
    await expect(t.api.settings.update({ patch: { network: { verifyTls: false } } })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect((await t.api.settings.get()).network.verifyTls).toBe(true);
    await t.api.settings.update({ patch: { history: { enabled: false } } });
    expect((await t.api.audit.list({ action: 'CHANGE_SECURITY_SETTING' })).some((a) => JSON.stringify(a.details).includes('history.enabled'))).toBe(true);
    await t.api.settings.update({ patch: { history: { enabled: true } } });
  });

  it('production environment requires confirmation (or is blocked) according to policy', async () => {
    const env = await t.api.environments.create({ workspaceId: wsId, name: 'Production', isProduction: true });
    await t.api.environments.setActive({ workspaceId: wsId, id: env.id });
    const draft = emptyRequestDraft({ url: 'http://127.0.0.1:9/never' });
    await expect(t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    // with confirmation the request is attempted (and fails on the network, which is fine)
    const confirmed = await t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft, confirmProduction: true });
    expect(confirmed.error?.code).toBe('NETWORK_ERROR');

    const blocked = createTestApp({ policy: { blockProductionRequests: true } });
    const w = (await blocked.api.workspaces.list())[0]!.id;
    const e = await blocked.api.environments.create({ workspaceId: w, name: 'Prod', isProduction: true });
    await blocked.api.environments.setActive({ workspaceId: w, id: e.id });
    await expect(blocked.api.execution.send({ executionId: newId(), workspaceId: w, draft, confirmProduction: true })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await blocked.close();
    await t.api.environments.setActive({ workspaceId: wsId, id: null });
  });

  it('secret export is refused by policy and reveal of arbitrary vault keys is refused', async () => {
    const locked = createTestApp({ policy: { allowSecretExport: false } });
    const w = (await locked.api.workspaces.list())[0]!.id;
    const c = await locked.api.collections.create({ workspaceId: w, name: 'C' });
    await expect(locked.api.importExport.exportCollection({ collectionId: c.id, includeSecrets: true })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await expect(locked.api.variables.revealSecret({ ref: 'secretref:cookie:abc' })).rejects.toMatchObject({ code: 'IPC_INVALID_ARGUMENT' });
    await expect(locked.api.variables.revealSecret({ ref: 'plain text' })).rejects.toMatchObject({ code: 'IPC_INVALID_ARGUMENT' });
    await locked.close();
  });

  it('oversized or hostile imports are rejected without creating data', async () => {
    const before = (await t.api.collections.list({ workspaceId: wsId })).length;
    await expect(t.api.importExport.previewContent({ kind: 'postman-collection', fileName: 'x.json', content: '{not json' })).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    await expect(t.api.importExport.previewContent({ kind: 'postman-collection', fileName: 'x.json', content: '{"info":{"name":"x"}}' })).rejects.toMatchObject({ code: 'IMPORT_INVALID' });
    await expect(t.api.importExport.previewContent({ kind: 'postman-environment', fileName: 'x.json', content: '[]' })).rejects.toBeTruthy();
    await expect(t.api.importExport.commit({ token: 'does-not-exist', workspaceId: wsId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await t.api.collections.list({ workspaceId: wsId })).length).toBe(before);
    // a failed import is recorded with its warnings for diagnostics
    expect(t.app.ctx.storage.repos.imports.listJobs().some((j) => j.status === 'failed')).toBe(true);
  });
});

describe('WP-E: Markdown description preview (XSS corpus) and network log redaction', () => {
  const markdownPayloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '![x](https://evil.test/track.png)',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="https://evil.test"></iframe>',
    '<svg onload=alert(1)>',
    '<base href="https://evil.test/"><link rel="stylesheet" href="https://evil.test/x.css">',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '| <script>x</script> |\n|---|\n| <img src=x onerror=1> |',
  ];
  it('renders every payload as inert text inside a CSP-protected sandbox document', async () => {
    const { renderMarkdown, buildMarkdownDocument } = await import('../../apps/desktop/renderer/src/lib/markdown');
    for (const p of markdownPayloads) {
      const html = renderMarkdown(p);
      expect(html, p).not.toMatch(/<script|<iframe|<object|<embed|<base|<link|<svg|<img src="(?!data:image\/)/i);
      expect(html, p).not.toMatch(/\son[a-z]+\s*=\s*"/i);
      expect(html, p).not.toMatch(/(href|src)="[^"]*(javascript:|evil\.test|data:text)/i);
      const doc = buildMarkdownDocument(p);
      expect(doc).toContain("default-src 'none'");
      expect(doc).not.toMatch(/<script|onerror=|<iframe/i);
    }
  });
  it('the console network log never carries credential header values', async () => {
    const { entriesFromResult, REDACTED_VALUE } = await import('../../apps/desktop/renderer/src/lib/network-log');
    const result = {
      executionId: 'e',
      ok: true,
      request: { method: 'GET', url: 'https://h.test/', headers: [{ name: 'Authorization', value: 'Bearer leak-1' }, { name: 'X-Api-Key', value: 'leak-2' }], bodyPreview: '' },
      response: { responseId: 'r', status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [{ name: 'Set-Cookie', value: 'sid=leak-3' }], cookies: [], contentType: '', size: 0, requestSize: 0, url: 'https://h.test/', redirects: [], timings: { waitingMs: 1, downloadMs: 1, totalMs: 2, startedAt: 1 }, bodyPreview: '', previewBytes: 0, isBinary: false, notes: [] },
      tests: [],
      console: [],
      warnings: [],
      unresolvedVariables: [],
      variableChanges: {},
    };
    const dump = JSON.stringify(entriesFromResult(result, { request: 'R', executionId: 'e' }));
    expect(dump).not.toMatch(/leak-[123]/);
    expect(dump).toContain(REDACTED_VALUE);
  });
});

// keep rmSync/mkdtempSync imports meaningful for future fixtures
void rmSync;
void mkdtempSync;
