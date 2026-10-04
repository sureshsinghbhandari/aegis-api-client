import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyRequestDraft, newId, type ExecutionResult } from '@aegis/core';
import { compareCollectionBundles, parsePostmanCollection, validatePostmanV21Structure } from '@aegis/postman';
import { startServer, type TestServer } from '../helpers/http-server';
import { createTestApp, type TestApp } from '../helpers/app';

let server: TestServer;
let t: TestApp;
const FIXTURES = path.resolve(__dirname, '../fixtures/postman');

beforeAll(async () => {
  server = await startServer();
  t = createTestApp();
});
afterAll(async () => {
  await t.close();
  await server.close();
});

describe('acceptance workflow (services level, real HTTP)', () => {
  let workspaceId = '';
  let collectionId = '';
  let folderId = '';
  let envId = '';
  let requestId = '';
  let firstHistoryId = '';

  it('creates workspace, collection, folder and environment with baseUrl + secret token', async () => {
    const ws = await t.api.workspaces.create({ name: 'Team A' });
    workspaceId = ws.id;
    collectionId = (await t.api.collections.create({ workspaceId, name: 'Users API' })).id;
    folderId = (await t.api.folders.create({ collectionId, parentFolderId: null, name: 'Users' })).id;
    const env = await t.api.environments.create({ workspaceId, name: 'Development' });
    envId = env.id;
    await t.api.variables.set({
      scope: 'environment',
      ownerId: envId,
      entries: [
        { key: 'baseUrl', initialValue: server.url, isSecret: false, enabled: true },
        { key: 'token', initialValue: 'tok-secret-abc123', isSecret: true, enabled: true },
      ],
    });
    await t.api.environments.setActive({ workspaceId, id: envId });
    // secret is masked on read
    const vars = await t.api.variables.get({ scope: 'environment', ownerId: envId });
    expect(vars[1]!.initialValue).toMatch(/^secretref:/);
    expect(JSON.stringify(vars)).not.toContain('tok-secret-abc123');
  });

  it('sends GET {{baseUrl}}/echo with Bearer {{token}} and shows status, body, size, duration, headers', async () => {
    const draft = emptyRequestDraft({
      name: 'List users',
      url: '{{baseUrl}}/echo',
      queryParams: [{ key: 'page', value: '2', enabled: true }],
      headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }, { key: 'X-Disabled', value: 'no', enabled: false }],
    });
    const result = await t.api.execution.send({ executionId: newId(), workspaceId, draft, collectionId, folderId });
    expect(result.ok).toBe(true);
    const res = result.response!;
    expect(res.status).toBe(200);
    expect(res.size).toBeGreaterThan(0);
    expect(res.timings.totalMs).toBeGreaterThanOrEqual(0);
    const echoed = JSON.parse(res.bodyPreview);
    expect(echoed.path).toBe('/echo?page=2');
    expect(echoed.headers.authorization).toBe('Bearer tok-secret-abc123'); // variable resolved at send time
    expect(echoed.headers['x-disabled']).toBeUndefined();
    // the redacted request view never contains the secret
    expect(JSON.stringify(result.request)).not.toContain('tok-secret-abc123');
    expect(result.unresolvedVariables).toEqual([]);
  });

  it('saves the request, reopens it and variables still work; records history; replays from history', async () => {
    const draft = emptyRequestDraft({
      name: 'List users',
      url: '{{baseUrl}}/echo',
      headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
    });
    requestId = (await t.api.requests.create({ collectionId, folderId, draft })).id;
    const reopened = await t.api.requests.get({ id: requestId });
    expect(reopened.url).toBe('{{baseUrl}}/echo'); // stored URL is never overwritten by resolution

    const result = await t.api.execution.send({ executionId: newId(), workspaceId, requestId });
    expect(result.response!.status).toBe(200);
    expect(JSON.parse(result.response!.bodyPreview).headers.authorization).toBe('Bearer tok-secret-abc123');

    const history = await t.api.history.search({ workspaceId });
    expect(history.total).toBeGreaterThanOrEqual(2);
    const entry = history.items.find((h) => h.requestId === requestId)!;
    firstHistoryId = entry.id;
    expect(entry.url).toBe(`${server.url}/echo`);
    expect(entry.statusCode).toBe(200);
    expect(entry.environmentName).toBe('Development');

    const replay = await t.api.history.replay({ id: firstHistoryId, executionId: newId() });
    expect(replay.ok).toBe(true);
    expect(replay.response!.status).toBe(200);

    // privacy default: request/response bodies and the token are not stored in history
    const stored = await t.api.history.get({ id: firstHistoryId });
    expect(JSON.stringify(stored)).not.toContain('tok-secret-abc123');
  });

  it('runs pre-request + post-response scripts, tests and sets an environment variable from the response', async () => {
    const draft = emptyRequestDraft({
      name: 'Scripted',
      method: 'POST',
      url: '{{baseUrl}}/echo',
      body: { mode: 'raw', rawLanguage: 'json', raw: '{"ts":"{{stamp}}","who":"aegis"}' },
      scripts: [
        { type: 'prerequest', language: 'javascript', enabled: true, source: 'pm.variables.set("stamp", "pre-" + (1 + 1));' },
        {
          type: 'test',
          language: 'javascript',
          enabled: true,
          source: [
            'pm.test("Status is 200", function () { pm.response.to.have.status(200); });',
            'const json = pm.response.json();',
            'pm.test("echoed body", () => { pm.expect(JSON.parse(json.body).ts).to.equal("pre-2"); });',
            'pm.test("deliberate failure", () => { pm.expect(1).to.equal(2); });',
            'pm.environment.set("lastMethod", json.method);',
            'console.log("token is", pm.environment.get("token"));',
          ].join('\n'),
        },
      ],
    });
    const result: ExecutionResult = await t.api.execution.send({ executionId: newId(), workspaceId, draft, collectionId });
    expect(result.ok).toBe(true);
    expect(result.tests.map((x) => [x.name, x.passed])).toEqual([
      ['Status is 200', true],
      ['echoed body', true],
      ['deliberate failure', false],
    ]);
    expect(result.tests[2]!.error).toBeTruthy();
    // console output is redacted for secret variable values
    const log = result.console.map((c) => c.message).join('\n');
    expect(log).toContain('token is');
    expect(log).not.toContain('tok-secret-abc123');
    // environment variable persisted from the response
    expect(result.variableChanges.environment?.set).toContain('lastMethod');
    const env = await t.api.variables.get({ scope: 'environment', ownerId: envId });
    expect(env.find((v) => v.key === 'lastMethod')?.currentValue).toBe('POST');
  });

  it('exports valid Postman v2.1 without secrets, and re-imports it into a new workspace', async () => {
    // give the collection folder-level + request-level auth with a literal secret to prove it is not exported
    await t.api.collections.update({ id: collectionId, auth: { type: 'bearer', params: { token: 'literal-collection-secret' } } });
    await t.api.requests.save({
      id: requestId,
      draft: {
        ...(await t.api.requests.get({ id: requestId })),
        scripts: [{ type: 'test', language: 'javascript', enabled: true, source: 'pm.test("ok", () => pm.response.to.have.status(200));' }],
      },
    });

    t.nextSave.path = path.join(t.dir, 'users.postman_collection.json');
    const target = await t.api.importExport.exportCollection({ collectionId, includeSecrets: false });
    expect(target).toBe(t.nextSave.path);
    const text = readFileSync(target!, 'utf8');
    expect(text).not.toContain('literal-collection-secret');
    const json = JSON.parse(text);
    expect(validatePostmanV21Structure(json)).toEqual([]);
    expect(json.info.schema).toContain('v2.1.0');

    const ws2 = await t.api.workspaces.create({ name: 'Imported' });
    const preview = await t.api.importExport.previewContent({ kind: 'postman-collection', fileName: 'users.json', content: text });
    expect(preview.stats.requests).toBeGreaterThanOrEqual(1);
    expect(preview.stats.folders).toBe(1);
    const committed = await t.api.importExport.commit({ token: preview.token, workspaceId: ws2.id });
    expect(committed.collectionId).toBeTruthy();
    const tree = await t.api.collections.tree({ collectionId: committed.collectionId! });
    expect(tree.filter((n) => n.kind === 'folder')).toHaveLength(1);
    expect(tree.filter((n) => n.kind === 'request').length).toBe(1);

    // semantic round trip: export the imported collection again and compare
    t.nextSave.path = path.join(t.dir, 'again.json');
    await t.api.importExport.exportCollection({ collectionId: committed.collectionId!, includeSecrets: false });
    const a = parsePostmanCollection(text).bundle;
    const b = parsePostmanCollection(readFileSync(t.nextSave.path, 'utf8')).bundle;
    expect(compareCollectionBundles(a, b)).toEqual([]);
  });

  it('imports an independently exported Postman collection + environment, activates it and executes its requests', async () => {
    // A "foreign" collection (hand written like a Postman export) that targets the local server via {{baseUrl}}
    const foreign = {
      info: { _postman_id: '3b0c8e4e-0000-4000-8000-000000000001', name: 'Foreign API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Api-Key', type: 'string' }, { key: 'value', value: '{{apiKey}}', type: 'string' }, { key: 'in', value: 'header', type: 'string' }] },
      event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ['pm.collectionVariables.set("greeting", "hello");'] } }],
      item: [
        {
          name: 'Folder',
          item: [
            {
              name: 'Echo POST',
              event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("has key", () => {', '  pm.expect(pm.response.json().headers["x-api-key"]).to.equal(pm.environment.get("apiKey"));', '});', 'pm.test("greeting", () => pm.expect(pm.collectionVariables.get("greeting")).to.equal("hello"));'] } }],
              request: {
                method: 'POST',
                header: [{ key: 'Content-Type', value: 'application/json' }],
                body: { mode: 'raw', raw: '{"g":"{{greeting}}"}', options: { raw: { language: 'json' } } },
                url: { raw: '{{baseUrl}}/echo?x=1', host: ['{{baseUrl}}'], path: ['echo'], query: [{ key: 'x', value: '1' }] },
              },
            },
          ],
        },
      ],
    };
    const env = {
      id: 'e1',
      name: 'Foreign Env',
      values: [
        { key: 'baseUrl', value: server.url, type: 'default', enabled: true },
        { key: 'apiKey', value: 'k-123456', type: 'secret', enabled: true },
      ],
      _postman_variable_scope: 'environment',
    };
    const ws = await t.api.workspaces.create({ name: 'Foreign' });
    const cPrev = await t.api.importExport.previewContent({ kind: 'postman-collection', fileName: 'foreign.json', content: JSON.stringify(foreign) });
    const cDone = await t.api.importExport.commit({ token: cPrev.token, workspaceId: ws.id });
    const ePrev = await t.api.importExport.previewContent({ kind: 'postman-environment', fileName: 'env.json', content: JSON.stringify(env) });
    const eDone = await t.api.importExport.commit({ token: ePrev.token, workspaceId: ws.id });
    await t.api.environments.setActive({ workspaceId: ws.id, id: eDone.environmentId! });

    const tree = await t.api.collections.tree({ collectionId: cDone.collectionId! });
    const req = tree.find((n) => n.kind === 'request')!;
    const result = await t.api.execution.send({ executionId: newId(), workspaceId: ws.id, requestId: req.id });
    expect(result.error).toBeUndefined();
    expect(result.response!.status).toBe(200);
    const echoed = JSON.parse(result.response!.bodyPreview);
    expect(echoed.headers['x-api-key']).toBe('k-123456'); // inherited collection API-key auth with env secret
    expect(JSON.parse(echoed.body)).toEqual({ g: 'hello' }); // collection pre-request script variable
    expect(result.tests.every((x) => x.passed)).toBe(true);
    expect(result.tests).toHaveLength(2);

    // environment export: secrets are excluded unless explicitly requested
    t.nextSave.path = path.join(t.dir, 'env-out.json');
    await t.api.importExport.exportEnvironment({ environmentId: eDone.environmentId!, includeSecrets: false });
    expect(readFileSync(t.nextSave.path, 'utf8')).not.toContain('k-123456');
  });

  it('collection runner executes requests, iterations with CSV data, and reports pass/fail', async () => {
    const ws = await t.api.workspaces.create({ name: 'Runner' });
    const col = await t.api.collections.create({ workspaceId: ws.id, name: 'Run me' });
    const env = await t.api.environments.create({ workspaceId: ws.id, name: 'E' });
    await t.api.variables.set({ scope: 'environment', ownerId: env.id, entries: [{ key: 'baseUrl', initialValue: server.url, isSecret: false, enabled: true }] });
    await t.api.environments.setActive({ workspaceId: ws.id, id: env.id });
    const mk = (name: string, url: string, test: string) =>
      t.api.requests.create({ collectionId: col.id, folderId: null, draft: emptyRequestDraft({ name, url, scripts: [{ type: 'test', language: 'javascript', enabled: true, source: test }] }) });
    await mk('Echo user', '{{baseUrl}}/echo?u={{username}}', 'pm.test("user echoed", () => pm.expect(pm.response.json().path).to.include("u=" + pm.iterationData.get("username")));');
    await mk('Not found', '{{baseUrl}}/status/404', 'pm.test("is 200", () => pm.response.to.have.status(200));');

    const { runId } = await t.api.runner.start({
      workspaceId: ws.id,
      collectionId: col.id,
      iterations: 2,
      delayMs: 0,
      stopOnFailure: false,
      dataFile: { name: 'users.csv', content: 'username\nalice\nbob\n' },
    });
    for (let i = 0; i < 100 && !t.events.some((e) => e.channel === 'runner:done' && (e.payload as { runId: string }).runId === runId); i++) await new Promise((r) => setTimeout(r, 100));
    const done = t.events.find((e) => e.channel === 'runner:done' && (e.payload as { runId: string }).runId === runId)!.payload as { status: string; totalRequests: number; passedTests: number; failedTests: number };
    expect(done.status).toBe('completed');
    expect(done.totalRequests).toBe(4);
    expect(done.passedTests).toBe(2);
    expect(done.failedTests).toBe(2);
    const items = await t.api.runner.items({ runId });
    expect(items.map((i) => [i.name, i.statusCode, i.passed])).toEqual([
      ['Echo user', 200, true],
      ['Not found', 404, false],
      ['Echo user', 200, true],
      ['Not found', 404, false],
    ]);
    expect(items[2]!.url).toContain('u=bob');
  });

  it('stop-on-failure ends the run early', async () => {
    const ws = (await t.api.workspaces.list()).find((w) => w.name === 'Runner')!;
    const col = (await t.api.collections.list({ workspaceId: ws.id }))[0]!;
    const { runId } = await t.api.runner.start({ workspaceId: ws.id, collectionId: col.id, iterations: 1, delayMs: 0, stopOnFailure: true });
    for (let i = 0; i < 100 && !t.events.some((e) => e.channel === 'runner:done' && (e.payload as { runId: string }).runId === runId); i++) await new Promise((r) => setTimeout(r, 100));
    const done = t.events.find((e) => e.channel === 'runner:done' && (e.payload as { runId: string }).runId === runId)!.payload as { status: string; totalRequests: number };
    expect(done.status).toBe('stopped');
    // without a data file the first request's assertion (username) already fails, so the run stops after it
    expect(done.totalRequests).toBe(1);
  });

  it('audit log recorded key actions without secret values', async () => {
    const entries = await t.api.audit.list({ limit: 500 });
    const actions = new Set(entries.map((e) => e.action));
    for (const a of ['EXECUTE_REQUEST', 'EXPORT_COLLECTION', 'IMPORT_COLLECTION', 'CHANGE_ENVIRONMENT', 'CREATE_COLLECTION']) expect(actions.has(a)).toBe(true);
    const dump = JSON.stringify(entries);
    for (const s of ['tok-secret-abc123', 'k-123456', 'literal-collection-secret']) expect(dump).not.toContain(s);
  });

  it('all logs are free of secrets', () => {
    const dump = JSON.stringify(t.logs.records);
    for (const s of ['tok-secret-abc123', 'k-123456', 'literal-collection-secret']) expect(dump).not.toContain(s);
  });
});

describe('writes a fixture file helper sanity', () => {
  it('fixture directory is readable', () => {
    writeFileSync(path.join(t.dir, 'probe.txt'), 'x');
    expect(readFileSync(path.join(FIXTURES, 'get-simple.json'), 'utf8')).toContain('info');
  });
});
