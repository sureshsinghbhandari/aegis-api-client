import { describe, expect, it } from 'vitest';
import { runScript } from '@aegis/scripting';
import { expectOk, fakeHost, makeInput, okResponse, testByName } from './helpers/script-input';

describe('pm.sendRequest', () => {
  it('callback style with a URL string', async () => {
    const host = fakeHost(async () => okResponse({ code: 201, status: 'Created', bodyText: '{"token":"t-1"}', headers: [{ name: 'X-A', value: 'b' }], responseTimeMs: 7, responseSizeBytes: 15 }));
    const r = await runScript(
      makeInput(
        `
        pm.sendRequest('https://auth.example.com/token', function (err, res) {
          pm.environment.set('err', String(err));
          pm.environment.set('code', String(res.code));
          pm.environment.set('status', res.status);
          pm.environment.set('token', res.json().token);
          pm.environment.set('hdr', res.headers.get('x-a'));
          pm.environment.set('time', String(res.responseTime));
          pm.environment.set('size', String(res.responseSize));
          pm.environment.set('text', res.text());
          pm.test('callback assertion', () => res.to.have.status(201));
        });
        `,
        { host },
      ),
    );
    expectOk(r);
    expect(host.calls).toEqual([{ url: 'https://auth.example.com/token', method: 'GET', headers: [] }]);
    expect(r.variables.environment).toEqual({
      err: 'null',
      code: '201',
      status: 'Created',
      token: 't-1',
      hdr: 'b',
      time: '7',
      size: '15',
      text: '{"token":"t-1"}',
    });
    expect(testByName(r, 'callback assertion').passed).toBe(true);
  });

  it('promise style with await, normalising a Postman request object', async () => {
    const host = fakeHost();
    const r = await runScript(
      makeInput(
        `
        const res = await pm.sendRequest({
          url: 'https://api.example.com/items',
          method: 'post',
          header: { 'Content-Type': 'application/json', 'X-Num': 5 },
          body: { mode: 'raw', raw: JSON.stringify({ a: 1 }) },
          timeout: 1500,
        });
        pm.variables.set('ok', String(res.json().ok));
        `,
        { host },
      ),
    );
    expectOk(r);
    expect(r.variables.variables.ok).toBe('true');
    expect(host.calls[0]).toEqual({
      url: 'https://api.example.com/items',
      method: 'POST',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Num', value: '5' },
      ],
      body: { mode: 'raw', raw: '{"a":1}' },
      timeoutMs: 1500,
    });
  });

  it('normalises header arrays (skipping disabled), urlencoded and formdata bodies, raw url objects', async () => {
    const host = fakeHost();
    const r = await runScript(
      makeInput(
        `
        await pm.sendRequest({ url: { raw: 'https://h.test/form' }, method: 'POST', header: [{ key: 'A', value: '1' }, { key: 'B', value: '2', disabled: true }, 'C: 3'],
          body: { mode: 'urlencoded', urlencoded: [{ key: 'k', value: 'v' }, { key: 'off', value: 'x', disabled: true }] } });
        await pm.sendRequest({ url: 'https://h.test/mp', method: 'PUT', body: { mode: 'formdata', formdata: [{ key: 'f', value: 'g' }] } });
        `,
        { host },
      ),
    );
    expectOk(r);
    expect(host.calls[0]).toEqual({
      url: 'https://h.test/form',
      method: 'POST',
      headers: [
        { name: 'A', value: '1' },
        { name: 'C', value: '3' },
      ],
      body: { mode: 'urlencoded', urlencoded: [{ key: 'k', value: 'v' }] },
    });
    expect(host.calls[1]!.body).toEqual({ mode: 'formdata', formdata: [{ key: 'f', value: 'g' }] });
  });

  it('delivers host errors as err (callback) and as rejection (promise) without leaking secrets', async () => {
    const host = fakeHost(async () => {
      throw new Error('connect ECONNREFUSED token=SUPERSECRETVALUE');
    });
    const r = await runScript(
      makeInput(
        `
        pm.sendRequest('https://down.example.com', function (err, res) {
          pm.variables.set('cbErr', err.message);
          pm.variables.set('cbRes', String(res));
          pm.variables.set('cbStack', String(err.stack));
        });
        try { await pm.sendRequest('https://down.example.com'); } catch (e) { pm.variables.set('pErr', e.message); }
        `,
        { host, secretValues: ['SUPERSECRETVALUE'] },
      ),
    );
    expectOk(r);
    expect(r.variables.variables.cbErr).toBe('connect ECONNREFUSED token=[REDACTED]');
    expect(r.variables.variables.pErr).toBe('connect ECONNREFUSED token=[REDACTED]');
    expect(r.variables.variables.cbRes).toBe('undefined');
    expect(JSON.stringify(r)).not.toContain('SUPERSECRETVALUE');
  });

  it('turns invalid arguments into err/rejection', async () => {
    const host = fakeHost();
    const r = await runScript(
      makeInput(
        `
        pm.sendRequest(42, function (err) { pm.variables.set('e1', err.message); });
        try { await pm.sendRequest({ method: 'GET' }); } catch (e) { pm.variables.set('e2', e.message); }
        `,
        { host },
      ),
    );
    expectOk(r);
    expect(r.variables.variables.e1).toContain('expects a URL string or a request object');
    expect(r.variables.variables.e2).toContain('"url" is required');
    expect(host.calls).toHaveLength(0);
  });

  it('enforces the per-script request cap and still delivers the first responses', async () => {
    const host = fakeHost();
    const r = await runScript(
      makeInput(
        `
        const results = [];
        for (let i = 0; i < 5; i++) {
          try { await pm.sendRequest('https://h.test/' + i); results.push('ok'); } catch (e) { results.push(e.message); }
        }
        pm.variables.set('results', JSON.stringify(results));
        `,
        { host, limits: { maxSendRequests: 2 } },
      ),
    );
    expectOk(r);
    expect(host.calls).toHaveLength(2);
    const results = JSON.parse(r.variables.variables.results!) as string[];
    expect(results.slice(0, 2)).toEqual(['ok', 'ok']);
    expect(results[2]).toContain('limit exceeded (max 2 per script)');
  });

  it('defaults the cap to 20 requests', async () => {
    const host = fakeHost();
    const r = await runScript(
      makeInput(
        `
        let ok = 0, rejected = 0;
        for (let i = 0; i < 25; i++) { try { await pm.sendRequest('https://h.test/' + i); ok++; } catch (e) { rejected++; } }
        pm.variables.set('ok', String(ok)); pm.variables.set('rejected', String(rejected));
        `,
        { host },
      ),
    );
    expectOk(r);
    expect([r.variables.variables.ok, r.variables.variables.rejected]).toEqual(['20', '5']);
    expect(host.calls).toHaveLength(20);
  });

  it('runs requests concurrently and waits for all of them before finishing', async () => {
    let active = 0;
    let maxActive = 0;
    const host = fakeHost(async (req) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((res) => setTimeout(res, 40));
      active--;
      return okResponse({ bodyText: JSON.stringify({ url: req.url }) });
    });
    const r = await runScript(
      makeInput(
        `
        // no await: the run must still wait for the pending requests
        for (const n of ['a', 'b', 'c']) pm.sendRequest('https://h.test/' + n, (err, res) => pm.collectionVariables.set(n, res.json().url));
        `,
        { host },
      ),
    );
    expectOk(r);
    expect(maxActive).toBe(3);
    expect(r.variables.collectionVariables).toEqual({ a: 'https://h.test/a', b: 'https://h.test/b', c: 'https://h.test/c' });
  });

  it('request chaining: use a response to set a variable for the next call', async () => {
    const host = fakeHost(async (req) =>
      req.url.endsWith('/login') ? okResponse({ bodyText: '{"access_token":"tok-1"}' }) : okResponse({ bodyText: JSON.stringify({ auth: req.headers.find((h) => h.name === 'Authorization')?.value }) }),
    );
    const r = await runScript(
      makeInput(
        `
        const login = await pm.sendRequest({ url: 'https://h.test/login', method: 'POST' });
        const token = login.json().access_token;
        pm.environment.set('token', token);
        const me = await pm.sendRequest({ url: 'https://h.test/me', header: { Authorization: 'Bearer ' + token } });
        pm.environment.set('seenAuth', me.json().auth);
        `,
        { host },
      ),
    );
    expectOk(r);
    expect(r.variables.environment).toEqual({ token: 'tok-1', seenAuth: 'Bearer tok-1' });
  });

  it('aborts in-flight requests on timeout and reports SCRIPT_TIMEOUT', async () => {
    let aborted = false;
    const host = fakeHost(
      (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted by signal'));
          });
        }),
    );
    const started = Date.now();
    const r = await runScript(makeInput(`pm.environment.set('before', '1'); await pm.sendRequest('https://slow.example.com'); pm.environment.set('after', '1');`, { host, limits: { timeoutMs: 300 } }));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SCRIPT_TIMEOUT');
    expect(aborted).toBe(true);
    expect(r.variables.environment).toEqual({ before: '1' });
  });

  it('aborts in-flight requests when the caller cancels', async () => {
    const controller = new AbortController();
    let aborted = false;
    const host = fakeHost(
      (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    const promise = runScript(makeInput(`await pm.sendRequest('https://slow.example.com');`, { host, signal: controller.signal, limits: { timeoutMs: 10_000 } }));
    setTimeout(() => controller.abort(), 100);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'SCRIPT_ERROR', message: 'Script cancelled' });
    expect(aborted).toBe(true);
  });

  it('an exception thrown inside a callback fails the run but keeps earlier output', async () => {
    const r = await runScript(
      makeInput(`
        pm.environment.set('before', '1');
        pm.sendRequest('https://h.test', function () { throw new Error('callback exploded'); });
      `),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'SCRIPT_ERROR', message: 'callback exploded' });
    expect(r.variables.environment.before).toBe('1');
  });

  it('response objects support chai-style assertions and cookies', async () => {
    const host = fakeHost(async () =>
      okResponse({ code: 404, status: 'Not Found', cookies: [{ name: 's', value: 'v', domain: 'h.test', path: '/', secure: false, httpOnly: false }] }),
    );
    const r = await runScript(
      makeInput(
        `
        const res = await pm.sendRequest('https://h.test');
        pm.test('is 404', () => res.to.have.status(404));
        pm.test('is not ok', () => res.to.not.be.ok);
        pm.test('wrong', () => res.to.have.status(200));
        pm.variables.set('cookie', res.cookies.get('s'));
        `,
        { host },
      ),
    );
    expectOk(r);
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ['is 404', true],
      ['is not ok', true],
      ['wrong', false],
    ]);
    expect(r.variables.variables.cookie).toBe('v');
  });

  it('a host that throws synchronously surfaces as err', async () => {
    const host = fakeHost();
    host.sendRequest = () => {
      throw new Error('sync host failure');
    };
    const r = await runScript(makeInput(`try { await pm.sendRequest('https://h.test'); } catch (e) { pm.variables.set('m', e.message); }`, { host }));
    expectOk(r);
    expect(r.variables.variables.m).toBe('sync host failure');
  });
});
