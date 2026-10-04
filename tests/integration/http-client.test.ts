import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, headerValue, type CookieJarHook } from '@aegis/core';
import { HttpProtocolClient, resolveProxyFromEnv, shouldBypassProxy } from '@aegis/http-client';
import { makeSpec, startHttpsServer, startServer, type TestServer } from '../helpers/http-server';

let server: TestServer;
let tmp: string;
const client = new HttpProtocolClient();
const text = (r: { body: Uint8Array }) => Buffer.from(r.body).toString('utf8');

beforeAll(async () => {
  server = await startServer();
  tmp = mkdtempSync(path.join(os.tmpdir(), 'aegis-http-'));
});
afterAll(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('HttpProtocolClient', () => {
  it('sends a GET and returns status, headers, size and timings', async () => {
    const res = await client.send(makeSpec({ url: `${server.url}/echo?a=1`, headers: [{ name: 'X-Test', value: 'yes' }] }));
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
    const json = JSON.parse(text(res));
    expect(json.method).toBe('GET');
    expect(json.path).toBe('/echo?a=1');
    expect(json.headers['x-test']).toBe('yes');
    expect(res.size).toBe(res.body.length);
    expect(res.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(headerValue(res.headers, 'content-type')).toContain('application/json');
  });

  it('sends JSON, urlencoded and multipart bodies (file streamed from disk)', async () => {
    const post = await client.send(makeSpec({ url: `${server.url}/echo`, method: 'POST', body: { kind: 'text', text: '{"a":1}' }, headers: [{ name: 'Content-Type', value: 'application/json' }] }));
    expect(JSON.parse(text(post)).body).toBe('{"a":1}');

    const form = await client.send(makeSpec({ url: `${server.url}/echo`, method: 'POST', body: { kind: 'urlencoded', entries: [{ name: 'a b', value: 'c&d' }] } }));
    const fj = JSON.parse(text(form));
    expect(fj.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(fj.body).toBe('a+b=c%26d');

    const file = path.join(tmp, 'upload.bin');
    writeFileSync(file, Buffer.alloc(300_000, 7));
    const mp = await client.send(
      makeSpec({
        url: `${server.url}/echo`,
        method: 'POST',
        body: { kind: 'multipart', parts: [{ kind: 'text', name: 'field', value: 'hello' }, { kind: 'file', name: 'upload', path: file }] },
      }),
    );
    const mj = JSON.parse(text(mp));
    expect(mj.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(mj.bodyLength).toBeGreaterThan(300_000);
    expect(mj.body).toContain('name="field"');
    expect(mj.body).toContain('filename="upload.bin"');

    const bin = await client.send(makeSpec({ url: `${server.url}/echo`, method: 'PUT', body: { kind: 'file', path: file } }));
    expect(JSON.parse(text(bin)).bodyLength).toBe(300_000);
  });

  it('rejects unsafe upload paths and oversize request bodies', async () => {
    await expect(client.send(makeSpec({ url: `${server.url}/echo`, method: 'POST', body: { kind: 'file', path: '\\\\evil\\share\\x' } }))).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(client.send(makeSpec({ url: `${server.url}/echo`, method: 'POST', maxRequestBytes: 10, body: { kind: 'text', text: 'x'.repeat(100) } }))).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
  });

  it('follows redirects, records hops, honours max and the disabled setting', async () => {
    const res = await client.send(makeSpec({ url: `${server.url}/redirect/3` }));
    expect(res.status).toBe(200);
    expect(res.redirects).toHaveLength(3);
    expect(new URL(res.url).pathname).toBe('/redirect/0');

    await expect(client.send(makeSpec({ url: `${server.url}/redirect/5`, maxRedirects: 2 }))).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });

    const manual = await client.send(makeSpec({ url: `${server.url}/redirect/1`, followRedirects: false }));
    expect(manual.status).toBe(302);
    expect(headerValue(manual.headers, 'location')).toBe('/redirect/0');
  });

  it('converts POST to GET on 302/303 but preserves method and body on 307', async () => {
    const r302 = await client.send(makeSpec({ url: `${server.url}/redirect/1`, method: 'POST', body: { kind: 'text', text: 'payload' } }));
    expect(JSON.parse(text(r302)).method).toBe('GET');
    const r307 = await client.send(makeSpec({ url: `${server.url}/redirect/1?code=307`, method: 'POST', body: { kind: 'text', text: 'payload' } }));
    const j = JSON.parse(text(r307));
    expect(j.method).toBe('POST');
    expect(j.body).toBe('payload');
  });

  it('does not forward credentials to a different origin on redirect', async () => {
    const target = `${server.url.replace('127.0.0.1', 'localhost')}/redirect/0`;
    const res = await client.send(
      makeSpec({ url: `${server.url}/redirect-abs?to=${encodeURIComponent(target)}`, headers: [{ name: 'Authorization', value: 'Bearer secret' }, { name: 'X-Keep', value: '1' }] }),
    );
    const j = JSON.parse(text(res));
    expect(j.headers.authorization).toBeUndefined();
    expect(j.headers['x-keep']).toBe('1');
    expect(res.notes.join(' ')).toContain('credentials were not forwarded');
  });

  it('times out and cancels', async () => {
    await expect(client.send(makeSpec({ url: `${server.url}/delay/1500`, timeoutMs: 200 }))).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

    const spec = makeSpec({ url: `${server.url}/hang` });
    const pending = client.send(spec);
    await new Promise((r) => setTimeout(r, 100));
    expect(client.isInflight(spec.id)).toBe(true);
    await client.cancel(spec.id);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(client.isInflight(spec.id)).toBe(false);
  });

  it('maps network errors to structured errors', async () => {
    const closed = await startServer();
    const url = closed.url;
    await closed.close();
    const err = await client.send(makeSpec({ url: `${url}/x` })).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('NETWORK_ERROR');
    await expect(client.send(makeSpec({ url: 'ftp://example.com/' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('decompresses gzip and enforces the limit on the DECOMPRESSED size', async () => {
    const gz = await client.send(makeSpec({ url: `${server.url}/gzip` }));
    expect(JSON.parse(text(gz))).toEqual({ gz: true });
    await expect(client.send(makeSpec({ url: `${server.url}/bomb`, maxResponseBytes: 5 * 1024 * 1024 }))).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('spills large responses to a file and keeps a preview in memory', async () => {
    const res = await client.send(makeSpec({ url: `${server.url}/big/12`, spillThresholdBytes: 1024 * 1024, spillDirectory: tmp }));
    expect(res.size).toBe(12 * 1024 * 1024);
    expect(res.bodyFilePath).toBeTruthy();
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(1024 * 1024);
    expect(statSync(res.bodyFilePath!).size).toBe(res.size);
    await expect(client.send(makeSpec({ url: `${server.url}/big/12`, maxResponseBytes: 2 * 1024 * 1024, spillDirectory: tmp }))).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('applies the cookie jar hook on every hop', async () => {
    const jar = new Map<string, string>();
    const hook: CookieJarHook = {
      getCookieHeader: () => (jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : undefined),
      storeSetCookies: (_url, list) => {
        for (const c of list) {
          const [pair] = c.split(';');
          const [k, v] = pair!.split('=');
          jar.set(k!, v!);
        }
      },
    };
    const jarClient = new HttpProtocolClient({ cookies: hook });
    const set = await jarClient.send(makeSpec({ url: `${server.url}/cookie-set` }));
    expect(set.setCookies).toHaveLength(2);
    const echo = await jarClient.send(makeSpec({ url: `${server.url}/cookie-echo` }));
    expect(JSON.parse(text(echo)).cookie).toBe('sid=abc123; theme=dark');
  });

  it('can block requests through the beforeRequest hook (policy)', async () => {
    const blocking = new HttpProtocolClient({
      beforeRequest(url) {
        if (url.hostname === '127.0.0.1') throw new AppError('POLICY_VIOLATION', 'blocked');
      },
    });
    await expect(blocking.send(makeSpec({ url: `${server.url}/echo` }))).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
  });
});

describe('proxy helpers', () => {
  it('honours NO_PROXY patterns', () => {
    expect(shouldBypassProxy('http://api.corp.local/x', '.corp.local')).toBe(true);
    expect(shouldBypassProxy('http://corp.local/x', 'corp.local')).toBe(true);
    expect(shouldBypassProxy('http://other.com/x', '.corp.local,localhost')).toBe(false);
    expect(shouldBypassProxy('http://other.com:8080/x', 'other.com:9090')).toBe(false);
    expect(shouldBypassProxy('http://anything/x', '*')).toBe(true);
  });
  it('reads proxy settings from the environment', () => {
    const env = { HTTPS_PROXY: 'http://user:p%40ss@proxy.corp:3128', NO_PROXY: 'internal.corp' };
    expect(resolveProxyFromEnv('https://api.example.com/', env)).toMatchObject({ url: 'http://proxy.corp:3128', username: 'user', password: 'p@ss' });
    expect(resolveProxyFromEnv('https://internal.corp/', env)).toBeUndefined();
    expect(resolveProxyFromEnv('http://api.example.com/', { ...env, HTTP_PROXY: undefined })).toBeUndefined();
  });
});

describe('TLS', () => {
  let certDir: string;
  let tls: TestServer | undefined;
  let key = '';
  let cert = '';

  beforeAll(async () => {
    try {
      certDir = mkdtempSync(path.join(os.tmpdir(), 'aegis-tls-'));
      execFileSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
        { stdio: 'ignore' },
      );
      key = readFileSync(path.join(certDir, 'k.pem'), 'utf8');
      cert = readFileSync(path.join(certDir, 'c.pem'), 'utf8');
      tls = await startHttpsServer(key, cert);
    } catch {
      tls = undefined;
    }
  });
  afterAll(async () => {
    await tls?.close();
    if (certDir) rmSync(certDir, { recursive: true, force: true });
  });

  it('rejects an untrusted certificate by default (never silently disabled)', async (ctx) => {
    if (!tls) return ctx.skip();
    await expect(client.send(makeSpec({ url: `${tls.url}/echo` }))).rejects.toMatchObject({ code: 'TLS_ERROR' });
  });

  it('accepts it with a custom CA, and with verification explicitly disabled (with a warning note)', async (ctx) => {
    if (!tls) return ctx.skip();
    const trusted = await client.send(makeSpec({ url: `${tls.url}/echo`, tls: { rejectUnauthorized: true, ca: [cert] } }));
    expect(trusted.status).toBe(200);
    const insecure = await client.send(makeSpec({ url: `${tls.url}/echo`, tls: { rejectUnauthorized: false } }));
    expect(insecure.status).toBe(200);
    expect(insecure.notes.join(' ')).toContain('certificate validation is disabled');
  });
});
