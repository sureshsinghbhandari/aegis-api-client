import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyRequestDraft, type RunnerItemEvent } from '@aegis/core';
import { startServer, type TestServer } from '../helpers/http-server';
import { createTestApp, type TestApp } from '../helpers/app';

let server: TestServer;
let t: TestApp;
let wsId = '';
let colId = '';
const ids: Record<string, string> = {};
const TOKEN = 'runner-secret-token-xyz';

async function waitForDone(runId: string): Promise<{ status: string; totalRequests: number; passedTests: number; failedTests: number }> {
  for (let i = 0; i < 200; i++) {
    const ev = t.events.find((e) => e.channel === 'runner:done' && (e.payload as { runId: string }).runId === runId);
    if (ev) return ev.payload as never;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not finish');
}

beforeAll(async () => {
  server = await startServer();
  t = createTestApp();
  wsId = (await t.api.workspaces.list())[0]!.id;
  colId = (await t.api.collections.create({ workspaceId: wsId, name: 'Runner options' })).id;
  const env = await t.api.environments.create({ workspaceId: wsId, name: 'E' });
  await t.api.variables.set({ scope: 'environment', ownerId: env.id, entries: [{ key: 'baseUrl', initialValue: server.url, isSecret: false, enabled: true }, { key: 'token', initialValue: TOKEN, isSecret: true, enabled: true }] });
  await t.api.environments.setActive({ workspaceId: wsId, id: env.id });
  const folder = await t.api.folders.create({ collectionId: colId, parentFolderId: null, name: 'Sub' });
  const mk = async (name: string, url: string, folderId: string | null, scripts: Array<{ type: 'prerequest' | 'test'; source: string }> = [], headers: Array<{ key: string; value: string }> = []) => {
    const r = await t.api.requests.create({
      collectionId: colId,
      folderId,
      draft: emptyRequestDraft({ name, url, headers: headers.map((h) => ({ ...h, enabled: true })), scripts: scripts.map((s) => ({ ...s, language: 'javascript' as const, enabled: true })) }),
    });
    ids[name] = r.id;
  };
  await mk('A', '{{baseUrl}}/echo?step=a', null, [{ type: 'prerequest', source: 'pm.variables.set("counter", String(Number(pm.variables.get("counter") || "0") + 1)); pm.variables.set("seenA", "yes");' }, { type: 'test', source: 'pm.test("counter " + pm.variables.get("counter"), () => {});' }], [{ key: 'Authorization', value: 'Bearer {{token}}' }, { key: 'X-Plain', value: 'visible' }]);
  await mk('B', '{{baseUrl}}/echo?step=b', folder.id, [{ type: 'test', source: 'pm.test("A ran before B in this iteration", () => pm.expect(pm.variables.get("seenA")).to.equal("yes"));' }]);
  await mk('C', '{{baseUrl}}/cookie-set', null);
  await mk('D', '{{baseUrl}}/status/404', null, [{ type: 'prerequest', source: 'if (pm.variables.get("jumped") !== "yes") { pm.variables.set("jumped", "yes"); pm.execution.setNextRequest("A"); }' }]);
});
afterAll(async () => {
  await t.close();
  await server.close();
});

describe('requestIds', () => {
  it('runs only the selected requests in the given order (unknown ids ignored)', async () => {
    const { runId } = await t.api.runner.start({ workspaceId: wsId, collectionId: colId, iterations: 1, delayMs: 0, stopOnFailure: false, requestIds: [ids.C!, 'nope', ids.A!, ids.C!] });
    const done = await waitForDone(runId);
    expect(done.status).toBe('completed');
    const items = await t.api.runner.items({ runId });
    expect(items.map((i) => i.name)).toEqual(['C', 'A']);
    expect(items.every((i) => i.response === undefined)).toBe(true); // keepResponses off
  });

  it('rejects a selection with no existing request', async () => {
    await expect(t.api.runner.start({ workspaceId: wsId, collectionId: colId, iterations: 1, delayMs: 0, stopOnFailure: false, requestIds: ['x', 'y'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('uses the default tree order when requestIds is empty (folder "Sub" was created first; D jumps back to A once)', async () => {
    const { runId } = await t.api.runner.start({ workspaceId: wsId, collectionId: colId, iterations: 1, delayMs: 0, stopOnFailure: false, requestIds: [] });
    await waitForDone(runId);
    expect((await t.api.runner.items({ runId })).map((i) => i.name)).toEqual(['B', 'A', 'C', 'D', 'A', 'C', 'D']);
  });
});

describe('keepResponses', () => {
  it('stores a redacted response head: no Authorization/Cookie headers, secrets masked, 64 KiB cap', async () => {
    const { runId } = await t.api.runner.start({ workspaceId: wsId, collectionId: colId, iterations: 1, delayMs: 0, stopOnFailure: false, keepResponses: true, requestIds: [ids.A!, ids.C!] });
    await waitForDone(runId);
    const stored = await t.api.runner.items({ runId });
    const live = t.events.filter((e) => e.channel === 'runner:item' && (e.payload as RunnerItemEvent).runId === runId).map((e) => e.payload as RunnerItemEvent);
    for (const list of [stored, live]) {
      const a = list.find((i) => i.name === 'A')!;
      expect(a.response).toBeTruthy();
      expect(a.response!.status).toBe(200);
      expect(a.response!.contentType).toContain('application/json');
      expect(a.response!.size).toBeGreaterThan(0);
      expect(a.response!.bodyTruncated).toBe(false);
      // the echo server reflects the request headers in the body: the token must be masked there
      expect(a.response!.body).not.toContain(TOKEN);
      expect(a.response!.body).toContain('[REDACTED]');
      expect(a.response!.body).toContain('visible');
      const names = a.response!.headers.map((h) => h.name.toLowerCase());
      expect(names).toContain('content-type');
      const c = list.find((i) => i.name === 'C')!;
      expect(c.response!.headers.map((h) => h.name.toLowerCase())).not.toContain('set-cookie');
      expect(JSON.stringify(list)).not.toContain('abc123'); // cookie value from Set-Cookie never stored
      expect(JSON.stringify(list)).not.toContain(TOKEN);
    }
    // persisted column also never contains the secret
    const rows = t.app.ctx.storage.repos.runs.items(runId);
    expect(rows.every((r) => r.responseJson !== null)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(rows.every((r) => !/authorization|set-cookie|cookie/i.test(JSON.stringify((r.response as { headers: unknown }).headers)))).toBe(true);
  });

  it('caps the stored body at 64 KiB and flags truncation', async () => {
    const big = await t.api.requests.create({ collectionId: colId, folderId: null, draft: emptyRequestDraft({ name: 'Big', url: '{{baseUrl}}/big/1' }) });
    const { runId } = await t.api.runner.start({ workspaceId: wsId, collectionId: colId, iterations: 1, delayMs: 0, stopOnFailure: false, keepResponses: true, requestIds: [big.id] });
    await waitForDone(runId);
    const [item] = await t.api.runner.items({ runId });
    expect(item!.response!.size).toBe(1024 * 1024);
    expect(item!.response!.bodyTruncated).toBe(true);
    // /big is served as octet-stream, which the response view treats as binary: body is empty but the size and truncation are reported
    expect(item!.response!.body.length).toBeLessThanOrEqual(64 * 1024);
    await t.api.requests.delete({ id: big.id });
  });
});

describe('local variables per iteration (finding #10)', () => {
  it('keeps locals across a setNextRequest jump inside an iteration and resets them per iteration', async () => {
    // Order: A (counter 1), D (jumps back to A once per iteration), A (counter 2), D (no jump), B.
    // The old heuristic wiped locals whenever the FIRST request ran in iteration >= 1, so the jump back to A
    // would reset `counter` and `jumped` (and D would loop). Locals must only reset when the iteration changes.
    const { runId } = await t.api.runner.start({ workspaceId: wsId, collectionId: colId, iterations: 2, delayMs: 0, stopOnFailure: false, requestIds: [ids.A!, ids.D!, ids.B!] });
    const done = await waitForDone(runId);
    expect(done.status).toBe('completed');
    const items = await t.api.runner.items({ runId });
    expect(items.map((i) => `${i.iteration}:${i.name}`)).toEqual(['0:A', '0:D', '0:A', '0:D', '0:B', '1:A', '1:D', '1:A', '1:D', '1:B']);
    const counterTests = items.filter((i) => i.name === 'A').map((i) => i.tests[0]!.name);
    expect(counterTests).toEqual(['counter 1', 'counter 2', 'counter 1', 'counter 2']); // kept across the jump, reset per iteration
    expect(items.filter((i) => i.name === 'B').every((i) => i.tests[0]!.passed)).toBe(true);
  });
});
