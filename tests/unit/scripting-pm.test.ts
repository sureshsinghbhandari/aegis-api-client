import { describe, expect, it } from 'vitest';
import { runScript } from '@aegis/scripting';
import { expectOk, makeInput, makeRequest, makeResponse, testByName, testPhase } from './helpers/script-input';

const run = runScript;

describe('pm.variables / scopes', () => {
  it('resolves with precedence local > iterationData > environment > collectionVariables > globals', async () => {
    const input = makeInput(
      `
      pm.environment.set('probe', 'seen-from-env'); // scope writes do not change precedence order
      const out = {
        both: pm.variables.get('all'),
        noLocal: pm.variables.get('noLocal'),
        envOverCollection: pm.variables.get('envCol'),
        collectionOverGlobal: pm.variables.get('colGlob'),
        globalOnly: pm.variables.get('globOnly'),
        missing: pm.variables.get('nope'),
      };
      pm.variables.set('result', JSON.stringify(out));
      `,
      {
        variables: {
          globals: { all: 'global', colGlob: 'global', globOnly: 'global' },
          collectionVariables: { all: 'collection', colGlob: 'collection', envCol: 'collection' },
          environment: { all: 'env', envCol: 'env', noLocal: 'env' },
          iterationData: { all: 'iteration', noLocal: 'iteration' },
          variables: { all: 'local' },
        },
      },
    );
    const r = await run(input);
    expectOk(r);
    expect(JSON.parse(r.variables.variables.result!)).toEqual({
      both: 'local',
      noLocal: 'iteration',
      envOverCollection: 'env',
      collectionOverGlobal: 'collection',
      globalOnly: 'global',
    });
  });

  it('pm.variables.set writes the local scope only; set/unset/clear are reflected in changes', async () => {
    const r = await run(
      makeInput(
        `
        pm.variables.set('a', 'local-a');
        pm.environment.set('b', 2);
        pm.environment.unset('gone');
        pm.collectionVariables.set('c', { x: [1, 2] });
        pm.globals.set('g', true);
        pm.globals.clear();
        pm.globals.set('afterClear', 'yes');
        `,
        {
          variables: {
            environment: { gone: 'x', keep: 'k' },
            globals: { old: '1', other: '2' },
          },
        },
      ),
    );
    expectOk(r);
    expect(r.variables.variables).toEqual({ a: 'local-a' });
    expect(r.variables.environment).toEqual({ keep: 'k', b: '2' });
    expect(r.variables.collectionVariables).toEqual({ c: '{"x":[1,2]}' });
    expect(r.variables.globals).toEqual({ afterClear: 'yes' });
    expect(r.changes.variables).toEqual({ set: { a: 'local-a' }, unset: [], cleared: false });
    expect(r.changes.environment).toEqual({ set: { b: '2' }, unset: ['gone'], cleared: false });
    expect(r.changes.globals).toEqual({ set: { afterClear: 'yes' }, unset: [], cleared: true });
    expect(r.changes.iterationData).toEqual({ set: {}, unset: [], cleared: false });
  });

  it('does not mutate the input state', async () => {
    const input = makeInput('pm.environment.set("x", "changed"); pm.environment.unset("y");', {
      variables: { environment: { x: 'orig', y: 'keep' } },
    });
    await run(input);
    expect(input.variables.environment).toEqual({ x: 'orig', y: 'keep' });
  });

  it('has/unset/clear/toObject on pm.variables resolve across scopes but only mutate local', async () => {
    const r = await run(
      makeInput(
        `
        pm.variables.set('l', '1');
        pm.variables.set('shared', 'local');
        const merged = pm.variables.toObject();
        pm.variables.unset('l');
        pm.variables.unset('envOnly'); // cannot remove an environment variable
        pm.variables.clear();
        pm.environment.set('report', JSON.stringify({
          merged, hasEnvAfterUnset: pm.variables.has('envOnly'), hasL: pm.variables.has('l'), name: pm.environment.name,
        }));
        `,
        { variables: { environment: { envOnly: 'e', shared: 'env' }, globals: { g: 'g' } } },
      ),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.environment.report!)).toEqual({
      merged: { g: 'g', envOnly: 'e', shared: 'local', l: '1' },
      hasEnvAfterUnset: true,
      hasL: false,
      name: 'environment',
    });
    expect(r.variables.environment.envOnly).toBe('e');
  });

  it('replaceIn uses precedence, resolves nested references and leaves unknown variables untouched', async () => {
    const r = await run(
      makeInput(
        `
        pm.variables.set('local', 'L');
        const s = pm.variables.replaceIn('{{host}}/{{ path }}/{{local}}/{{missing}}/{{nested}}');
        const viaEnv = pm.environment.replaceIn('{{host}}');
        const notAString = pm.variables.replaceIn(5);
        pm.variables.set('out', JSON.stringify([s, viaEnv, notAString]));
        `,
        { variables: { environment: { host: 'h', path: 'p', nested: '{{host}}-{{path}}' } } },
      ),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.variables.out!)).toEqual(['h/p/L/{{missing}}/h-p', 'h', 5]);
  });

  it('replaceIn resolves dynamic variables through the host registry', async () => {
    const r = await run(
      makeInput(`
        const g = pm.variables.replaceIn('{{$guid}}');
        const n = pm.variables.replaceIn('{{$randomInt}}');
        const unknown = pm.variables.replaceIn('{{$notARealOne}}');
        pm.variables.set('out', JSON.stringify([g, n, unknown]));
      `),
    );
    expectOk(r);
    const [guid, n, unknown] = JSON.parse(r.variables.variables.out!) as string[];
    expect(guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Number.isInteger(Number(n))).toBe(true);
    expect(unknown).toBe('{{$notARealOne}}');
  });

  it('self-referencing variables terminate', async () => {
    const r = await run(makeInput(`pm.variables.set('out', pm.variables.replaceIn('{{a}}'));`, { variables: { environment: { a: 'x{{a}}' } } }));
    expectOk(r);
    expect(r.variables.variables.out).toMatch(/^(x)+\{\{a\}\}$/);
  });

  it('stringifies non-string values like Postman and keeps __proto__ as plain data', async () => {
    const r = await run(
      makeInput(`
        pm.environment.set('n', 42); pm.environment.set('o', {a:1}); pm.environment.set('b', false);
        pm.environment.set('u', undefined); pm.environment.set('nl', null);
        pm.environment.set('__proto__', 'pp'); pm.environment.set('constructor', 'cc');
      `),
    );
    expectOk(r);
    expect(r.variables.environment.n).toBe('42');
    expect(r.variables.environment.o).toBe('{"a":1}');
    expect(r.variables.environment.b).toBe('false');
    expect(r.variables.environment.u).toBe('undefined');
    expect(r.variables.environment.nl).toBe('null');
    expect(Object.hasOwn(r.variables.environment, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(r.variables.environment)).toBe(Object.prototype);
    expect(r.changes.environment.set.constructor).toBe('cc');
  });

  it('iterationData is readable and unset-able', async () => {
    const r = await run(
      makeInput(
        `
        pm.variables.set('out', JSON.stringify([pm.iterationData.get('user'), pm.iterationData.has('user'), pm.iterationData.toObject(), pm.iterationData.toJSON()]));
        pm.iterationData.unset('pass');
        `,
        { variables: { iterationData: { user: 'bob', pass: 'x' } } },
      ),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.variables.out!)).toEqual(['bob', true, { user: 'bob', pass: 'x' }, { user: 'bob', pass: 'x' }]);
    expect(r.changes.iterationData.unset).toEqual(['pass']);
  });

  it('exposes pm.info and pm.execution.location', async () => {
    const r = await run(
      makeInput(`pm.variables.set('i', JSON.stringify([pm.info.eventName, pm.info.iteration, pm.info.iterationCount, pm.info.requestName, pm.info.requestId, pm.execution.location.current]));`, {
        info: { eventName: 'prerequest', iteration: 3, iterationCount: 5, requestName: 'Create', requestId: 'r-9' },
        origin: 'folder pre-request',
      }),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.variables.i!)).toEqual(['prerequest', 3, 5, 'Create', 'r-9', 'folder pre-request']);
  });
});

describe('pm.request', () => {
  it('returns an unchanged snapshot when the script does not touch the request', async () => {
    const input = makeInput('1+1', {
      request: makeRequest({ body: { mode: 'raw', raw: '{"a":1}', rawLanguage: 'json' }, url: '{{baseUrl}}/users/{{id}}?x=1&y=%7B%7B' }),
    });
    const r = await run(input);
    expectOk(r);
    expect(r.request).toEqual(input.request);
  });

  it('exposes method, headers and url parts', async () => {
    const r = await run(
      makeInput(`
        const u = pm.request.url;
        pm.variables.set('out', JSON.stringify({
          method: pm.request.method, url: u.toString(), protocol: u.protocol, host: u.host, hostStr: u.getHost(), path: u.path, pathStr: u.getPath(),
          qs: u.getQueryString(), pq: u.getPathWithQuery(), active: u.query.get('active'), q: u.query.get('q'), hasX: u.query.has('x'),
          accept: pm.request.headers.get('accept'), hasAccept: pm.request.headers.has('ACCEPT'), headersObj: pm.request.headers.toObject(),
          getHeaders: pm.request.getHeaders({ ignoreCase: true }), queryObj: u.query.toObject(), toStringHeaders: String(pm.request.headers),
        }));
      `),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.variables.out!)).toEqual({
      method: 'GET',
      url: 'https://api.example.com/users/1?active=true&q=a%20b',
      protocol: 'https',
      host: ['api', 'example', 'com'],
      hostStr: 'api.example.com',
      path: ['users', '1'],
      pathStr: '/users/1',
      qs: 'active=true&q=a%20b',
      pq: '/users/1?active=true&q=a%20b',
      active: 'true',
      q: 'a b',
      hasX: false,
      accept: 'application/json',
      hasAccept: true,
      headersObj: { Accept: 'application/json' },
      getHeaders: { accept: 'application/json' },
      queryObj: { active: 'true', q: 'a b' },
      toStringHeaders: 'Accept: application/json',
    });
  });

  it('mutations (headers, method, query, body) are returned in result.request', async () => {
    const r = await run(
      makeInput(
        `
        pm.request.method = 'POST';
        pm.request.headers.add({ key: 'X-Trace', value: 'abc' });
        pm.request.headers.upsert({ key: 'accept', value: 'text/plain' });
        pm.request.headers.remove('X-Gone');
        pm.request.url.query.add({ key: 'page', value: '2 & 3' });
        pm.request.url.query.remove('active');
        pm.request.url.query.upsert({ key: 'q', value: 'new' });
        pm.request.body.mode = 'raw';
        pm.request.body.raw = JSON.stringify({ hello: 'world' });
        pm.request.body.options = { raw: { language: 'json' } };
        `,
        { request: makeRequest({ headers: [{ key: 'Accept', value: 'application/json', enabled: true }, { key: 'X-Gone', value: '1', enabled: true }, { key: 'X-Off', value: '1', enabled: false, description: 'd' }] }) },
      ),
    );
    expectOk(r);
    expect(r.request.method).toBe('POST');
    expect(r.request.url).toBe('https://api.example.com/users/1?q=new&page=2%20%26%203');
    expect(r.request.headers).toEqual([
      { key: 'accept', value: 'text/plain', enabled: true },
      { key: 'X-Off', value: '1', enabled: false, description: 'd' },
      { key: 'X-Trace', value: 'abc', enabled: true },
    ]);
    expect(r.request.body).toEqual({ mode: 'raw', raw: '{"hello":"world"}', rawLanguage: 'json' });
  });

  it('supports assigning pm.request.url as a string and url.update, keeps {{variables}} untouched', async () => {
    const a = await run(makeInput(`pm.request.url = '{{baseUrl}}/v2/items?id={{itemId}}&sort=asc#top';`));
    expectOk(a);
    expect(a.request.url).toBe('{{baseUrl}}/v2/items?id={{itemId}}&sort=asc#top');

    const b = await run(
      makeInput(`
        pm.request.url.update('http://localhost:3000/a/b?x=1');
        pm.request.url.query.add({ key: 'token', value: '{{token}}' });
        pm.request.url.protocol = 'https';
        pm.request.url.port = '8443';
        pm.request.url.path.push('c');
      `),
    );
    expectOk(b);
    expect(b.request.url).toBe('https://localhost:8443/a/b/c?x=1&token={{token}}');
  });

  it('supports urlencoded and formdata bodies', async () => {
    const r = await run(
      makeInput(
        `
        pm.request.body.urlencoded.add({ key: 'c', value: '3' });
        pm.request.body.urlencoded.upsert({ key: 'a', value: 'changed' });
        pm.request.body.formdata.add({ key: 'f', value: 'v' });
        pm.variables.set('str', pm.request.body.toString());
        `,
        {
          request: makeRequest({
            method: 'POST',
            body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1', enabled: true }, { key: 'b', value: '2', enabled: false }] },
          }),
        },
      ),
    );
    expectOk(r);
    expect(r.variables.variables.str).toBe('a=changed&c=3');
    expect(r.request.body.urlencoded).toEqual([
      { key: 'a', value: 'changed', enabled: true },
      { key: 'b', value: '2', enabled: false },
      { key: 'c', value: '3', enabled: true },
    ]);
    expect(r.request.body.formdata).toEqual([{ key: 'f', value: 'v', type: 'text', enabled: true }]);
  });

  it('ignores request mutations in the test phase', async () => {
    const input = testPhase(`pm.request.method = 'DELETE'; pm.request.headers.add({key:'X', value:'1'}); pm.request.url = 'http://evil';`);
    const r = await run(input);
    expectOk(r);
    expect(r.request).toEqual(input.request);
  });

  it('pm.request.toJSON is usable', async () => {
    const r = await run(makeInput(`pm.variables.set('j', JSON.stringify(pm.request.toJSON()));`));
    expectOk(r);
    const j = JSON.parse(r.variables.variables.j!);
    expect(j.method).toBe('GET');
    expect(j.url.raw).toBe('https://api.example.com/users/1?active=true&q=a%20b');
    expect(j.header).toEqual([{ key: 'Accept', value: 'application/json' }]);
  });
});

describe('pm.response', () => {
  it('is undefined in the pre-request phase', async () => {
    const r = await run(makeInput(`pm.variables.set('t', typeof pm.response); pm.variables.set('r', typeof responseBody);`));
    expectOk(r);
    expect(r.variables.variables.t).toBe('undefined');
    expect(r.variables.variables.r).toBe('undefined');
  });

  it('exposes code, status, timing, size, headers, text, json, cookies', async () => {
    const r = await run(
      testPhase(
        `
        pm.variables.set('out', JSON.stringify({
          code: pm.response.code, status: pm.response.status, reason: pm.response.reason(), time: pm.response.responseTime, size: pm.response.responseSize,
          sizeFn: pm.response.size().body, ct: pm.response.headers.get('content-type'), hasId: pm.response.headers.has('X-REQUEST-ID'),
          text: pm.response.text(), name: pm.response.json().name, nested: pm.response.json().nested.x,
          sid: pm.response.cookies.get('sid'), hasSid: pm.response.cookies.has('sid'), cookies: pm.response.cookies.toObject(),
          hdrs: pm.response.headers.toObject(),
        }));
        let n = 0; pm.response.headers.each(() => n++); pm.variables.set('headerCount', String(n));
        `,
        {
          response: makeResponse({
            code: 201,
            status: 'Created',
            bodyText: '{"name":"Ada","nested":{"x":1}}',
            responseSizeBytes: 31,
            cookies: [{ name: 'sid', value: 'abc', domain: 'api.example.com', path: '/', secure: true, httpOnly: false }],
          }),
        },
      ),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.variables.out!)).toMatchObject({
      code: 201,
      status: 'Created',
      reason: 'Created',
      time: 42,
      size: 31,
      sizeFn: 31,
      ct: 'application/json; charset=utf-8',
      hasId: true,
      text: '{"name":"Ada","nested":{"x":1}}',
      name: 'Ada',
      nested: 1,
      sid: 'abc',
      hasSid: true,
      cookies: { sid: 'abc' },
      hdrs: { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': 'abc-123' },
    });
    expect(r.variables.variables.headerCount).toBe('2');
  });

  it('json() throws a clear error on invalid JSON', async () => {
    const r = await run(testPhase(`pm.variables.set('msg', (() => { try { pm.response.json(); } catch (e) { return e.message; } })());`, { response: makeResponse({ bodyText: '<html>' }) }));
    expectOk(r);
    expect(r.variables.variables.msg).toMatch(/^Unable to parse the response body as JSON: /);
  });

  it('supports the chai-like pm.response.to assertions (pass and fail)', async () => {
    const r = await run(
      testPhase(`
        pm.test('status code', () => pm.response.to.have.status(200));
        pm.test('status text', () => pm.response.to.have.status('OK'));
        pm.test('wrong status', () => pm.response.to.have.status(404));
        pm.test('not status', () => pm.response.to.not.have.status(404));
        pm.test('header', () => pm.response.to.have.header('content-type'));
        pm.test('header value', () => pm.response.to.have.header('X-Request-Id', 'abc-123'));
        pm.test('header wrong value', () => pm.response.to.have.header('X-Request-Id', 'nope'));
        pm.test('no header', () => pm.response.to.not.have.header('X-Missing'));
        pm.test('body regex', () => pm.response.to.have.body(/Ada/));
        pm.test('body exact', () => pm.response.to.have.body('nope'));
        pm.test('jsonBody valid', () => pm.response.to.have.jsonBody());
        pm.test('jsonBody path', () => pm.response.to.have.jsonBody('nested.x'));
        pm.test('jsonBody path value', () => pm.response.to.have.jsonBody('tags[1]', 'b'));
        pm.test('jsonBody path wrong', () => pm.response.to.have.jsonBody('nested.x', 2));
        pm.test('jsonBody missing path', () => pm.response.to.have.jsonBody('nested.y'));
        pm.test('ok', () => pm.response.to.be.ok);
        pm.test('success', () => pm.response.to.be.success);
        pm.test('not error', () => pm.response.to.not.be.error);
        pm.test('not clientError', () => pm.response.to.not.be.clientError);
        pm.test('serverError fails', () => pm.response.to.be.serverError);
        pm.test('json', () => pm.response.to.be.json);
        pm.test('withBody', () => pm.response.to.be.withBody);
        pm.test('not notFound', () => pm.response.to.not.be.notFound);
      `),
    );
    expectOk(r);
    const failed = r.tests.filter((t) => !t.passed).map((t) => t.name);
    expect(failed).toEqual(['wrong status', 'header wrong value', 'body exact', 'jsonBody path wrong', 'jsonBody missing path', 'serverError fails']);
    expect(testByName(r, 'wrong status').error).toBe('AssertionError: expected response to have status code 404 but got 200');
    expect(testByName(r, 'header wrong value').error).toContain("expected response to have header 'X-Request-Id' with value 'nope' but got 'abc-123'");
  });

  it('classifies status codes', async () => {
    const codes: Array<[number, string]> = [
      [404, 'clientError'],
      [500, 'serverError'],
      [302, 'redirection'],
      [100, 'info'],
      [202, 'accepted'],
      [400, 'badRequest'],
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [429, 'rateLimited'],
    ];
    for (const [code, name] of codes) {
      const r = await run(testPhase(`pm.test('x', () => pm.response.to.be.${name});`, { response: makeResponse({ code }) }));
      expect(testByName(r, 'x').passed, `${code} ${name}`).toBe(true);
    }
    const bad = await run(testPhase(`pm.test('x', () => pm.response.to.be.ok);`, { response: makeResponse({ code: 500 }) }));
    expect(testByName(bad, 'x').passed).toBe(false);
  });

  it('jsonSchema supports a documented subset and rejects unsupported keywords clearly', async () => {
    const r = await run(
      testPhase(`
        const schema = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string', minLength: 1 }, tags: { type: 'array', items: { type: 'string' }, maxItems: 5 } } };
        pm.test('valid', () => pm.response.to.have.jsonSchema(schema));
        pm.test('invalid type', () => pm.response.to.have.jsonSchema({ type: 'object', properties: { id: { type: 'string' } } }));
        pm.test('missing required', () => pm.response.to.have.jsonSchema({ required: ['zzz'] }));
        pm.test('enum', () => pm.response.to.have.jsonSchema({ properties: { name: { enum: ['Ada', 'Bob'] } } }));
        pm.test('not valid', () => pm.response.to.not.have.jsonSchema({ type: 'array' }));
        pm.test('unsupported keyword', () => pm.response.to.have.jsonSchema({ $ref: '#/definitions/x' }));
      `),
    );
    expectOk(r);
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ['valid', true],
      ['invalid type', false],
      ['missing required', false],
      ['enum', true],
      ['not valid', true],
      ['unsupported keyword', false],
    ]);
    expect(testByName(r, 'invalid type').error).toContain('$.id should be string but was number');
    expect(testByName(r, 'unsupported keyword').error).toContain('Unsupported JSON schema keyword "$ref"');
  });

  it('pm.cookies never exposes httpOnly cookies and the jar is a read-only no-op', async () => {
    const r = await run(
      makeInput(
        `
        pm.variables.set('out', JSON.stringify({ visible: pm.cookies.get('a'), secret: pm.cookies.get('h'), hasH: pm.cookies.has('h'), all: pm.cookies.toObject() }));
        pm.cookies.jar().set('https://x.test', 'new', 'v', function () {});
        pm.cookies.jar().get('https://x.test', 'a', function (err, v) { pm.variables.set('viaJar', String(v)); });
        `,
        {
          cookies: [
            { name: 'a', value: '1', domain: 'x.test', path: '/', secure: false, httpOnly: false },
            { name: 'h', value: 'hidden', domain: 'x.test', path: '/', secure: true, httpOnly: true },
          ],
        },
      ),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.variables.out!)).toEqual({ visible: '1', hasH: false, all: { a: '1' } });
    expect(r.variables.variables.viaJar).toBe('1');
    expect(r.console.some((c) => c.level === 'warn' && c.message.includes('no-op'))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('hidden');
  });
});

describe('pm.test', () => {
  it('records pass, fail, skip; failures never abort the script', async () => {
    const r = await run(
      makeInput(`
        pm.test('passes', () => { pm.expect(1).to.equal(1); });
        pm.test('fails', () => { pm.expect(1).to.equal(2); });
        pm.test('throws', () => { throw new TypeError('boom'); });
        pm.test.skip('skipped', () => { throw new Error('must not run'); });
        pm.test('after failures', () => {});
        pm.variables.set('reached', 'yes');
      `),
    );
    expectOk(r);
    expect(r.variables.variables.reached).toBe('yes');
    expect(r.tests.map((t) => [t.name, t.passed, t.skipped ?? false])).toEqual([
      ['passes', true, false],
      ['fails', false, false],
      ['throws', false, false],
      ['skipped', true, true],
      ['after failures', true, false],
    ]);
    expect(testByName(r, 'fails').error).toBe('AssertionError: expected 1 to equal 2');
    expect(testByName(r, 'throws').error).toBe('TypeError: boom');
    expect(r.tests.every((t) => t.origin === 'test script' && t.durationMs >= 0)).toBe(true);
  });

  it('supports async tests, awaited sendRequest-free promises and done callbacks, preserving registration order', async () => {
    const r = await run(
      makeInput(`
        pm.test('async pass', async () => { await new Promise((res) => setTimeout(res, 20)); pm.expect(true).to.be.true; });
        pm.test('async fail', async () => { await Promise.resolve(); pm.expect(1).to.equal(3); });
        pm.test('promise reject', () => Promise.reject(new Error('nope')));
        pm.test('done style', function (done) { setTimeout(function () { done(); }, 5); });
        pm.test('done with error', function (done) { setTimeout(function () { done(new Error('late failure')); }, 5); });
        pm.test('sync after', () => {});
      `),
    );
    expectOk(r);
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ['async pass', true],
      ['async fail', false],
      ['promise reject', false],
      ['done style', true],
      ['done with error', false],
      ['sync after', true],
    ]);
    expect(testByName(r, 'promise reject').error).toBe('Error: nope');
    expect(testByName(r, 'done with error').error).toBe('Error: late failure');
  });

  it('reports tests whose promise never settles as failed', async () => {
    const r = await run(makeInput(`pm.test('hangs', () => new Promise(() => {}));`));
    expectOk(r);
    expect(testByName(r, 'hangs')).toMatchObject({ passed: false });
    expect(testByName(r, 'hangs').error).toContain('did not complete');
  });

  it('caps recorded tests at 5000', async () => {
    const r = await run(makeInput(`for (let i = 0; i < 5200; i++) pm.test('t' + i, () => {});`));
    expectOk(r);
    expect(r.tests).toHaveLength(5000);
    expect(r.console.some((c) => c.message.includes('Test limit reached'))).toBe(true);
  });

  it('supports the legacy tests["name"] = bool style', async () => {
    const r = await run(testPhase(`tests['Status is 200'] = responseCode.code === 200; tests['Has body'] = responseBody.indexOf('Ada') > -1; tests['bad'] = false;`));
    expectOk(r);
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ['Status is 200', true],
      ['Has body', true],
      ['bad', false],
    ]);
  });
});

describe('pm.expect (chai)', () => {
  it('provides the common assertion surface', async () => {
    const r = await run(
      makeInput(`
        const o = { a: 1, b: { c: [1, 2, 3] }, s: 'hello world' };
        const t = (name, fn) => pm.test(name, fn);
        t('equal', () => pm.expect(1).to.equal(1));
        t('eql', () => pm.expect({ a: [1] }).to.eql({ a: [1] }));
        t('deep.equal', () => pm.expect({ a: [1] }).to.deep.equal({ a: [1] }));
        t('true/false', () => { pm.expect(true).to.be.true; pm.expect(false).to.be.false; });
        t('null/undefined', () => { pm.expect(null).to.be.null; pm.expect(undefined).to.be.undefined; });
        t('exist', () => { pm.expect(0).to.exist; pm.expect(null).to.not.exist; });
        t('ok', () => pm.expect('x').to.be.ok);
        t('a/an', () => { pm.expect('s').to.be.a('string'); pm.expect([]).to.be.an('array'); pm.expect({}).to.be.an('object'); });
        t('include', () => { pm.expect([1, 2]).to.include(2); pm.expect('abc').to.contain('b'); pm.expect(o).to.include({ a: 1 }); });
        t('property', () => { pm.expect(o).to.have.property('a'); pm.expect(o).to.have.property('a', 1); });
        t('nested.property', () => pm.expect(o).to.have.nested.property('b.c[1]', 2));
        t('lengthOf', () => { pm.expect([1, 2, 3]).to.have.lengthOf(3); pm.expect('ab').to.have.length(2); });
        t('empty', () => { pm.expect([]).to.be.empty; pm.expect({}).to.be.empty; pm.expect('').to.be.empty; });
        t('comparisons', () => { pm.expect(5).to.be.above(3); pm.expect(5).to.be.below(9); pm.expect(5).to.be.at.least(5); pm.expect(5).to.be.at.most(5); pm.expect(5).to.be.within(1, 10); });
        t('match', () => pm.expect('abc123').to.match(/\\d+/));
        t('keys', () => pm.expect({ a: 1, b: 2 }).to.have.all.keys('a', 'b'));
        t('oneOf', () => pm.expect(2).to.be.oneOf([1, 2, 3]));
        t('string', () => pm.expect('foobar').to.have.string('oba'));
        t('instanceOf', () => pm.expect(new Error('x')).to.be.instanceOf(Error));
        t('throw', () => pm.expect(() => { throw new Error('bad'); }).to.throw('bad'));
        t('closeTo', () => pm.expect(1.5).to.be.closeTo(1, 0.6));
        t('members', () => pm.expect([1, 2, 3]).to.have.members([3, 2, 1]));
        t('satisfy', () => pm.expect(10).to.satisfy((n) => n % 2 === 0));
        t('not', () => { pm.expect(1).to.not.equal(2); pm.expect([1]).to.not.include(5); });
        t('chain words', () => pm.expect({ a: 1 }).that.is.an('object').and.has.property('a').which.is.a('number'));
        t('global expect', () => expect(1).to.equal(1));
      `),
    );
    expectOk(r);
    const failed = r.tests.filter((x) => !x.passed);
    expect(failed).toEqual([]);
    expect(r.tests.length).toBe(26);
  });

  it('produces chai-style failure messages', async () => {
    const cases: Array<[string, string]> = [
      ['pm.expect(1).to.equal(2)', 'expected 1 to equal 2'],
      ['pm.expect({ a: 1 }).to.have.property("b")', "expected { a: 1 } to have property 'b'"],
      ['pm.expect([1, 2]).to.have.lengthOf(3)', 'expected [ 1, 2 ] to have a length of 3 but got 2'],
      ['pm.expect(5).to.be.within(1, 3)', 'expected 5 to be within 1..3'],
      ['pm.expect("a").to.be.a("number")', 'expected \'a\' to be a number'],
      ['pm.expect(true).to.be.false', 'expected true to be false'],
      ['pm.expect({ a: 1 }).to.eql({ a: 2 })', 'expected { a: 1 } to deeply equal { a: 2 }'],
      ['pm.expect(1).to.not.equal(1)', 'expected 1 to not equal 1'],
    ];
    const r = await run(makeInput(cases.map(([code], i) => `pm.test('c${i}', () => { ${code}; });`).join('\n')));
    expectOk(r);
    cases.forEach(([, message], i) => {
      expect(testByName(r, `c${i}`).error).toBe(`AssertionError: ${message}`);
    });
  });

  it('fails clearly on misspelled chai properties', async () => {
    const r = await run(makeInput(`pm.test('typo', () => pm.expect(1).to.be.ture);`));
    expect(testByName(r, 'typo').error).toContain('Invalid Chai property: ture');
  });
});

describe('additional API surface', () => {
  it('PropertyList helpers: each/map/filter/find/count/idx/all/clear/populate/insert/prepend', async () => {
    const r = await run(
      makeInput(`
        const h = pm.request.headers;
        h.add('X-One: 1'); h.append({ key: 'X-Two', value: '2' }); h.prepend({ key: 'X-Zero', value: '0' });
        const seen = []; h.each((x) => seen.push(x.key));
        const out = { seen, count: h.count(), idx1: h.idx(1).key, mapped: h.map((x) => x.value), filtered: h.filter((x) => x.key.startsWith('X-')).length, found: h.find((x) => x.value === '2').key, all: h.all().length };
        h.remove((x) => x.key === 'X-Two');
        out.afterRemove = h.count();
        h.populate([{ key: 'Only', value: 'one' }]);
        out.afterPopulate = h.toObject();
        h.clear();
        out.afterClear = h.count();
        pm.variables.set('out', JSON.stringify(out));
      `),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.variables.out!)).toEqual({
      seen: ['X-Zero', 'Accept', 'X-One', 'X-Two'],
      count: 4,
      idx1: 'Accept',
      mapped: ['0', 'application/json', '1', '2'],
      filtered: 3,
      found: 'X-Two',
      all: 4,
      afterRemove: 3,
      afterPopulate: { Only: 'one' },
      afterClear: 0,
    });
    expect(r.request.headers).toEqual([]);
  });

  it('pm.test.index counts recorded tests and response body assertions can match exactly', async () => {
    const r = await run(
      testPhase(
        `
        pm.test('a', () => {});
        pm.test('b', () => pm.response.to.have.body('plain text'));
        pm.test('c', () => pm.response.to.have.body());
        pm.test('d', () => pm.response.to.not.have.body('other'));
        pm.variables.set('idx', String(pm.test.index()));
        `,
        { response: makeResponse({ bodyText: 'plain text' }) },
      ),
    );
    expectOk(r);
    expect(r.tests.every((t) => t.passed)).toBe(true);
    expect(r.variables.variables.idx).toBe('4');
  });

  it('url.update accepts an object form and query can be replaced wholesale', async () => {
    const r = await run(makeInput(`pm.request.url.update({ protocol: 'http', host: ['localhost'], port: '9000', path: ['v1', 'x'], hash: '' }); pm.request.url.query = 'a=1&b=2';`));
    expectOk(r);
    expect(r.request.url).toBe('http://localhost:9000/v1/x?a=1&b=2');
  });

  it('pm.request.addHeader / removeHeader and disabled headers are not visible to get()', async () => {
    const r = await run(
      makeInput(`pm.request.addHeader({ key: 'X-A', value: '1' }); pm.request.removeHeader('Accept'); pm.variables.set('off', String(pm.request.headers.get('X-Off')));`, {
        request: makeRequest({ headers: [{ key: 'Accept', value: 'a', enabled: true }, { key: 'X-Off', value: 'z', enabled: false }] }),
      }),
    );
    expectOk(r);
    expect(r.variables.variables.off).toBe('undefined');
    expect(r.request.headers).toEqual([
      { key: 'X-Off', value: 'z', enabled: false },
      { key: 'X-A', value: '1', enabled: true },
    ]);
  });

  it('pm.visualizer.set and postman.* extras fail with clear messages', async () => {
    const r = await run(makeInput(`try { pm.visualizer.set('<p>'); } catch (e) { pm.variables.set('m', e.message); }`));
    expectOk(r);
    expect(r.variables.variables.m).toContain('not supported');
  });
});

describe('scope helpers and legacy response globals', () => {
  it('environment/collectionVariables/globals support has() and toObject() on their own scope only', async () => {
    const r = await run(
      makeInput(
        `
        pm.variables.set('out', JSON.stringify({
          envHas: pm.environment.has('e'), envHasOther: pm.environment.has('c'), colHas: pm.collectionVariables.has('c'), globHas: pm.globals.has('g'),
          env: pm.environment.toObject(), col: pm.collectionVariables.toObject(), glob: pm.globals.toObject(), envJson: JSON.stringify(pm.environment),
        }));
        `,
        { variables: { environment: { e: '1' }, collectionVariables: { c: '2' }, globals: { g: '3' } } },
      ),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.variables.out!)).toEqual({
      envHas: true, envHasOther: false, colHas: true, globHas: true, env: { e: '1' }, col: { c: '2' }, glob: { g: '3' }, envJson: '{"e":"1"}',
    });
  });

  it('legacy responseHeaders / responseTime / responseCode globals are available in the test phase', async () => {
    const r = await run(testPhase(`pm.variables.set('out', JSON.stringify({ h: responseHeaders['X-Request-Id'], t: responseTime, c: responseCode, b: responseBody.length > 0 }));`));
    expectOk(r);
    expect(JSON.parse(r.variables.variables.out!)).toEqual({ h: 'abc-123', t: 42, c: { code: 200, name: 'OK', detail: 'OK' }, b: true });
  });
});

describe('console', () => {
  it('captures all levels, formats values and supports %s %d %j', async () => {
    const r = await run(
      makeInput(`
        console.log('plain');
        console.info('info', 1, true, null, undefined);
        console.warn({ a: 1, b: [1, 2] });
        console.error(new TypeError('bad thing'));
        console.debug('%s is %d years and %j', 'Bob', 42.7, { x: 1 }, 'extra');
        const cyc = { name: 'c' }; cyc.self = cyc; console.log(cyc);
        console.log([1, [2, { z: cyc }]]);
        console.log('100%', 'done'); console.log('%%', 5);
        console.log(function foo() {}, Symbol('s'), 10n);
      `),
    );
    expectOk(r);
    expect(r.console.map((c) => [c.level, c.message])).toEqual([
      ['log', 'plain'],
      ['info', 'info 1 true null undefined'],
      ['warn', '{"a":1,"b":[1,2]}'],
      ['error', 'TypeError: bad thing'],
      ['debug', 'Bob is 42.7 years and {"x":1} extra'],
      ['log', '{"name":"c","self":"[Circular]"}'],
      ['log', '[1,[2,{"z":{"name":"c","self":"[Circular]"}}]]'],
      ['log', '100% done'],
      ['log', '% 5'],
      ['log', '[Function: foo] Symbol(s) 10n'],
    ]);
    expect(r.console.every((c) => c.origin === 'test script' && typeof c.timestamp === 'number')).toBe(true);
  });
});

describe('execution control', () => {
  it('records setNextRequest (string and null) and skipRequest', async () => {
    const a = await run(makeInput(`pm.execution.setNextRequest('Login'); pm.execution.skipRequest();`));
    expectOk(a);
    expect(a.nextRequest).toBe('Login');
    expect(a.skipRequest).toBe(true);

    const b = await run(makeInput(`pm.execution.setNextRequest(null);`));
    expect(b.nextRequest).toBeNull();
    expect(Object.hasOwn(b, 'nextRequest')).toBe(true);

    const c = await run(makeInput(`1`));
    expect(c.nextRequest).toBeUndefined();
    expect(Object.hasOwn(c, 'nextRequest')).toBe(false);
    expect(c.skipRequest).toBe(false);
  });

  it('rejects invalid setNextRequest values and skipRequest in the test phase', async () => {
    const a = await run(makeInput(`pm.execution.setNextRequest(42);`));
    expect(a.ok).toBe(false);
    expect(a.error?.message).toContain('setNextRequest');
    const b = await run(testPhase(`pm.execution.skipRequest();`));
    expect(b.ok).toBe(false);
    expect(b.error?.message).toContain('pre-request');
  });

  it('supports the legacy postman.* aliases', async () => {
    const r = await run(
      testPhase(`
        postman.setEnvironmentVariable('e', 'ev'); postman.setGlobalVariable('g', 'gv');
        pm.variables.set('read', postman.getEnvironmentVariable('e') + postman.getGlobalVariable('g') + postman.getResponseHeader('x-request-id'));
        postman.clearEnvironmentVariable('e');
        postman.setNextRequest('Next');
      `),
    );
    expectOk(r);
    expect(r.variables.variables.read).toBe('evgvabc-123');
    expect(r.variables.environment.e).toBeUndefined();
    expect(r.variables.globals.g).toBe('gv');
    expect(r.nextRequest).toBe('Next');
  });
});

describe('top-level behaviour', () => {
  it('supports top-level await and return', async () => {
    const r = await run(makeInput(`const v = await Promise.resolve('x'); pm.variables.set('v', v); return; pm.variables.set('unreachable', '1');`));
    expectOk(r);
    expect(r.variables.variables).toEqual({ v: 'x' });
  });

  it('reports uncaught exceptions but keeps earlier results', async () => {
    const r = await run(
      makeInput(`
        pm.environment.set('before', '1');
        console.log('before error');
        pm.test('ok test', () => {});
        throw new RangeError('exploded');
      `),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'SCRIPT_ERROR', name: 'RangeError', message: 'exploded' });
    expect(r.error?.stack).toContain('script.js');
    expect(r.variables.environment.before).toBe('1');
    expect(r.changes.environment.set).toEqual({ before: '1' });
    expect(r.console.map((c) => c.message)).toEqual(['before error']);
    expect(r.tests).toHaveLength(1);
  });

  it('reports syntax errors with line information', async () => {
    const r = await run(makeInput(`var ok = 1;\nvar broken = ;\n`));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SCRIPT_ERROR');
    expect(r.error?.name).toBe('SyntaxError');
    expect(r.error?.message).toMatch(/line 2/);
  });

  it('reports non-Error throws', async () => {
    const r = await run(makeInput(`throw 'just a string';`));
    expect(r.error).toMatchObject({ code: 'SCRIPT_ERROR', message: 'just a string' });
  });

  it('fails for rejected async code at the top level', async () => {
    const r = await run(makeInput(`await Promise.reject(new Error('async boom'));`));
    expect(r.error).toMatchObject({ code: 'SCRIPT_ERROR', message: 'async boom' });
  });

  it('reports an error when the script awaits a promise that can never settle', async () => {
    const r = await run(makeInput(`await new Promise(() => {});`));
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('never settle');
  });

  it('supports setTimeout/clearTimeout ordering and extra arguments', async () => {
    const r = await run(
      makeInput(`
        const order = [];
        setTimeout((a, b) => { order.push('t30:' + a + b); }, 30, 'x', 'y');
        setTimeout(() => order.push('t5'), 5);
        const cancelled = setTimeout(() => order.push('never'), 10);
        clearTimeout(cancelled);
        Promise.resolve().then(() => order.push('micro'));
        await new Promise((res) => setTimeout(res, 60));
        pm.variables.set('order', order.join(','));
      `),
    );
    expectOk(r);
    expect(r.variables.variables.order).toBe('micro,t5,t30:xy');
  });

  it('provides atob/btoa/TextEncoder/TextDecoder/URL/URLSearchParams', async () => {
    const r = await run(
      makeInput(`
        const enc = new TextEncoder().encode('héllo €😀');
        const u = new URL('https://User:pw@Example.com:8443/a/b?x=1&y=two#frag');
        u.searchParams.append('z', 'a b');
        const sp = new URLSearchParams({ q: 'a&b', r: 'ü' });
        pm.variables.set('out', JSON.stringify({
          b: btoa('Hello, World!'), a: atob('SGVsbG8sIFdvcmxkIQ=='), decoded: new TextDecoder().decode(enc), len: enc.length,
          host: u.host, port: u.port, path: u.pathname, hash: u.hash, search: u.search, y: u.searchParams.get('y'), href: u.href, origin: u.origin,
          sp: sp.toString(), parsed: [...new URLSearchParams('a=1&a=2&b=%20x+y')].join('|'),
          rel: new URL('../c?d=1', 'https://h.test/a/b/e').href,
        }));
      `),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.variables.out!)).toEqual({
      b: 'SGVsbG8sIFdvcmxkIQ==',
      a: 'Hello, World!',
      decoded: 'héllo €😀',
      len: 14,
      host: 'example.com:8443',
      port: '8443',
      path: '/a/b',
      hash: '#frag',
      search: '?x=1&y=two&z=a+b',
      y: 'two',
      href: 'https://User:pw@example.com:8443/a/b?x=1&y=two&z=a+b#frag',
      origin: 'https://example.com:8443',
      sp: 'q=a%26b&r=%C3%BC',
      parsed: 'a,1|a,2|b, x y',
      rel: 'https://h.test/a/c?d=1',
    });
  });

  it('gives clear errors for unsupported libraries and leaves require undefined', async () => {
    const r = await run(
      makeInput(`
        const probes = {};
        for (const name of ['CryptoJS', '_', 'moment', 'cheerio', 'tv4', 'xml2Json']) {
          try { globalThis[name]; probes[name] = 'accessible'; } catch (e) { probes[name] = e.message; }
        }
        try { pm.require('lodash'); } catch (e) { probes.pmRequire = e.message; }
        probes.requireType = typeof require;
        pm.variables.set('out', JSON.stringify(probes));
      `),
    );
    expectOk(r);
    const out = JSON.parse(r.variables.variables.out!) as Record<string, string>;
    for (const name of ['CryptoJS', '_', 'moment', 'cheerio', 'tv4', 'xml2Json']) expect(out[name]).toContain('not available in the Aegis script sandbox');
    expect(out.pmRequire).toContain('not supported');
    expect(out.requireType).toBe('undefined');
  });

  it('does not require network or other host input to run empty scripts', async () => {
    const r = await run(makeInput(''));
    expectOk(r);
    expect(r.tests).toEqual([]);
    expect(r.console).toEqual([]);
  });

  it('rejects malformed input as a programmer error', async () => {
    await expect(runScript({} as never)).rejects.toThrow(TypeError);
  });
});
