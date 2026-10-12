/**
 * WP-B: HTTP runtime, request settings, hosts override, working directory, PFX certificates,
 * Postman protocolProfileBehavior mapping and the related executor fixes (#2, #3, #5, #8, #15).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, DEFAULT_SETTINGS, emptyRequestDraft, mergeSettings, newId, type HttpResponse } from '@aegis/core';
import { buildHttpRequestSpec, buildRawRequestUrl, resolveUploadPath } from '@aegis/http-client';
import { buildResponseView, resolveHostOverrides } from '@aegis/app';
import { exportPostmanCollection, parsePostmanCollection } from '@aegis/postman';
import { parsePolicy } from '@aegis/security';
import { isIpLiteral, isValidHostName, normalizeHostOverrides, parseHostsText, validateHostOverride } from '../../apps/desktop/renderer/src/modals/settings/hostsOverride';
import { validateWorkingDirectory } from '../../apps/desktop/renderer/src/modals/settings/WorkingDirectorySection';
import { startHttpsServer, startServer, type TestServer } from '../helpers/http-server';
import { createTestApp, type TestApp } from '../helpers/app';

const limits = { timeoutMs: 1000, followRedirects: true, maxRedirects: 5, maxResponseBytes: 1e6, maxRequestBytes: 1e6 };
const opts = { id: 'x', limits, tls: { rejectUnauthorized: true } };

describe('request preparation: settings parity', () => {
  it('maps every request setting onto the wire spec (defaults omitted)', () => {
    const plain = buildHttpRequestSpec(emptyRequestDraft({ url: 'http://h/' }), opts);
    expect(plain.httpVersion).toBe('auto');
    expect(plain.encodeUrl).toBe(true);
    expect(plain.disableCookies).toBeUndefined();
    expect(plain.followOriginalHttpMethod).toBeUndefined();
    expect(plain.followAuthorizationHeader).toBeUndefined();
    expect(plain.removeRefererHeaderOnRedirect).toBeUndefined();
    expect(plain.hosts).toBeUndefined();
    expect(plain.workingDirectory).toBeUndefined();

    const spec = buildHttpRequestSpec(
      emptyRequestDraft({
        url: 'http://h/',
        settings: { disableCookies: true, followOriginalHttpMethod: true, followAuthorizationHeader: true, removeRefererHeaderOnRedirect: true, httpVersion: '1.1', maxResponseBytes: 5e6 },
      }),
      { ...opts, httpVersion: '2', hosts: { 'h': '127.0.0.1' }, workingDirectory: '/work' },
    );
    expect(spec).toMatchObject({ disableCookies: true, followOriginalHttpMethod: true, followAuthorizationHeader: true, removeRefererHeaderOnRedirect: true, httpVersion: '1.1', hosts: { h: '127.0.0.1' }, workingDirectory: '/work' });
    expect(spec.maxResponseBytes).toBe(1e6); // clamped by the global limit
    // global preference applies when the request has none
    expect(buildHttpRequestSpec(emptyRequestDraft({ url: 'http://h/' }), { ...opts, httpVersion: '2' }).httpVersion).toBe('2');
  });

  it('encodeUrl: false sends the query as typed', () => {
    const draft = emptyRequestDraft({ url: 'http://h/a b', queryParams: [{ key: 'q', value: 'a b&c=d', enabled: true }, { key: 'off', value: 'x', enabled: false }, { key: 'flag', value: '', enabled: true }] });
    // default: query keys/values are percent-encoded (the path is left as typed; the URL parser escapes it on the wire)
    expect(buildHttpRequestSpec(draft, opts).url).toBe('http://h/a b?q=a%20b%26c%3Dd&flag');
    expect(buildRawRequestUrl(draft.url, draft.queryParams, draft.pathVariables)).toBe('http://h/a b?q=a b&c=d&flag');
    const raw = buildHttpRequestSpec({ ...draft, settings: { encodeUrl: false } }, opts);
    expect(raw.encodeUrl).toBe(false);
    // `&` and `=` inside the value are left as typed (they now split the query, exactly like Postman)
    expect(raw.url).toBe('http://h/a b?q=a b&c=d&flag');
    expect(buildRawRequestUrl('h/:id#frag', [], [{ key: 'id', value: '7', enabled: true }])).toBe('http://h/7');
  });

  it('resolveUploadPath: relative paths only inside the working directory, absolute paths unchanged', () => {
    const root = path.join(os.tmpdir(), 'aegis-wd');
    expect(() => resolveUploadPath('files/a.txt')).toThrow(/working directory/);
    expect(resolveUploadPath('files/a.txt', { workingDirectory: root })).toBe(path.resolve(root, 'files/a.txt'));
    expect(() => resolveUploadPath('../escape.txt', { workingDirectory: root })).toThrow(/outside/);
    expect(() => resolveUploadPath(path.join('..', '..', 'etc', 'passwd'), { workingDirectory: root })).toThrow(/outside/);
    const abs = path.resolve(os.tmpdir(), 'elsewhere', 'x.bin');
    expect(resolveUploadPath(abs, { workingDirectory: root })).toBe(abs);
    expect(() => resolveUploadPath('\\\\srv\\share\\x', { workingDirectory: root })).toThrow(/UNC/);
  });
});

describe('response view carries timings, TLS and connection details', () => {
  it('passes the new fields through', async () => {
    const res: HttpResponse = {
      status: 200, statusText: 'OK', httpVersion: 'HTTP/2', headers: [], body: Buffer.from('x'), size: 1, truncated: false, url: 'u', redirects: [],
      timings: { startedAt: 0, waitingMs: 5, downloadMs: 1, totalMs: 6, dnsMs: 1, connectMs: 2, tlsMs: 3 }, requestSize: 0, setCookies: [], notes: [],
      tls: { protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', alpn: 'h2', authorized: true, peerCertificate: { subject: 'CN=x', issuer: 'CN=ca', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2027-01-01T00:00:00.000Z', fingerprint: 'AA' } },
      connection: { remoteAddress: '10.0.0.1', remotePort: 443, localAddress: '10.0.0.2', localPort: 5555, hostOverride: '10.0.0.1', reused: false },
    };
    const view = await buildResponseView(res, 'r1');
    expect(view.timings).toEqual({ startedAt: 0, waitingMs: 5, downloadMs: 1, totalMs: 6, dnsMs: 1, connectMs: 2, tlsMs: 3 });
    expect(view.tls?.peerCertificate?.subject).toBe('CN=x');
    expect(view.connection?.hostOverride).toBe('10.0.0.1');
    expect(view.httpVersion).toBe('HTTP/2');
    const bare = await buildResponseView({ ...res, tls: undefined, connection: undefined, timings: { startedAt: 0, waitingMs: 1, downloadMs: 1, totalMs: 2 } }, 'r2');
    expect(bare.tls).toBeUndefined();
    expect(bare.timings).toEqual({ startedAt: 0, waitingMs: 1, downloadMs: 1, totalMs: 2 });
  });
});

describe('hosts override settings and policy', () => {
  it('policy key allowHostOverrides defaults to true and ignores malformed values', () => {
    expect(DEFAULT_POLICY.allowHostOverrides).toBe(true);
    expect(parsePolicy({}).allowHostOverrides).toBe(true);
    expect(parsePolicy({ allowHostOverrides: false }).allowHostOverrides).toBe(false);
    expect(parsePolicy({ allowHostOverrides: 'no' }).allowHostOverrides).toBe(true);
  });
  it('resolveHostOverrides validates entries and honours policy', () => {
    const entries = [{ host: 'API.Example.com', address: '10.0.0.5' }, { host: 'v6.test', address: '[::1]' }, { host: '', address: '1.2.3.4' }, { host: 'bad.test', address: 'not-an-ip' }];
    expect(resolveHostOverrides(entries, DEFAULT_POLICY)).toEqual({ hosts: { 'api.example.com': '10.0.0.5', 'v6.test': '::1' }, notes: [] });
    const blocked = resolveHostOverrides(entries, { ...DEFAULT_POLICY, allowHostOverrides: false });
    expect(blocked.hosts).toEqual({});
    expect(blocked.notes[0]).toMatch(/disabled by organization policy/);
    expect(resolveHostOverrides([], { ...DEFAULT_POLICY, allowHostOverrides: false })).toEqual({ hosts: {}, notes: [] });
  });
  it('settings merge accepts the new network/files keys', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { network: { httpVersion: '1.1', hosts: [{ host: 'a.test', address: '127.0.0.1' }] }, files: { workingDirectory: 'C:\\work' } });
    expect(merged.network.httpVersion).toBe('1.1');
    expect(merged.network.hosts).toEqual([{ host: 'a.test', address: '127.0.0.1' }]);
    expect(merged.files.workingDirectory).toBe('C:\\work');
    expect(DEFAULT_SETTINGS.network.httpVersion).toBe('auto');
    expect(DEFAULT_SETTINGS.files.workingDirectory).toBe('');
  });
  it('renderer helpers validate host names, IPs and bulk text', () => {
    expect(isValidHostName('api.example.com')).toBe(true);
    expect(isValidHostName('localhost')).toBe(true);
    expect(isValidHostName('http://x')).toBe(false);
    expect(isValidHostName('a b')).toBe(false);
    expect(isIpLiteral('10.0.0.5')).toBe(true);
    expect(isIpLiteral('256.1.1.1')).toBe(false);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('[fe80::1]')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
    expect(validateHostOverride({ host: 'x.test', address: '1.1.1.1' })).toBeNull();
    expect(validateHostOverride({ host: 'x.test', address: 'y' })).toMatch(/IPv4 or IPv6/);
    expect(normalizeHostOverrides([{ host: 'A.test', address: '1.1.1.1' }, { host: 'a.test', address: '2.2.2.2' }, { host: '', address: '' }])).toEqual([{ host: 'a.test', address: '2.2.2.2' }]);
    expect(parseHostsText('# comment\napi.test 10.0.0.1\n10.0.0.2 db.test # hosts-file order\nx.test=::1\nbroken')).toEqual([
      { host: 'api.test', address: '10.0.0.1' },
      { host: 'db.test', address: '10.0.0.2' },
      { host: 'x.test', address: '::1' },
    ]);
  });
  it('working directory validation', () => {
    expect(validateWorkingDirectory('')).toBeNull();
    expect(validateWorkingDirectory('C:\\work')).toBeNull();
    expect(validateWorkingDirectory('/home/me/work')).toBeNull();
    expect(validateWorkingDirectory('relative/dir')).toMatch(/absolute/);
    expect(validateWorkingDirectory('\\\\server\\share')).toMatch(/UNC/);
  });
});

describe('Postman protocolProfileBehavior mapping', () => {
  const collection = (profile: Record<string, unknown>) => ({
    info: { name: 'P', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'r', request: { method: 'GET', url: 'http://x/' }, protocolProfileBehavior: profile }],
  });
  it('imports the request-setting keys and preserves the rest', () => {
    const r = parsePostmanCollection(JSON.stringify(collection({ disableCookies: true, disableUrlEncoding: true, followOriginalHttpMethod: true, followAuthorizationHeader: false, removeRefererHeaderOnRedirect: true, strictSSL: false, disableBodyPruning: true, maxRedirects: 3 })));
    const req = (r.bundle.items[0] as { request: { settings: unknown; metadata: Record<string, unknown> } }).request;
    expect(req.settings).toEqual({ disableCookies: true, encodeUrl: false, followOriginalHttpMethod: true, followAuthorizationHeader: false, removeRefererHeaderOnRedirect: true, verifyTls: false, maxRedirects: 3 });
    expect(req.metadata.protocolProfileBehavior).toEqual({ disableBodyPruning: true });
  });
  it('round-trips through export', () => {
    const source = collection({ disableCookies: true, disableUrlEncoding: true, followOriginalHttpMethod: true, followAuthorizationHeader: true, removeRefererHeaderOnRedirect: false, disableBodyPruning: true });
    const out = exportPostmanCollection(parsePostmanCollection(JSON.stringify(source)).bundle);
    expect((out.item[0] as { protocolProfileBehavior: unknown }).protocolProfileBehavior).toEqual({
      disableCookies: true,
      disableUrlEncoding: true,
      followOriginalHttpMethod: true,
      followAuthorizationHeader: true,
      removeRefererHeaderOnRedirect: false,
      disableBodyPruning: true,
    });
    // non-boolean values are preserved, not mapped
    const odd = parsePostmanCollection(JSON.stringify(collection({ disableCookies: 'yes' })));
    const req = (odd.bundle.items[0] as { request: { settings: unknown; metadata: Record<string, unknown> } }).request;
    expect(req.settings).toEqual({});
    expect(req.metadata.protocolProfileBehavior).toEqual({ disableCookies: 'yes' });
  });
});

describe('executor fixes (service level)', () => {
  let server: TestServer;
  let t: TestApp;
  let wsId = '';
  let certDir = '';
  let key = '';
  let cert = '';
  let tls: TestServer | undefined;
  let mtls: TestServer | undefined;

  beforeAll(async () => {
    server = await startServer();
    t = createTestApp();
    wsId = (await t.api.workspaces.list())[0]!.id;
    try {
      certDir = mkdtempSync(path.join(os.tmpdir(), 'aegis-rt-tls-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
      key = readFileSync(path.join(certDir, 'k.pem'), 'utf8');
      cert = readFileSync(path.join(certDir, 'c.pem'), 'utf8');
      execFileSync('openssl', ['pkcs12', '-export', '-inkey', path.join(certDir, 'k.pem'), '-in', path.join(certDir, 'c.pem'), '-out', path.join(certDir, 'client.pfx'), '-passout', 'pass:pfx-pass'], { stdio: 'ignore' });
      tls = await startHttpsServer(key, cert);
      mtls = await startHttpsServer(key, cert, { requestCert: true, ca: [cert] });
    } catch {
      tls = undefined;
      mtls = undefined;
    }
  });
  afterAll(async () => {
    await tls?.close();
    await mtls?.close();
    await t.close();
    await server.close();
    if (certDir) rmSync(certDir, { recursive: true, force: true });
  });

  it('#2 runScripts: false skips pre-request and test scripts', async () => {
    const draft = emptyRequestDraft({
      url: `${server.url}/echo`,
      scripts: [
        { type: 'prerequest', language: 'javascript', enabled: true, source: 'pm.request.headers.add({ key: "X-Pre", value: "ran" });' },
        { type: 'test', language: 'javascript', enabled: true, source: 'pm.test("t", () => pm.expect(1).to.equal(1));' },
      ],
    });
    const withScripts = await t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft });
    expect(JSON.parse(withScripts.response!.bodyPreview).headers['x-pre']).toBe('ran');
    expect(withScripts.tests).toHaveLength(1);
    const without = await t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft, runScripts: false });
    expect(without.ok).toBe(true);
    expect(JSON.parse(without.response!.bodyPreview).headers['x-pre']).toBeUndefined();
    expect(without.tests).toHaveLength(0);
    expect(without.console).toHaveLength(0);
  });

  it('#3 "Get new access token" resolves collection and folder variables and is cancellable', async () => {
    const col = await t.api.collections.create({ workspaceId: wsId, name: 'OAuth' });
    const folder = await t.api.folders.create({ collectionId: col.id, parentFolderId: null, name: 'F' });
    await t.api.variables.set({ scope: 'collection', ownerId: col.id, entries: [{ key: 'tokenUrl', initialValue: `${server.url}/token`, isSecret: false, enabled: true }, { key: 'clientId', initialValue: 'from-collection', isSecret: false, enabled: true }] });
    await t.api.variables.set({ scope: 'folder', ownerId: folder.id, entries: [{ key: 'clientId', initialValue: 'from-folder', isSecret: false, enabled: true }] });
    const auth = { type: 'oauth2' as const, params: { grant_type: 'client_credentials', accessTokenUrl: '{{tokenUrl}}', clientId: '{{clientId}}', clientSecret: 's', client_authentication: 'body' } };
    const viaCollection = await t.api.tools.oauth2GetToken({ auth, workspaceId: wsId, collectionId: col.id });
    expect(viaCollection.params.accessToken).toBe('AT-from-collection');
    const viaFolder = await t.api.tools.oauth2GetToken({ auth, workspaceId: wsId, collectionId: col.id, folderId: folder.id });
    expect(viaFolder.params.accessToken).toBe('AT-from-folder');
    // a saved request supplies its own collection/folder chain
    const req = await t.api.requests.create({ collectionId: col.id, folderId: folder.id, draft: emptyRequestDraft({ url: 'http://x/' }) });
    const viaRequest = await t.api.tools.oauth2GetToken({ auth, workspaceId: wsId, requestId: req.id });
    expect(viaRequest.params.accessToken).toBe('AT-from-folder');
    // without scope information the variables stay unresolved -> the token endpoint URL is invalid
    await expect(t.api.tools.oauth2GetToken({ auth, workspaceId: wsId })).rejects.toBeTruthy();

    // cancellation through execution.cancel(cancelId)
    const cancelId = newId();
    const pending = t.api.tools.oauth2GetToken({ auth: { ...auth, params: { ...auth.params, accessTokenUrl: `${server.url}/hang` } }, workspaceId: wsId, cancelId });
    await new Promise((r) => setTimeout(r, 150));
    await t.api.execution.cancel({ executionId: cancelId });
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('#5 per-request "strict SSL off" is honoured only when policy allows insecure TLS', async (ctx) => {
    if (!tls) return ctx.skip();
    const draft = emptyRequestDraft({ url: `${tls.url}/echo`, settings: { verifyTls: false } });
    // default policy: enforced on -> the self-signed server is rejected and the user is told why
    const strict = await t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft });
    expect(strict.ok).toBe(false);
    expect(strict.error?.code).toBe('TLS_ERROR');
    expect(strict.warnings.some((w) => /policy enforces it/.test(w))).toBe(true);

    const lenient = createTestApp({ policy: { allowInsecureTls: true } });
    try {
      const w = (await lenient.api.workspaces.list())[0]!.id;
      const res = await lenient.api.execution.send({ executionId: newId(), workspaceId: w, draft });
      expect(res.ok).toBe(true);
      expect(res.response?.status).toBe(200);
      expect(res.warnings.some((w2) => /request settings, allowed by policy/.test(w2))).toBe(true);
      expect(res.response?.notes.join(' ')).toContain('certificate validation is disabled');
      expect(res.response?.tls?.authorized).toBe(false);
      // the global setting stays verified: a request without the per-request flag is still rejected
      const normal = await lenient.api.execution.send({ executionId: newId(), workspaceId: w, draft: emptyRequestDraft({ url: `${tls!.url}/echo` }) });
      expect(normal.error?.code).toBe('TLS_ERROR');
    } finally {
      await lenient.close();
    }
  });

  it('#8 imported relative form-data paths upload once a working directory is set', async () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'aegis-workdir-'));
    writeFileSync(path.join(work, 'avatar.png'), Buffer.alloc(100, 7));
    try {
      const draft = emptyRequestDraft({ method: 'POST', url: `${server.url}/echo`, body: { mode: 'formdata', formData: [{ key: 'file', type: 'file', value: '', filePath: 'avatar.png', enabled: true }] } });
      const before = await t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft });
      expect(before.error?.code).toBe('PATH_NOT_ALLOWED');
      await t.api.settings.update({ patch: { files: { workingDirectory: work } } });
      const after = await t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft });
      expect(after.ok).toBe(true);
      expect(JSON.parse(after.response!.bodyPreview).body).toContain('filename="avatar.png"');
      // but nothing outside the working directory
      const escape = { ...draft, body: { ...draft.body, formData: [{ key: 'file', type: 'file' as const, value: '', filePath: path.join('..', 'x.txt'), enabled: true }] } };
      expect((await t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft: escape })).error?.code).toBe('PATH_NOT_ALLOWED');
    } finally {
      await t.api.settings.update({ patch: { files: { workingDirectory: '' } } });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('hosts override at the service level is listed in the response and gated by policy', async () => {
    await t.api.settings.update({ patch: { network: { hosts: [{ host: 'aegis-override.test', address: '127.0.0.1' }] } } });
    try {
      const res = await t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft: emptyRequestDraft({ url: `http://aegis-override.test:${server.port}/host` }) });
      expect(res.ok).toBe(true);
      expect(res.response?.connection?.hostOverride).toBe('127.0.0.1');
      expect(res.response?.notes.join(' ')).toContain('hosts override');
      const gated = createTestApp({ policy: { allowHostOverrides: false } });
      try {
        const w = (await gated.api.workspaces.list())[0]!.id;
        await gated.api.settings.update({ patch: { network: { hosts: [{ host: 'aegis-override.test', address: '127.0.0.1' }] } } });
        const blocked = await gated.api.execution.send({ executionId: newId(), workspaceId: w, draft: emptyRequestDraft({ url: `http://aegis-override.test:${server.port}/host` }) });
        expect(blocked.ok).toBe(false);
        expect(blocked.error?.code).toBe('NETWORK_ERROR');
        expect(blocked.warnings.some((n) => /disabled by organization policy/.test(n))).toBe(true);
      } finally {
        await gated.close();
      }
    } finally {
      await t.api.settings.update({ patch: { network: { hosts: [] } } });
    }
  });

  it('#15 PKCS#12 client certificates can be added (file or base64) and are used for mutual TLS', async (ctx) => {
    if (!mtls) return ctx.skip();
    const pfxPath = path.join(certDir, 'client.pfx');
    await t.api.certificates.add({ kind: 'ca', name: 'test ca', certPem: cert });
    // without a client certificate the mTLS server refuses the handshake
    const refused = await t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft: emptyRequestDraft({ url: `${mtls.url}/echo` }) });
    expect(refused.ok).toBe(false);

    const added = await t.api.certificates.add({ kind: 'client', name: 'pfx client', hostPattern: '127.0.0.1', pfxPath, passphrase: 'pfx-pass' });
    expect(added).toMatchObject({ kind: 'client', hasPfx: true, hasKey: false, hasPassphrase: true });
    expect(JSON.stringify(added)).not.toContain('pfx-pass');
    const ok = await t.api.execution.send({ executionId: newId(), workspaceId: wsId, draft: emptyRequestDraft({ url: `${mtls.url}/echo` }) });
    expect(ok.ok).toBe(true);
    expect(ok.response?.status).toBe(200);
    expect(ok.response?.notes.join(' ')).toContain('Client certificate attached (PKCS#12)');
    await t.api.certificates.delete({ id: added.id });

    const viaBase64 = await t.api.certificates.add({ kind: 'client', name: 'pfx b64', hostPattern: '127.0.0.1', pfxBase64: readFileSync(pfxPath).toString('base64'), passphrase: 'pfx-pass' });
    expect(viaBase64.hasPfx).toBe(true);
    // the bundle and passphrase live in the vault, never in a plain column
    const rows = JSON.stringify(t.app.ctx.storage.opened.client.native.prepare('select * from certificates').all());
    expect(rows).not.toContain('pfx-pass');
    expect(rows).not.toContain(readFileSync(pfxPath).toString('base64').slice(0, 40));
    await t.api.certificates.delete({ id: viaBase64.id });

    // validation: not a PKCS#12 bundle, PEM + PFX mixed, client cert without any key material
    await expect(t.api.certificates.add({ kind: 'client', name: 'x', pfxBase64: Buffer.from('not der').toString('base64') })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(t.api.certificates.add({ kind: 'client', name: 'x', pfxPath, certPem: cert })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(t.api.certificates.add({ kind: 'client', name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(t.api.certificates.add({ kind: 'client', name: 'x', pfxPath: path.join(certDir, 'missing.pfx') })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
