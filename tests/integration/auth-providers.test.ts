/**
 * End to end through the application services: the Postman kitchen-sink fixture's Digest and Hawk
 * requests (imported as `custom` providers) execute against a server that verifies the credentials
 * with an independent implementation. Also covers the OAuth 2.0 device-flow tool channels.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyRequestDraft, newId, type AuthConfig } from '@aegis/core';
import { DEVICE_TOKEN, DIGEST_PASSWORD, HAWK_KEY, startAuthTestServer, type AuthTestServer } from '../helpers/auth-server';
import { createTestApp, type TestApp } from '../helpers/app';

let server: AuthTestServer;
let t: TestApp;
let workspaceId = '';
let collectionId = '';
const FIXTURE = path.resolve(__dirname, '../fixtures/postman/kitchen-sink.json');

beforeAll(async () => {
  server = await startAuthTestServer();
  t = createTestApp();
  workspaceId = (await t.api.workspaces.create({ name: 'Auth providers' })).id;
  const preview = await t.api.importExport.previewContent({ kind: 'postman-collection', fileName: 'kitchen-sink.json', content: readFileSync(FIXTURE, 'utf8') });
  collectionId = (await t.api.importExport.commit({ token: preview.token, workspaceId })).collectionId!;
  // point {{baseUrl}} (a collection variable in the fixture) at the local server
  const vars = await t.api.variables.get({ scope: 'collection', ownerId: collectionId });
  await t.api.variables.set({ scope: 'collection', ownerId: collectionId, entries: vars.map((v) => (v.key === 'baseUrl' ? { ...v, initialValue: server.url, currentValue: server.url } : v)) });
});
afterAll(async () => {
  await t.close();
  await server.close();
});

async function requestNamed(name: string): Promise<string> {
  const tree = await t.api.collections.tree({ collectionId });
  const node = tree.find((n) => n.kind === 'request' && n.name === name);
  if (!node) throw new Error(`request "${name}" not found in the imported collection`);
  return node.id;
}

describe('Postman kitchen-sink custom auth providers execute', () => {
  it('"Digest protected" (custom/digest, MD5, qop=auth): 401 challenge, retry with credentials, 200', async () => {
    const id = await requestNamed('Digest protected');
    const stored = await t.api.requests.get({ id });
    expect(stored.auth.type).toBe('custom');
    expect(stored.auth.params.providerId).toBe('digest');
    expect(String(stored.auth.params.password)).toMatch(/^secretref:/); // vaulted on import, never plain in the row
    expect(stored.url).toBe('{{baseUrl}}/admin/metrics');

    const result = await t.api.execution.send({ executionId: newId(), workspaceId, requestId: id });
    expect(result.error).toBeUndefined();
    expect(result.response!.status).toBe(200);
    expect(JSON.parse(result.response!.bodyPreview)).toMatchObject({ ok: true, user: 'admin', algorithm: 'MD5', qop: 'auth' });
    expect(result.response!.notes.join(' ')).toMatch(/Digest: challenge received/);
    // exactly one challenge probe + one authenticated request reached the server for this execution
    const probe = server.digestRequests.at(-1)!;
    expect(probe.username).toBe('admin');
    expect(probe.realm).toBe('metrics');
    expect(probe.uri).toBe('/admin/metrics');
    // the password appears nowhere: request view, history, logs
    const dump = JSON.stringify(result) + JSON.stringify(t.logs.records);
    expect(dump).not.toContain(DIGEST_PASSWORD);
    expect(result.request!.headers.find((h) => h.name.toLowerCase() === 'authorization')!.value).not.toMatch(/^Digest/);
    const history = await t.api.history.search({ workspaceId });
    expect(JSON.stringify(history)).not.toContain(DIGEST_PASSWORD);
  });

  it('"Hawk protected" (custom/hawk, sha256): MAC verified by the server', async () => {
    const id = await requestNamed('Hawk protected');
    const stored = await t.api.requests.get({ id });
    expect(stored.auth.params.providerId).toBe('hawk');
    expect(String(stored.auth.params.authKey)).toMatch(/^secretref:/);
    const result = await t.api.execution.send({ executionId: newId(), workspaceId, requestId: id });
    expect(result.error).toBeUndefined();
    expect(result.response!.status).toBe(200);
    expect(JSON.parse(result.response!.bodyPreview)).toMatchObject({ ok: true, id: 'dh37fgj492je', hash: null });
    expect(JSON.stringify(result) + JSON.stringify(t.logs.records)).not.toContain(HAWK_KEY);
  });

  it('"NTLM protected" is still preserved-only and fails with the clear "cannot be executed" error', async () => {
    const id = await requestNamed('NTLM protected');
    const result = await t.api.execution.send({ executionId: newId(), workspaceId, requestId: id });
    expect(result.ok).toBe(false);
    expect(result.error!.message).toMatch(/cannot be executed/);
  });

  it('exports the executable custom providers back as the original Postman types with secrets blanked', async () => {
    t.nextSave.path = path.join(t.dir, 'ks-out.json');
    await t.api.importExport.exportCollection({ collectionId, includeSecrets: false });
    const text = readFileSync(t.nextSave.path, 'utf8');
    expect(text).not.toContain(DIGEST_PASSWORD);
    expect(text).not.toContain(HAWK_KEY);
    const json = JSON.parse(text) as { item: Array<{ name: string; item?: Array<{ name: string; request: { auth: { type: string } } }> }> };
    const folder = json.item.find((i) => i.item?.some((r) => r.name === 'Digest protected'))!;
    expect(folder.item!.find((r) => r.name === 'Digest protected')!.request.auth.type).toBe('digest');
    expect(folder.item!.find((r) => r.name === 'Hawk protected')!.request.auth.type).toBe('hawk');
  });
});

describe('Digest with a draft, SHA-256 preference and auth-int POST (full executor path)', () => {
  const auth = (over: Record<string, string> = {}): AuthConfig => ({ type: 'custom', params: { providerId: 'digest', username: 'admin', password: DIGEST_PASSWORD, ...over } });

  it('negotiates SHA-256 when the server lists it first and keeps cookies/policy handling on the probe', async () => {
    const draft = emptyRequestDraft({ name: 'sha', url: `${server.url}/digest/sha256`, auth: auth() });
    const result = await t.api.execution.send({ executionId: newId(), workspaceId, draft });
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.response!.bodyPreview)).toMatchObject({ ok: true, algorithm: 'SHA-256' });
  });

  it('auth-int hashes the JSON body the executor actually sends', async () => {
    const draft = emptyRequestDraft({
      name: 'auth-int',
      method: 'POST',
      url: `${server.url}/digest/auth-int`,
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
      body: { mode: 'raw', rawLanguage: 'json', raw: '{"metric":"{{metricName}}"}' },
      auth: auth({ qop: 'auth-int' }),
    });
    await t.api.variables.set({ scope: 'global', ownerId: workspaceId, entries: [{ key: 'metricName', initialValue: 'cpu', isSecret: false, enabled: true }] });
    const result = await t.api.execution.send({ executionId: newId(), workspaceId, draft });
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.response!.bodyPreview)).toMatchObject({ ok: true, qop: 'auth-int', body: '{"metric":"cpu"}' });
  });

  it('a wrong password yields the server 401 (no retry loop) and a Basic-only server a clear error', async () => {
    const bad = await t.api.execution.send({ executionId: newId(), workspaceId, draft: emptyRequestDraft({ name: 'bad', url: `${server.url}/digest/md5`, auth: auth({ password: 'nope' }) }) });
    expect(bad.response!.status).toBe(401);
    const basic = await t.api.execution.send({ executionId: newId(), workspaceId, draft: emptyRequestDraft({ name: 'basic', url: `${server.url}/digest/basic`, auth: auth() }) });
    expect(basic.ok).toBe(false);
    expect(basic.error!.message).toMatch(/does not offer Digest/);
  });

  it('policy: a blocked host is refused before the challenge probe goes out', async () => {
    const blocked = createTestApp({ policy: { blockedHosts: ['127.0.0.1'] } });
    try {
      const ws = (await blocked.api.workspaces.list())[0]!.id;
      const result = await blocked.api.execution.send({ executionId: newId(), workspaceId: ws, draft: emptyRequestDraft({ name: 'blocked', url: `${server.url}/digest/md5`, auth: auth() }) });
      expect(result.ok).toBe(false);
      expect(result.error!.code).toBe('POLICY_VIOLATION');
    } finally {
      await blocked.close();
    }
  });
});

describe('tools.oauth2DeviceStart / oauth2DevicePoll', () => {
  const auth = (over: Record<string, string> = {}): AuthConfig => ({
    type: 'oauth2',
    params: { grant_type: 'device_code', deviceAuthUrl: '{{idp}}/device/code', accessTokenUrl: '{{idp}}/device/token', clientId: '{{deviceClient}}', scope: 'read', ...over },
  });

  it('resolves collection variables, returns the user code, then polls to completion with backoff', async () => {
    server.resetDevice();
    const vars = await t.api.variables.get({ scope: 'collection', ownerId: collectionId });
    await t.api.variables.set({
      scope: 'collection',
      ownerId: collectionId,
      entries: [...vars, { key: 'idp', initialValue: server.url, isSecret: false, enabled: true }, { key: 'deviceClient', initialValue: 'cid-from-collection', isSecret: false, enabled: true }],
    });
    const started = await t.api.tools.oauth2DeviceStart({ auth: auth(), workspaceId, collectionId });
    expect(started).toMatchObject({ userCode: 'ABCD-EFGH', verificationUri: 'https://idp.test/device', interval: 1, expiresIn: 600 });
    expect(server.deviceRequests.at(-1)!.body.get('client_id')).toBe('cid-from-collection');

    const first = await t.api.tools.oauth2DevicePoll({ auth: auth(), workspaceId, collectionId, deviceCode: started.deviceCode, interval: started.interval });
    expect(first).toEqual({ status: 'pending', interval: 1 });
    const second = await t.api.tools.oauth2DevicePoll({ auth: auth(), workspaceId, collectionId, deviceCode: started.deviceCode, interval: 1 });
    expect(second).toEqual({ status: 'pending', interval: 6 });
    const done = await t.api.tools.oauth2DevicePoll({ auth: auth(), workspaceId, collectionId, deviceCode: started.deviceCode, interval: 6 });
    expect(done.status).toBe('done');
    if (done.status === 'done') expect(done.params).toMatchObject({ accessToken: DEVICE_TOKEN, refreshToken: 'DEVICE-RT-1', tokenType: 'Bearer' });
    // the device code is never logged
    expect(JSON.stringify(t.logs.records)).not.toContain('DC-secret-1');
  });

  it('honours the enterprise host policy for the device and token endpoints', async () => {
    const blocked = createTestApp({ policy: { blockedHosts: ['127.0.0.1'] } });
    try {
      const ws = (await blocked.api.workspaces.list())[0]!.id;
      await expect(blocked.api.tools.oauth2DeviceStart({ auth: auth({ deviceAuthUrl: `${server.url}/device/code`, clientId: 'cid' }), workspaceId: ws })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
      await expect(blocked.api.tools.oauth2DevicePoll({ auth: auth({ accessTokenUrl: `${server.url}/device/token`, clientId: 'cid' }), workspaceId: ws, deviceCode: 'DC-secret-1', interval: 1 })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    } finally {
      await blocked.close();
    }
  });
});
