/**
 * Digest, Hawk, Akamai EdgeGrid, ASAP, OAuth 1.0 RSA, JWT ES/PS algorithms and the OAuth 2.0 device flow.
 * Everything with a key is verified with node:crypto, everything with a server against the
 * independent implementation in tests/helpers/auth-server.ts.
 */
import { constants, createHash, createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asapProvider,
  buildAsapToken,
  buildDigestHeader,
  buildEdgeGridHeader,
  buildHawkHeader,
  createDefaultAuthRegistry,
  decodeJwt,
  digestChallenges,
  digestProvider,
  edgeGridProvider,
  edgeGridTimestamp,
  hawkProvider,
  jwtProvider,
  loadPrivateKey,
  oauth1Provider,
  oauth1Sign,
  oauth2Provider,
  parseExpiry,
  parseWwwAuthenticate,
  pollDeviceToken,
  pollDeviceTokenOnce,
  signJwt,
  startDeviceFlow,
  type AuthContext,
} from '@aegis/authentication';
import { AUTH_SECRET_PARAMS, EXECUTABLE_CUSTOM_AUTH_PROVIDERS } from '@aegis/core';
import { DEVICE_TOKEN, DIGEST_PASSWORD, DIGEST_USER, HAWK_ID, HAWK_KEY, startAuthTestServer, type AuthTestServer } from '../helpers/auth-server';

const NOW = 1_700_000_000_000;

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  method: 'GET',
  url: 'https://api.test/x',
  headers: [],
  body: { kind: 'none' },
  now: () => NOW,
  send: async () => {
    throw new Error('no network');
  },
  ...over,
});

/** Executor-like context against the local server: `challenge()` sends without auth, `send()` posts forms. */
function serverCtx(over: Partial<AuthContext> & { url: string }): AuthContext {
  const base = ctx(over);
  return {
    ...base,
    challenge: async () => {
      const res = await fetch(base.url, { method: base.method, headers: Object.fromEntries(base.headers.map((h) => [h.name, h.value])), ...(base.body.kind === 'text' ? { body: base.body.text } : {}) });
      await res.arrayBuffer();
      const headers: Array<{ name: string; value: string }> = [];
      res.headers.forEach((value, name) => headers.push({ name, value }));
      return { status: res.status, headers };
    },
    send: async (req) => {
      const res = await fetch(req.url, { method: req.method, headers: Object.fromEntries(req.headers.map((h) => [h.name, h.value])), body: req.body });
      return { status: res.status, bodyText: await res.text() };
    },
  };
}

/** Send the request with the provider's headers and return the server's JSON. */
async function sendWith(c: AuthContext, headers: Array<{ name: string; value: string }>): Promise<{ status: number; body: Record<string, unknown> }> {
  const all = Object.fromEntries([...c.headers, ...headers].map((h) => [h.name, h.value]));
  const res = await fetch(c.url, { method: c.method, headers: all, ...(c.body.kind === 'text' ? { body: c.body.text } : {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let server: AuthTestServer;
beforeAll(async () => {
  server = await startAuthTestServer();
});
afterAll(() => server.close());

// ----------------------------------------------------------------------------- Digest

describe('Digest (RFC 7616)', () => {
  const RFC = {
    realm: 'http-auth@example.org',
    nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
    opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
    qop: ['auth'],
    userhash: false,
    stale: false,
  };
  const rfcInputs = (algorithm: string) => ({
    username: 'Mufasa',
    password: 'Circle of Life',
    method: 'GET',
    url: 'http://www.example.org/dir/index.html',
    challenge: { ...RFC, algorithm },
    nc: 1,
    cnonce: 'f2/wE4q74E6j5WYdKC3bgQ=',
  });

  it('reproduces the RFC 2617 section 3.5 example response (MD5, qop=auth)', () => {
    const rfc2617 = buildDigestHeader({
      username: 'Mufasa',
      password: 'Circle Of Life',
      method: 'GET',
      url: 'http://www.nowhere.org/dir/index.html',
      challenge: { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41', algorithm: 'MD5', qop: ['auth'], userhash: false, stale: false },
      nc: 1,
      cnonce: '0a4f113b',
    });
    expect(rfc2617.response).toBe('6629fae49393a05397450978507c4ef1');
    expect(rfc2617.value).toBe(
      'Digest username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="/dir/index.html", algorithm=MD5, qop=auth, nc=00000001, cnonce="0a4f113b", response="6629fae49393a05397450978507c4ef1", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    );
  });

  it('computes the RFC 7616 section 3.9.1 example (MD5 and SHA-256) exactly like a by-hand evaluation of the formula', () => {
    // The response values printed in RFC 7616 itself are disputed by errata, so the expectation is the formula evaluated independently here.
    for (const [algorithm, hash] of [
      ['MD5', 'md5'],
      ['SHA-256', 'sha256'],
    ] as const) {
      const H = (s: string) => createHash(hash).update(s).digest('hex');
      const expected = H(`${H('Mufasa:http-auth@example.org:Circle of Life')}:${RFC.nonce}:00000001:f2/wE4q74E6j5WYdKC3bgQ=:auth:${H('GET:/dir/index.html')}`);
      const out = buildDigestHeader(rfcInputs(algorithm));
      expect(out.response).toBe(expected);
      expect(out.value).toBe(
        `Digest username="Mufasa", realm="http-auth@example.org", nonce="${RFC.nonce}", uri="/dir/index.html", algorithm=${algorithm}, qop=auth, nc=00000001, cnonce="f2/wE4q74E6j5WYdKC3bgQ=", response="${expected}", opaque="${RFC.opaque}"`,
      );
    }
  });

  it('supports session algorithms, auth-int, RFC 2069 mode, userhash and rejects unknown algorithms', () => {
    const H = (s: string) => createHash('md5').update(s).digest('hex');
    const sess = buildDigestHeader({ ...rfcInputs('MD5-sess') });
    const a1 = H(`${H('Mufasa:http-auth@example.org:Circle of Life')}:${RFC.nonce}:f2/wE4q74E6j5WYdKC3bgQ=`);
    expect(sess.response).toBe(H(`${a1}:${RFC.nonce}:00000001:f2/wE4q74E6j5WYdKC3bgQ=:auth:${H('GET:/dir/index.html')}`));

    const authInt = buildDigestHeader({ ...rfcInputs('MD5'), method: 'POST', challenge: { ...RFC, algorithm: 'MD5', qop: ['auth-int'] }, body: '{"a":1}' });
    expect(authInt.qop).toBe('auth-int');
    expect(authInt.response).toBe(H(`${H('Mufasa:http-auth@example.org:Circle of Life')}:${RFC.nonce}:00000001:f2/wE4q74E6j5WYdKC3bgQ=:auth-int:${H(`POST:/dir/index.html:${H('{"a":1}')}`)}`));
    // auth-int without a hashable body falls back to auth when offered, otherwise fails
    expect(buildDigestHeader({ ...rfcInputs('MD5'), challenge: { ...RFC, algorithm: 'MD5', qop: ['auth-int', 'auth'] } }).qop).toBe('auth');
    expect(() => buildDigestHeader({ ...rfcInputs('MD5'), challenge: { ...RFC, algorithm: 'MD5', qop: ['auth-int'] } })).toThrow(/auth-int/);

    const legacy = buildDigestHeader({ ...rfcInputs('MD5'), challenge: { ...RFC, algorithm: 'MD5', qop: [] } });
    expect(legacy.qop).toBeUndefined();
    expect(legacy.value).not.toContain('nc=');
    expect(legacy.response).toBe(H(`${H('Mufasa:http-auth@example.org:Circle of Life')}:${RFC.nonce}:${H('GET:/dir/index.html')}`));

    const hashed = buildDigestHeader({ ...rfcInputs('SHA-256'), challenge: { ...RFC, algorithm: 'SHA-256', userhash: true } });
    expect(hashed.value).toContain(`username="${createHash('sha256').update('Mufasa:http-auth@example.org').digest('hex')}"`);
    expect(hashed.value).toContain('userhash=true');

    expect(() => buildDigestHeader(rfcInputs('SHA-1'))).toThrow(/not supported/);
    expect(() => buildDigestHeader({ ...rfcInputs('MD5'), challenge: { ...RFC, algorithm: 'MD5', qop: ['weird'] } })).toThrow(/unsupported Digest qop/);
  });

  it('parses WWW-Authenticate with several challenges, quoted commas and multiple header lines', () => {
    const parsed = parseWwwAuthenticate(['Basic realm="x, y"', 'Digest realm="r", qop="auth,auth-int", nonce="n1", algorithm=SHA-256, Digest realm="r", nonce="n2", algorithm=MD5, opaque="a\\"b"']);
    expect(parsed.map((c) => c.scheme)).toEqual(['Basic', 'Digest', 'Digest']);
    expect(parsed[0]!.params.realm).toBe('x, y');
    const digests = digestChallenges(parsed);
    expect(digests).toHaveLength(2);
    expect(digests[0]).toMatchObject({ realm: 'r', nonce: 'n1', algorithm: 'SHA-256', qop: ['auth', 'auth-int'] });
    expect(digests[1]).toMatchObject({ nonce: 'n2', algorithm: 'MD5', opaque: 'a"b', qop: [] });
  });

  const digestParams = (over: Record<string, string | boolean> = {}) => ({ providerId: 'digest', username: DIGEST_USER, password: DIGEST_PASSWORD, ...over });

  it('authenticates against a real MD5 challenge (401 round trip), then the server accepts the retry', async () => {
    const c = serverCtx({ url: `${server.url}/digest/md5?x=1` });
    const result = await digestProvider.apply(digestParams(), c);
    expect(result.notes.join(' ')).toMatch(/challenge received/);
    expect(result.headers[0]!.name).toBe('Authorization');
    expect(result.headers[0]!.value).toContain('uri="/digest/md5?x=1"');
    expect(result.headers[0]!.value).toContain('opaque="opaque-value-9"');
    const sent = await sendWith(c, result.headers);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, user: DIGEST_USER, algorithm: 'MD5', qop: 'auth' });
    // the password never appears in headers or notes
    expect(JSON.stringify(result)).not.toContain(DIGEST_PASSWORD);
  });

  it('picks SHA-256 when the server lists it first, honours a configured algorithm preference and a Basic+Digest mix', async () => {
    const c = serverCtx({ url: `${server.url}/digest/sha256` });
    const sha = await digestProvider.apply(digestParams(), c);
    expect(sha.headers[0]!.value).toContain('algorithm=SHA-256');
    expect((await sendWith(c, sha.headers)).body).toMatchObject({ ok: true, algorithm: 'SHA-256' });

    const md5 = await digestProvider.apply(digestParams({ algorithm: 'MD5' }), c);
    expect(md5.headers[0]!.value).toContain('algorithm=MD5');
    expect((await sendWith(c, md5.headers)).body).toMatchObject({ ok: true, algorithm: 'MD5' });

    const mixed = serverCtx({ url: `${server.url}/digest/mixed` });
    const m = await digestProvider.apply(digestParams(), mixed);
    expect((await sendWith(mixed, m.headers)).body).toMatchObject({ ok: true, algorithm: 'SHA-256' });
  });

  it('handles auth-int with a POST body, session algorithms and RFC 2069 servers', async () => {
    const c = serverCtx({ method: 'POST', url: `${server.url}/digest/auth-int`, headers: [{ name: 'Content-Type', value: 'application/json' }], body: { kind: 'text', text: '{"metric":1}' } });
    const r = await digestProvider.apply(digestParams({ qop: 'auth-int' }), c);
    expect(r.headers[0]!.value).toContain('qop=auth-int');
    expect((await sendWith(c, r.headers)).body).toMatchObject({ ok: true, qop: 'auth-int', body: '{"metric":1}' });

    const sess = serverCtx({ url: `${server.url}/digest/sess` });
    expect((await sendWith(sess, (await digestProvider.apply(digestParams(), sess)).headers)).body).toMatchObject({ ok: true, algorithm: 'SHA-256-sess' });

    const legacy = serverCtx({ url: `${server.url}/digest/legacy` });
    const l = await digestProvider.apply(digestParams(), legacy);
    expect(l.headers[0]!.value).not.toContain('qop=');
    expect((await sendWith(legacy, l.headers)).body).toMatchObject({ ok: true, qop: null });
  });

  it('increments the nonce count per server nonce and uses configured nonce/cnonce/nonceCount without a round trip', async () => {
    const c = serverCtx({ url: `${server.url}/digest/fixed` });
    const first = await digestProvider.apply(digestParams(), c);
    const second = await digestProvider.apply(digestParams(), c);
    const nc = (v: string) => /nc=([0-9a-f]{8})/.exec(v)![1];
    expect(Number.parseInt(nc(second.headers[0]!.value), 16)).toBe(Number.parseInt(nc(first.headers[0]!.value), 16) + 1);
    expect((await sendWith(c, second.headers)).body).toMatchObject({ ok: true, nc: nc(second.headers[0]!.value) });

    const direct = ctx({ url: `${server.url}/digest/fixed` }); // no challenge() available
    const d = await digestProvider.apply(digestParams({ realm: 'metrics', nonce: 'fixed-nonce-1', algorithm: 'MD5', qop: 'auth', nonceCount: '0000000a', clientNonce: 'cn-1' }), direct);
    expect(d.notes[0]).toMatch(/no challenge round trip/);
    expect(d.headers[0]!.value).toContain('nc=0000000a');
    expect(d.headers[0]!.value).toContain('cnonce="cn-1"');
    expect((await sendWith(direct, d.headers)).body).toMatchObject({ ok: true, nc: '0000000a' });
  });

  it('fails clearly: wrong password (server 401), Basic-only server, no challenge available, disableRetryRequest without nonce', async () => {
    const c = serverCtx({ url: `${server.url}/digest/md5` });
    const bad = await digestProvider.apply(digestParams({ password: 'wrong' }), c);
    expect((await sendWith(c, bad.headers)).status).toBe(401);
    await expect(digestProvider.apply(digestParams(), serverCtx({ url: `${server.url}/digest/basic` }))).rejects.toThrow(/does not offer Digest.*Basic/);
    await expect(digestProvider.apply(digestParams(), ctx())).rejects.toThrow(/challenge round trip/);
    await expect(digestProvider.apply(digestParams({ disableRetryRequest: true }), c)).rejects.toThrow(/no nonce/);
    await expect(digestProvider.apply({ providerId: 'digest' }, c)).rejects.toThrow(/username/);
    // a server that does not challenge at all: request goes out without credentials
    const open = await digestProvider.apply(digestParams(), serverCtx({ url: `${server.url}/echo` }));
    expect(open.headers).toEqual([]);
    expect(open.notes[0]).toMatch(/without a challenge/);
  });

  it('is reachable through the registry as a Postman custom provider', async () => {
    const r = createDefaultAuthRegistry();
    const out = await r.apply({ type: 'custom', params: digestParams() }, serverCtx({ url: `${server.url}/digest/md5` }));
    expect(out.headers[0]!.value).toMatch(/^Digest /);
    for (const id of EXECUTABLE_CUSTOM_AUTH_PROVIDERS) expect(r.has(id)).toBe(true);
  });
});

// ----------------------------------------------------------------------------- Hawk

describe('Hawk 1.1', () => {
  const README = { id: 'dh37fgj492je', key: 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn', algorithm: 'sha256', ts: 1353832234, nonce: 'j4h3g2', ext: 'some-app-ext-data' };

  it('matches the hawk README protocol example (GET, no payload) and the independent MAC', () => {
    const h = buildHawkHeader({ ...README, method: 'GET', url: 'http://example.com:8000/resource/1?b=1&a=2' });
    expect(h.normalized).toBe('hawk.1.header\n1353832234\nj4h3g2\nGET\n/resource/1?b=1&a=2\nexample.com\n8000\n\nsome-app-ext-data\n');
    expect(h.mac).toBe(createHmac('sha256', README.key).update(h.normalized).digest('base64'));
    expect(h.mac).toBe('6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE=');
    expect(h.value).toBe('Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="');
  });

  it('matches the README payload example (POST with hash) and includes app/dlg', () => {
    const h = buildHawkHeader({ ...README, method: 'POST', url: 'http://example.com:8000/resource/1?b=1&a=2', payload: { contentType: 'text/plain', body: 'Thank you for flying Hawk' } });
    const expectedHash = createHash('sha256').update('hawk.1.payload\ntext/plain\nThank you for flying Hawk\n').digest('base64');
    expect(h.hash).toBe(expectedHash);
    expect(h.hash).toBe('Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=');
    expect(h.mac).toBe('aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw=');

    const oz = buildHawkHeader({ ...README, method: 'GET', url: 'https://example.com/r', app: 'app-1', dlg: 'dlg-1' });
    expect(oz.normalized.endsWith('some-app-ext-data\napp-1\ndlg-1\n')).toBe(true);
    expect(oz.normalized).toContain('\nexample.com\n443\n');
    expect(oz.value).toMatch(/, app="app-1", dlg="dlg-1"$/);
    expect(() => buildHawkHeader({ ...README, algorithm: 'md5', method: 'GET', url: 'https://example.com/' })).toThrow(/Unsupported Hawk algorithm/);
  });

  it('provider: Postman parameter names, fresh nonce/timestamp, verified by the local server (with and without payload hash)', async () => {
    const c = ctx({ url: `${server.url}/hawk/resource?b=1&a=2` });
    const r = await hawkProvider.apply({ providerId: 'hawk', authId: HAWK_ID, authKey: HAWK_KEY, algorithm: 'sha256', extraData: 'ext-1' }, c);
    expect(r.headers[0]!.value).toMatch(/^Hawk id="dh37fgj492je", ts="1700000000", nonce="[A-Za-z0-9_-]{6,}", ext="ext-1", mac="[^"]+"$/);
    expect((await sendWith(c, r.headers)).body).toMatchObject({ ok: true, ext: 'ext-1', hash: null });

    const post = ctx({ method: 'POST', url: `${server.url}/hawk/resource`, headers: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }], body: { kind: 'text', text: '{"x":1}' } });
    const p = await hawkProvider.apply({ providerId: 'hawk', authId: HAWK_ID, authKey: HAWK_KEY, includePayloadHash: true, app: 'oz-app', delegation: 'oz-dlg', timestamp: '1353832234', nonce: 'fixed' }, post);
    expect(p.headers[0]!.value).toContain('ts="1353832234", nonce="fixed", hash="');
    expect((await sendWith(post, p.headers)).body).toMatchObject({ ok: true, app: 'oz-app', dlg: 'oz-dlg' });
    expect(JSON.stringify(p)).not.toContain(HAWK_KEY);

    const wrong = await hawkProvider.apply({ providerId: 'hawk', authId: HAWK_ID, authKey: 'nope' }, c);
    expect((await sendWith(c, wrong.headers)).status).toBe(401);
    expect(() => hawkProvider.apply({ providerId: 'hawk', authId: HAWK_ID }, c)).toThrow(/auth key/);
  });
});

// ----------------------------------------------------------------------------- Akamai EdgeGrid

describe('Akamai EdgeGrid (EG1-HMAC-SHA256)', () => {
  const creds = { clientToken: 'akab-client-token-xxx-xxxxxxxxxxxxxxxx', clientSecret: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=', accessToken: 'akab-access-token-xxx-xxxxxxxxxxxxxxxx' };
  const timestamp = '20140321T19:34:21+0000';
  const nonce = 'nonce-xx-xxxx-xxxxxxxxxxxxxxxx';

  /** Independent, step-by-step implementation of the documented algorithm (loops, no shared helpers). */
  function reference(method: string, url: string, headers: Array<[string, string]>, headersToSign: string[], body: string | undefined, maxBody: number): string {
    const u = new URL(url);
    const authHeader = `EG1-HMAC-SHA256 client_token=${creds.clientToken};access_token=${creds.accessToken};timestamp=${timestamp};nonce=${nonce};`;
    const canonical: string[] = [];
    for (const name of headersToSign) {
      for (const [hn, hv] of headers) {
        if (hn.toLowerCase() === name.toLowerCase()) canonical.push(`${name.toLowerCase()}:${hv.trim().split(/\s+/).join(' ')}`);
      }
    }
    let contentHash = '';
    if (method === 'POST' && body) {
      const raw = Buffer.from(body, 'utf8');
      contentHash = createHash('sha256').update(raw.length > maxBody ? raw.subarray(0, maxBody) : raw).digest('base64');
    }
    const dataToSign = `${method}\t${u.protocol.slice(0, -1)}\t${u.host}\t${u.pathname}${u.search}\t${canonical.join('\t')}\t${contentHash}\t${authHeader}`;
    const signingKey = createHmac('sha256', creds.clientSecret).update(timestamp).digest('base64');
    const signature = createHmac('sha256', signingKey).update(dataToSign).digest('base64');
    return `${authHeader}signature=${signature}`;
  }

  it('signs GET/POST with headers-to-sign and body truncation exactly like the reference implementation', () => {
    const url = 'https://akaa-baseurl-xxxxxxxxxxx-xxxxxxxxxxxxx.luna.akamaiapis.net/testapi/v1/t3?q=1';
    const headers = [
      { name: 'X-Test1', value: '  test-simple-header  ' },
      { name: 'X-Test3', value: 'a   b\tc' },
      { name: 'Content-Type', value: 'application/json' },
    ];
    const get = buildEdgeGridHeader({ ...creds, method: 'GET', url, timestamp, nonce, headers, headersToSign: ['X-Test1', 'X-Test2', 'X-Test3'] });
    expect(get.value).toBe(reference('GET', url, headers.map((h) => [h.name, h.value]), ['X-Test1', 'X-Test2', 'X-Test3'], undefined, 2048));
    // METHOD, scheme, host, path?query, canonical headers (absent X-Test2 skipped, whitespace collapsed), empty content hash, auth header
    expect(get.dataToSign).toBe(`GET\thttps\takaa-baseurl-xxxxxxxxxxx-xxxxxxxxxxxxx.luna.akamaiapis.net\t/testapi/v1/t3?q=1\tx-test1:test-simple-header\tx-test3:a b c\t\tEG1-HMAC-SHA256 client_token=${creds.clientToken};access_token=${creds.accessToken};timestamp=${timestamp};nonce=${nonce};`);

    const body = 'x'.repeat(5000);
    const post = buildEdgeGridHeader({ ...creds, method: 'POST', url, timestamp, nonce, headers, headersToSign: [], body, maxBody: 2048 });
    expect(post.value).toBe(reference('POST', url, [], [], body, 2048));
    expect(post.dataToSign.split('\t')[5]).toBe(createHash('sha256').update('x'.repeat(2048)).digest('base64'));
    // PUT bodies are never hashed
    const put = buildEdgeGridHeader({ ...creds, method: 'PUT', url, timestamp, nonce, headers: [], headersToSign: [], body });
    expect(put.dataToSign.split('\t')[5]).toBe('');
    // host override from the Base URL (as in .edgerc)
    const alt = buildEdgeGridHeader({ ...creds, method: 'GET', url: 'http://127.0.0.1:1/x', baseUrl: 'https://akaa-override.luna.akamaiapis.net/', timestamp, nonce, headers: [], headersToSign: [] });
    expect(alt.dataToSign.split('\t')[2]).toBe('akaa-override.luna.akamaiapis.net');
  });

  it('provider uses Postman parameter names, a UTC timestamp and a UUID nonce', async () => {
    expect(edgeGridTimestamp(new Date('2014-03-21T19:34:21Z'))).toBe('20140321T19:34:21+0000');
    const c = ctx({ method: 'POST', url: 'https://akab-host.luna.akamaiapis.net/papi/v1/x', headers: [{ name: 'X-Sign', value: 'v' }], body: { kind: 'text', text: '{"a":1}' } });
    const r = await edgeGridProvider.apply({ providerId: 'edgegrid', ...creds, headersToSign: 'X-Sign', maxBodySize: '131072' }, c);
    const v = r.headers[0]!.value;
    expect(v).toMatch(/^EG1-HMAC-SHA256 client_token=akab-client-token-xxx-xxxxxxxxxxxxxxxx;access_token=akab-access-token-xxx-xxxxxxxxxxxxxxxx;timestamp=20231114T22:13:20\+0000;nonce=[0-9a-f-]{36};signature=[A-Za-z0-9+/]+=*$/);
    const nonceUsed = /nonce=([^;]+);/.exec(v)![1]!;
    const expected = buildEdgeGridHeader({ ...creds, method: 'POST', url: c.url, timestamp: '20231114T22:13:20+0000', nonce: nonceUsed, headers: c.headers, headersToSign: ['X-Sign'], body: '{"a":1}', maxBody: 131072 });
    expect(v).toBe(expected.value);
    expect(JSON.stringify(r)).not.toContain(creds.clientSecret);
    expect(() => edgeGridProvider.apply({ providerId: 'edgegrid', clientToken: 'a' }, c)).toThrow(/client token, a client secret and an access token/);
  });
});

// ----------------------------------------------------------------------------- ASAP

describe('ASAP (Atlassian S2S)', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  it('builds a token with kid/iss/sub/aud/iat/nbf/exp/jti and an RS256 signature that verifies', () => {
    const t = buildAsapToken({ providerId: 'asap', alg: 'RS256', kid: 'service/key-1', iss: 'my-service', aud: 'api-a, api-b', privateKey: pem, exp: '15m', claims: '{"scope":"read","iss":"ignored"}' }, NOW, 'jti-1');
    expect(t.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'service/key-1' });
    expect(t.claims).toEqual({ scope: 'read', iss: 'my-service', sub: 'my-service', aud: ['api-a', 'api-b'], iat: 1_700_000_000, nbf: 1_700_000_000, exp: 1_700_000_000 + 900, jti: 'jti-1' });
    const d = decodeJwt(t.token);
    expect(d.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'service/key-1' });
    const [h, p, s] = t.token.split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(rsa.publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('accepts a data: URI key, parses expiry strings, caps at 24h, and validates inputs', async () => {
    const der = rsa.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
    const dataUri = `data:application/pkcs8;kid=service%2Fkey-1;base64,${der.toString('base64')}`;
    expect(loadPrivateKey(dataUri).asymmetricKeyType).toBe('rsa');
    const t = buildAsapToken({ providerId: 'asap', kid: 'k', iss: 'i', aud: 'a', sub: 'someone', privateKey: dataUri }, NOW);
    expect(t.claims).toMatchObject({ sub: 'someone', aud: 'a', exp: 1_700_000_000 + 3600 });
    expect(typeof t.claims.jti).toBe('string');
    expect(parseExpiry('90')).toBe(90);
    expect(parseExpiry('2h')).toBe(7200);
    expect(parseExpiry('3d')).toBe(86400);
    expect(() => parseExpiry('soon')).toThrow(/expiry/);
    expect(() => buildAsapToken({ providerId: 'asap', kid: 'k', iss: 'i', privateKey: pem }, NOW)).toThrow(/audience/);
    expect(() => buildAsapToken({ providerId: 'asap', kid: 'k', iss: 'i', aud: 'a', privateKey: 'not a key' }, NOW)).toThrow(/could not be parsed/);
    expect(() => buildAsapToken({ providerId: 'asap', kid: 'k', iss: 'i', aud: 'a', privateKey: pem, claims: '[1]' }, NOW)).toThrow(/JSON object/);
    expect(() => buildAsapToken({ providerId: 'asap', alg: 'HS256', kid: 'k', iss: 'i', aud: 'a', privateKey: pem }, NOW)).toThrow(/Unsupported ASAP algorithm/);
    const r = await asapProvider.apply({ providerId: 'asap', kid: 'k', iss: 'i', aud: 'a', privateKey: pem }, ctx());
    expect(r.headers[0]!.value).toMatch(/^Bearer ey/);
    expect(JSON.stringify(r)).not.toContain('PRIVATE KEY');
  });

  it('signs with ES256 when asked', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const t = buildAsapToken({ providerId: 'asap', alg: 'ES256', kid: 'k', iss: 'i', aud: 'a', privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }, NOW);
    const [h, p, s] = t.token.split('.');
    expect(createVerify('sha256').update(`${h}.${p}`).verify({ key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
  });
});

// ----------------------------------------------------------------------------- JWT ES*/PS*

describe('JWT ES256/ES384/ES512 and PS256/PS384/PS512', () => {
  it('ES signatures are raw R||S and verify with node:crypto; wrong curve or key type is rejected', () => {
    for (const [alg, curve, hash, size] of [
      ['ES256', 'prime256v1', 'sha256', 32],
      ['ES384', 'secp384r1', 'sha384', 48],
      ['ES512', 'secp521r1', 'sha512', 66],
    ] as const) {
      const kp = generateKeyPairSync('ec', { namedCurve: curve });
      const token = signJwt({ algorithm: alg, privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, payload: { sub: 'u', iat: 1 } });
      const [h, p, s] = token.split('.');
      expect(decodeJwt(token).header).toEqual({ alg, typ: 'JWT' });
      expect(Buffer.from(s!, 'base64url')).toHaveLength(size * 2);
      expect(createVerify(hash).update(`${h}.${p}`).verify({ key: kp.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
    }
    const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(() => signJwt({ algorithm: 'ES384', privateKey: p256.privateKey, payload: {} })).toThrow(/secp384r1/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => signJwt({ algorithm: 'ES256', privateKey: rsa.privateKey, payload: {} })).toThrow(/EC private key/);
    expect(() => signJwt({ algorithm: 'RS256', privateKey: p256.privateKey, payload: {} })).toThrow(/RSA private key/);
    expect(() => signJwt({ algorithm: 'ES256', payload: {} })).toThrow(/private key is required/);
  });

  it('PS signatures use PSS padding with a digest-length salt and verify with node:crypto', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    for (const [alg, hash] of [
      ['PS256', 'sha256'],
      ['PS384', 'sha384'],
      ['PS512', 'sha512'],
    ] as const) {
      const token = signJwt({ algorithm: alg, privateKey: pem, payload: { a: 1 } });
      const [h, p, s] = token.split('.');
      const verify = (saltLength: number) => createVerify(hash).update(`${h}.${p}`).verify({ key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength }, Buffer.from(s!, 'base64url'));
      expect(verify(constants.RSA_PSS_SALTLEN_DIGEST)).toBe(true);
      // PKCS#1 v1.5 verification must fail: proves PSS was really used
      expect(createVerify(hash).update(`${h}.${p}`).verify(rsa.publicKey, Buffer.from(s!, 'base64url'))).toBe(false);
    }
  });

  it('provider exposes the new algorithms', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const r = await jwtProvider.apply({ algorithm: 'ES256', privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, payload: '{"x":1}', header: '{"kid":"k1"}' }, ctx());
    expect(decodeJwt(r.headers[0]!.value.slice('Bearer '.length)).header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'k1' });
    expect(() => signJwt({ algorithm: 'XX256', privateKey: ec.privateKey, payload: {} })).toThrow(/Unsupported JWT algorithm "XX256". Supported: HS256, .*PS512/);
  });
});

// ----------------------------------------------------------------------------- OAuth 1.0 RSA

describe('OAuth 1.0 RSA-SHA1 / RSA-SHA256', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const c = ctx({ method: 'POST', url: 'https://photos.example.net/photos?file=vacation.jpg&size=original' });

  it('signs the RFC 5849 base string with the private key; the consumer secret is not needed', () => {
    for (const [method, algo] of [
      ['RSA-SHA1', 'RSA-SHA1'],
      ['RSA-SHA256', 'RSA-SHA256'],
    ] as const) {
      const { signature, baseString, oauth } = oauth1Sign({ consumerKey: 'dpf43f3p2l4k3l03', token: 'nnch734d00sl2jdk', signatureMethod: method, privateKey: pem }, c, { nonce: 'chapoH', timestamp: '137131202' });
      expect(baseString.startsWith('POST&https%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3DchapoH%26oauth_signature_method%3D')).toBe(true);
      expect(oauth.find(([k]) => k === 'oauth_signature_method')![1]).toBe(method);
      expect(createVerify(algo).update(baseString).verify(rsa.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
    }
    expect(() => oauth1Sign({ consumerKey: 'k', signatureMethod: 'RSA-SHA1' }, c)).toThrow(/requires a private key/);
    expect(() => oauth1Sign({ consumerKey: 'k', signatureMethod: 'RSA-SHA1', privateKey: 'garbage' }, c)).toThrow(/could not be parsed/);
  });

  it('provider emits the header with the RSA signature and never the key', async () => {
    const r = await oauth1Provider.apply({ consumerKey: 'k', signatureMethod: 'RSA-SHA256', privateKey: pem, realm: 'Example' }, c);
    const header = r.headers[0]!.value;
    expect(header).toMatch(/^OAuth realm="Example", oauth_consumer_key="k", oauth_signature_method="RSA-SHA256", /);
    const sig = decodeURIComponent(/oauth_signature="([^"]+)"/.exec(header)![1]!);
    const ts = /oauth_timestamp="(\d+)"/.exec(header)![1]!;
    const nonce = /oauth_nonce="([^"]+)"/.exec(header)![1]!;
    const { baseString } = oauth1Sign({ consumerKey: 'k', signatureMethod: 'RSA-SHA256', privateKey: pem }, c, { nonce, timestamp: ts });
    expect(createVerify('RSA-SHA256').update(baseString).verify(rsa.publicKey, Buffer.from(sig, 'base64'))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('PRIVATE KEY');
  });
});

// ----------------------------------------------------------------------------- OAuth 2.0 device flow

describe('OAuth 2.0 device authorization grant (RFC 8628)', () => {
  const params = (over: Record<string, string> = {}) => ({ grant_type: 'device_code', deviceAuthUrl: `${server.url}/device/code`, accessTokenUrl: `${server.url}/device/token`, clientId: 'cid', scope: 'read', ...over });

  it('requests a device code (public client: client_id in the body, no Basic header) and returns what the UI must show', async () => {
    server.resetDevice();
    const d = await startDeviceFlow(params(), serverCtx({ url: server.url }));
    expect(d).toEqual({ deviceCode: 'DC-secret-1', userCode: 'ABCD-EFGH', verificationUri: 'https://idp.test/device', verificationUriComplete: 'https://idp.test/device?user_code=ABCD-EFGH', expiresIn: 600, interval: 1 });
    const req = server.deviceRequests.at(-1)!;
    expect(req.path).toBe('/device/code');
    expect(req.body.get('client_id')).toBe('cid');
    expect(req.body.get('scope')).toBe('read');
    expect(req.authorization).toBeUndefined();
    // confidential client: Basic header as well
    await startDeviceFlow(params({ clientSecret: 'sec' }), serverCtx({ url: server.url }));
    expect(server.deviceRequests.at(-1)!.authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`);
    await expect(startDeviceFlow(params({ clientId: '' }), serverCtx({ url: server.url }))).rejects.toThrow(/client ID/);
    await expect(startDeviceFlow(params({ deviceAuthUrl: '', authUrl: '' }), serverCtx({ url: server.url }))).rejects.toThrow(/device authorization URL/);
  });

  it('polls once: pending keeps the interval, slow_down adds 5 s, then the token arrives', async () => {
    server.resetDevice();
    const c = serverCtx({ url: server.url });
    expect(await pollDeviceTokenOnce(params(), c, 'DC-secret-1', 1)).toEqual({ status: 'pending', interval: 1 });
    expect(await pollDeviceTokenOnce(params(), c, 'DC-secret-1', 1)).toEqual({ status: 'pending', interval: 6 });
    const done = await pollDeviceTokenOnce(params(), c, 'DC-secret-1', 6);
    expect(done.status).toBe('done');
    if (done.status === 'done') expect(done.token).toEqual({ accessToken: DEVICE_TOKEN, refreshToken: 'DEVICE-RT-1', tokenType: 'Bearer', expiresAt: NOW + 3_600_000, scope: 'read' });
    const poll = server.deviceRequests.at(-1)!;
    expect(poll.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(poll.body.get('device_code')).toBe('DC-secret-1');
    expect(poll.body.get('client_id')).toBe('cid');
  });

  it('pollDeviceToken loops with backoff, honours cancellation and expiry, and surfaces denial', async () => {
    server.resetDevice();
    const c = serverCtx({ url: server.url });
    const sleeps: number[] = [];
    const token = await pollDeviceToken(params(), c, { deviceCode: 'DC-secret-1', interval: 1, expiresIn: 600 }, { sleep: async (ms) => void sleeps.push(ms) });
    expect(token.accessToken).toBe(DEVICE_TOKEN);
    expect(sleeps).toEqual([1000, 6000]);

    const ac = new AbortController();
    ac.abort();
    await expect(pollDeviceToken(params(), c, { deviceCode: 'DC-secret-1', interval: 1, expiresIn: 600 }, { signal: ac.signal })).rejects.toThrow(/cancelled/);
    await expect(pollDeviceToken(params(), c, { deviceCode: 'DC-secret-1', interval: 1, expiresIn: -1 })).rejects.toThrow(/expired/);
    await expect(pollDeviceTokenOnce(params({ accessTokenUrl: `${server.url}/device/token-denied` }), c, 'DC-secret-1', 1)).rejects.toThrow(/denied/);
    await expect(pollDeviceTokenOnce(params({ accessTokenUrl: `${server.url}/device/token-expired` }), c, 'DC-secret-1', 1)).rejects.toThrow(/expired/);
    await expect(pollDeviceTokenOnce(params(), c, 'wrong', 1)).rejects.toThrow(/invalid_grant/);
  });

  it('the provider refuses to send without a token for the device grant and uses a stored one', async () => {
    await expect(oauth2Provider.apply(params(), ctx())).rejects.toThrow(/device sign-in/);
    const r = await oauth2Provider.apply({ ...params(), accessToken: 'stored', expiresAt: NOW + 600_000 }, ctx());
    expect(r.headers[0]!.value).toBe('Bearer stored');
  });
});

// ----------------------------------------------------------------------------- secrets

describe('secret parameter catalogue', () => {
  it('lists every credential key of the new providers (vault sealing + export blanking rely on it)', () => {
    expect(AUTH_SECRET_PARAMS.digest).toContain('password');
    expect(AUTH_SECRET_PARAMS.hawk).toContain('authKey');
    expect(AUTH_SECRET_PARAMS.edgegrid).toEqual(expect.arrayContaining(['clientSecret', 'accessToken']));
    expect(AUTH_SECRET_PARAMS.asap).toContain('privateKey');
    expect(AUTH_SECRET_PARAMS.oauth1).toContain('privateKey');
  });
});
