import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthRegistry,
  awsV4Provider,
  basicProvider,
  bearerProvider,
  apiKeyProvider,
  createDefaultAuthRegistry,
  decodeJwt,
  generatePkce,
  jwtProvider,
  oauth1Sign,
  oauth2Provider,
  resolveEffectiveAuth,
  signAwsV4,
  signJwt,
  buildAuthorizationUrl,
  type AuthContext,
} from '@aegis/authentication';
import type { AuthConfig } from '@aegis/core';
import { createHash } from 'node:crypto';

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  method: 'GET',
  url: 'https://api.test/x',
  headers: [],
  body: { kind: 'none' },
  now: () => 1_700_000_000_000,
  send: async () => {
    throw new Error('no network');
  },
  ...over,
});

describe('simple providers', () => {
  it('basic (UTF-8), bearer and API key (header + query)', async () => {
    expect((await basicProvider.apply({ username: 'user', password: 'pä:ss' }, ctx())).headers[0]!.value).toBe(`Basic ${Buffer.from('user:pä:ss').toString('base64')}`);
    expect((await bearerProvider.apply({ token: ' abc ' }, ctx())).headers).toEqual([{ name: 'Authorization', value: 'Bearer abc' }]);
    expect(await bearerProvider.apply({ token: '' }, ctx())).toMatchObject({ headers: [] });
    expect((await apiKeyProvider.apply({ key: 'X-Key', value: 'v', in: 'header' }, ctx())).headers).toEqual([{ name: 'X-Key', value: 'v' }]);
    expect((await apiKeyProvider.apply({ key: 'api_key', value: 'v', in: 'query' }, ctx())).query).toEqual([{ name: 'api_key', value: 'v' }]);
  });
});

describe('inheritance: request > folder (innermost first) > collection', () => {
  const bearer = (t: string): AuthConfig => ({ type: 'bearer', params: { token: t } });
  const inherit: AuthConfig = { type: 'inherit', params: {} };
  it('picks the nearest explicit level', () => {
    const folders = [{ auth: inherit, folderId: 'f2', name: 'inner' }, { auth: bearer('F1'), folderId: 'f1', name: 'outer' }];
    expect(resolveEffectiveAuth(bearer('REQ'), folders, bearer('COL')).auth.params.token).toBe('REQ');
    expect(resolveEffectiveAuth(inherit, folders, bearer('COL'))).toMatchObject({ auth: bearer('F1'), source: { level: 'folder', name: 'outer' } });
    expect(resolveEffectiveAuth(inherit, [{ auth: inherit }], bearer('COL')).source.level).toBe('collection');
    expect(resolveEffectiveAuth(inherit, [], inherit).auth.type).toBe('none');
  });
  it('an explicit "none" stops inheritance', () => {
    expect(resolveEffectiveAuth({ type: 'none', params: {} }, [], bearer('COL')).auth.type).toBe('none');
  });
});

describe('JWT', () => {
  it('matches the jwt.io HS256 reference token', () => {
    const token = signJwt({ algorithm: 'HS256', secret: 'your-256-bit-secret', payload: { sub: '1234567890', name: 'John Doe', iat: 1516239022 } });
    expect(token).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
  });
  it('decodes without verifying and flags expiry', () => {
    const t = signJwt({ algorithm: 'HS256', secret: 's', payload: { exp: 100 } });
    expect(decodeJwt(t, 200)).toMatchObject({ payload: { exp: 100 }, expired: true, expiresAt: 100 });
    expect(() => decodeJwt('nope')).toThrow();
  });
  it('rejects unknown algorithms and invalid payloads; provider adds header or query', async () => {
    expect(() => signJwt({ algorithm: 'none', payload: {} })).toThrow(/Unsupported JWT algorithm/);
    expect(() => jwtProvider.apply({ algorithm: 'HS256', secret: 's', payload: '{bad' }, ctx())).toThrow(/valid JSON/);
    const h = await jwtProvider.apply({ algorithm: 'HS256', secret: 's', payload: '{"a":1}' }, ctx());
    expect(h.headers[0]!.value).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const q = await jwtProvider.apply({ algorithm: 'HS256', secret: 's', payload: '{"a":1}', addTokenTo: 'queryParams', queryParamKey: 'jwt' }, ctx());
    expect(q.query[0]!.name).toBe('jwt');
  });
});

describe('OAuth 1.0 (published test vector)', () => {
  it('reproduces the documented HMAC-SHA1 signature', () => {
    const { signature } = oauth1Sign(
      {
        consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
        consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
        token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
        signatureMethod: 'HMAC-SHA1',
      },
      ctx({
        method: 'POST',
        url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
        body: { kind: 'urlencoded', entries: [{ name: 'status', value: 'Hello Ladies + Gentlemen, a signed OAuth request!' }] },
      }),
      { nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: '1318622958' },
    );
    expect(signature).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });
});

describe('AWS Signature V4 (AWS test-suite "get-vanilla")', () => {
  it('reproduces the documented signature', () => {
    const out = signAwsV4(
      { accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', date: new Date('2015-08-30T12:36:00Z') },
      ctx({ url: 'https://example.amazonaws.com/' }),
    );
    expect(out.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(out.headers.find((h) => h.name === 'Authorization')!.value).toContain('Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date');
    expect(out.canonicalRequest.split('\n').pop()).toBe(createHash('sha256').update('').digest('hex'));
  });
  it('requires credentials', () => {
    expect(() => awsV4Provider.apply({ accessKey: '', secretKey: '' }, ctx())).toThrow(/access key/);
  });
});

describe('OAuth 2.0', () => {
  let server: ReturnType<typeof createServer>;
  let base = '';
  const hits: Array<{ body: string; auth?: string }> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        hits.push({ body, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
        res.setHeader('Content-Type', 'application/json');
        if (new URLSearchParams(body).get('client_secret') === 'bad') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'invalid_client', error_description: 'bad secret' }));
          return;
        }
        res.end(JSON.stringify({ access_token: 'AT-1', refresh_token: 'RT-1', token_type: 'Bearer', expires_in: 3600 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const send: AuthContext['send'] = async (req) => {
    const res = await fetch(req.url, { method: req.method, headers: Object.fromEntries(req.headers.map((h) => [h.name, h.value])), body: req.body });
    return { status: res.status, bodyText: await res.text() };
  };

  it('client credentials: fetches a token (Basic client auth by default) and returns params to persist', async () => {
    const result = await oauth2Provider.apply({ grant_type: 'client_credentials', accessTokenUrl: `${base}/token`, clientId: 'cid', clientSecret: 'sec', scope: 'read' }, ctx({ send }));
    expect(result.headers[0]).toEqual({ name: 'Authorization', value: 'Bearer AT-1' });
    expect(result.updatedParams).toMatchObject({ accessToken: 'AT-1', refreshToken: 'RT-1' });
    expect(result.updatedParams!.expiresAt).toBe(1_700_000_000_000 + 3_600_000);
    const hit = hits.at(-1)!;
    expect(hit.auth).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`);
    expect(new URLSearchParams(hit.body).get('grant_type')).toBe('client_credentials');
    expect(new URLSearchParams(hit.body).get('scope')).toBe('read');
  });
  it('sends credentials in the body when configured, reuses a valid token, refreshes an expired one', async () => {
    await oauth2Provider.apply({ grant_type: 'client_credentials', accessTokenUrl: `${base}/token`, clientId: 'cid', clientSecret: 'sec', client_authentication: 'body' }, ctx({ send }));
    expect(new URLSearchParams(hits.at(-1)!.body).get('client_secret')).toBe('sec');

    const before = hits.length;
    const reuse = await oauth2Provider.apply({ grant_type: 'client_credentials', accessToken: 'KEEP', expiresAt: 1_700_000_000_000 + 600_000 }, ctx({ send }));
    expect(reuse.headers[0]!.value).toBe('Bearer KEEP');
    expect(reuse.updatedParams).toBeUndefined();
    expect(hits.length).toBe(before);

    const refreshed = await oauth2Provider.apply({ grant_type: 'authorization_code_with_pkce', accessToken: 'OLD', expiresAt: 1, refreshToken: 'RT-0', accessTokenUrl: `${base}/token`, clientId: 'cid' }, ctx({ send }));
    expect(new URLSearchParams(hits.at(-1)!.body).get('grant_type')).toBe('refresh_token');
    expect(refreshed.headers[0]!.value).toBe('Bearer AT-1');
  });
  it('surfaces token endpoint errors and demands a token for interactive grants', async () => {
    await expect(oauth2Provider.apply({ grant_type: 'client_credentials', accessTokenUrl: `${base}/token`, clientSecret: 'bad', client_authentication: 'body' }, ctx({ send }))).rejects.toThrow(/bad secret/);
    await expect(oauth2Provider.apply({ grant_type: 'authorization_code_with_pkce' }, ctx())).rejects.toThrow(/Get New Access Token/);
  });
  it('PKCE: S256 challenge matches the verifier; authorization URL carries state + challenge', () => {
    const p = generatePkce();
    expect(p.challenge).toBe(createHash('sha256').update(p.verifier).digest('base64url'));
    const url = new URL(buildAuthorizationUrl({ authUrl: 'https://idp.test/auth', clientId: 'c', redirect_uri: 'https://app/cb', scope: 'a b' }, p, 'STATE'));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('STATE');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('registry', () => {
  it('rejects unknown and non-executable (preserved) types with a clear error', async () => {
    const r = createDefaultAuthRegistry();
    await expect(r.apply({ type: 'custom', params: { providerId: 'digest' } }, ctx())).rejects.toThrow(/cannot be executed/);
    await expect(new AuthRegistry().apply({ type: 'bearer', params: {} }, ctx())).rejects.toThrow(/Unknown authentication type/);
    r.register({ type: 'my-sso', apply: () => ({ headers: [{ name: 'X-SSO', value: '1' }], query: [], notes: [] }) });
    expect((await r.apply({ type: 'custom', params: { providerId: 'my-sso' } }, ctx())).headers[0]!.name).toBe('X-SSO');
  });
});
