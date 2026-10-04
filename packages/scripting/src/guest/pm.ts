/** Guest-side prelude, part 4: console, tests, sendRequest, timers and the pm.* object itself. */
export const GUEST_PM: string = String.raw`
// ---------------------------------------------------------------- console
function safeStringify(value) {
  const ancestors = [];
  function replacer(key, val) {
    if (typeof val === 'bigint') return val.toString() + 'n';
    if (typeof val === 'function') return '[Function' + (val.name ? ': ' + val.name : '') + ']';
    if (typeof val === 'symbol') return val.toString();
    if (val instanceof Error) return errorToString(val);
    if (val instanceof Map) return Array.from(val.entries());
    if (val instanceof Set) return Array.from(val.values());
    if (val !== null && typeof val === 'object') {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.indexOf(val) !== -1) return '[Circular]';
      if (ancestors.length >= 20) return '[Truncated]';
      ancestors.push(val);
    }
    return val;
  }
  return $stringify(value, replacer);
}
function formatValue(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'bigint') return v.toString() + 'n';
  if (typeof v === 'symbol') return v.toString();
  if (typeof v === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
  if (v instanceof Error) return errorToString(v);
  if (typeof v === 'object') {
    try {
      const s = safeStringify(v);
      return s === undefined ? String(v) : s;
    } catch (e) {
      return '[Unprintable object]';
    }
  }
  return String(v);
}
function formatArgs(args) {
  let i = 0;
  let out = '';
  if (typeof args[0] === 'string' && args[0].indexOf('%') !== -1 && args.length > 1) {
    i = 1;
    out = args[0].replace(/%[sdifjoO%]/g, function (spec) {
      if (spec === '%%') return '%';
      if (i >= args.length) return spec;
      const a = args[i++];
      switch (spec) {
        case '%s': return typeof a === 'object' && a !== null ? formatValue(a) : String(a);
        case '%d': return typeof a === 'object' ? 'NaN' : String(Number(a));
        case '%i': return typeof a === 'object' ? 'NaN' : String(parseInt(a, 10));
        case '%f': return typeof a === 'object' ? 'NaN' : String(parseFloat(a));
        case '%j': try { return safeStringify(a); } catch (e) { return '[Circular]'; }
        default: return formatValue(a);
      }
    });
  } else if (args.length > 0) {
    out = formatValue(args[0]);
    i = 1;
  }
  for (; i < args.length; i++) out += ' ' + formatValue(args[i]);
  return out;
}
function makeLogger(level) {
  return function () {
    let msg;
    try { msg = formatArgs(Array.prototype.slice.call(arguments)); } catch (e) { msg = '[Unprintable output]'; }
    host.log(level, msg);
  };
}
const consoleObject = {
  log: makeLogger('log'), info: makeLogger('info'), warn: makeLogger('warn'), error: makeLogger('error'), debug: makeLogger('debug'),
};
consoleObject.dir = consoleObject.log;
consoleObject.trace = consoleObject.debug;
function define(name, value) {
  $defineProperty(G, name, { value: value, writable: true, configurable: true, enumerable: false });
}
define('console', consoleObject);

// ---------------------------------------------------------------- tests
const testEntries = [];
function pendingSlot(name) {
  if (testEntries.length >= MAX_TESTS) {
    if (testEntries.length === MAX_TESTS) { testEntries.push(null); warn('Test limit reached (' + MAX_TESTS + '); further tests are not recorded.'); }
    return null;
  }
  const entry = { name: name, passed: false, durationMs: 0, pending: true };
  testEntries.push(entry);
  return entry;
}
function pmTest(name, fn) {
  const testName = String(name);
  const entry = pendingSlot(testName);
  const start = $now();
  function finish(err) {
    if (entry) {
      if (!entry.pending) return;
      entry.pending = false;
      entry.durationMs = $now() - start;
      entry.passed = err === undefined || err === null;
      if (!entry.passed) entry.error = errorToString(err);
    }
  }
  if (typeof fn !== 'function') {
    finish(new TypeError('pm.test() requires a function as its second argument'));
    return pm;
  }
  try {
    let done = false;
    const ret = fn.length > 0 ? fn(function (e) { if (!done) { done = true; finish(e || undefined); } }) : fn();
    if (isThenable(ret)) {
      ret.then(function () { finish(undefined); }, function (e) { finish(e === undefined || e === null ? new Error('Promise rejected') : e); });
    } else if (fn.length === 0) {
      finish(undefined);
    }
  } catch (e) {
    finish(e);
  }
  return pm;
}
pmTest.skip = function skip(name) {
  const entry = pendingSlot(String(name));
  if (entry) { entry.pending = false; entry.passed = true; entry.skipped = true; }
  return pm;
};
pmTest.index = function index() { return testEntries.length; };

// ---------------------------------------------------------------- sendRequest
function normalizeHeaders(h) {
  const out = [];
  if (h === undefined || h === null) return out;
  if (h instanceof PropertyList) h = h.toJSON();
  if ($isArray(h)) {
    for (const x of h) {
      const it = normItem('header', x);
      if (!x || !x.disabled) out.push({ name: it.key, value: it.value });
    }
  } else if (typeof h === 'object') {
    for (const k of $keys(h)) out.push({ name: k, value: toStr(h[k]) });
  } else {
    throw new TypeError('Invalid "header" in pm.sendRequest options');
  }
  return out;
}
function formEntries(v) {
  if (v === undefined || v === null) return [];
  const list = v instanceof PropertyList ? v.toJSON() : v;
  if ($isArray(list)) {
    return list.filter(function (e) { return !(e && e.disabled); }).map(function (e) { const it = normItem('form', e); return { key: it.key, value: it.value }; });
  }
  if (typeof list === 'object') return $keys(list).map(function (k) { return { key: k, value: toStr(list[k]) }; });
  throw new TypeError('Invalid form body in pm.sendRequest options');
}
function normalizeSendRequest(arg) {
  if (typeof arg === 'string') return { url: arg, method: 'GET', headers: [] };
  if (arg === null || typeof arg !== 'object') throw new TypeError('pm.sendRequest() expects a URL string or a request object');
  const rawUrl = arg.url;
  const url = typeof rawUrl === 'string' ? rawUrl : (rawUrl && typeof rawUrl === 'object' && typeof rawUrl.raw === 'string' ? rawUrl.raw : (rawUrl instanceof Url ? rawUrl.toString() : ''));
  if (!url) throw new TypeError('pm.sendRequest(): "url" is required');
  const req = { url: url, method: arg.method ? String(arg.method).toUpperCase() : 'GET', headers: normalizeHeaders(arg.header !== undefined ? arg.header : arg.headers) };
  const body = arg.body;
  if (body && typeof body === 'object' && body.mode && body.mode !== 'none') {
    if (body.mode === 'raw') req.body = { mode: 'raw', raw: body.raw === undefined ? '' : toStr(body.raw) };
    else if (body.mode === 'urlencoded') req.body = { mode: 'urlencoded', urlencoded: formEntries(body.urlencoded) };
    else if (body.mode === 'formdata') req.body = { mode: 'formdata', formdata: formEntries(body.formdata) };
    else throw new TypeError('Unsupported body mode in pm.sendRequest: ' + String(body.mode));
  } else if (typeof body === 'string') {
    req.body = { mode: 'raw', raw: body };
  }
  if (arg.timeout !== undefined && arg.timeout !== null) {
    const t = Number(arg.timeout);
    if (isFinite(t) && t > 0) req.timeoutMs = t;
  }
  return req;
}
function reportUncaught(e) {
  host.uncaught($stringify(describeError(e)));
}
function pmSendRequest(arg, callback) {
  let promise;
  try {
    const req = normalizeSendRequest(arg);
    promise = host.sendRequest($stringify(req)).then(function (envelope) {
      const env = $parse(envelope);
      if (!env.ok) throw new Error(env.error);
      return new Response(env.response);
    });
  } catch (e) {
    promise = Promise.reject(e);
  }
  if (typeof callback === 'function') {
    promise.then(
      function (res) { try { callback(null, res); } catch (e) { reportUncaught(e); } },
      function (err) { try { callback(err); } catch (e) { reportUncaught(e); } },
    );
    return undefined;
  }
  return promise;
}

// ---------------------------------------------------------------- timers
function pmSetTimeout(fn, ms) {
  if (typeof fn !== 'function') throw new TypeError('setTimeout() requires a function');
  const extra = Array.prototype.slice.call(arguments, 2);
  return host.setTimeout(function () { fn.apply(undefined, extra); }, Number(ms) || 0);
}
function pmClearTimeout(id) { host.clearTimeout(Number(id)); }
define('setTimeout', pmSetTimeout);
define('clearTimeout', pmClearTimeout);

// ---------------------------------------------------------------- pm
let skipRequestFlag = false;
let nextRequestCalled = false;
let nextRequestValue = null;
function setNextRequest(v) {
  if (v !== null && typeof v !== 'string') throw new TypeError('setNextRequest() expects a request name/id (string) or null');
  nextRequestCalled = true;
  nextRequestValue = v;
}
function unsupported(what) {
  return function () {
    throw new Error(what + ' is not supported in the Aegis script sandbox (see docs/features/scripting.md).');
  };
}

const environmentScope = new Scope('environment');
$defineProperty(environmentScope, 'name', { value: 'environment', enumerable: false });
const visibleCookies = new CookieList(input.cookies.filter(function (c) { return !c.httpOnly; }));
function cookieCallback(cb, value) {
  if (typeof cb === 'function') {
    Promise.resolve().then(function () { try { cb(null, value); } catch (e) { reportUncaught(e); } });
    return undefined;
  }
  return Promise.resolve(value);
}
const cookieJar = {
  get(url, name, cb) { return cookieCallback(cb, visibleCookies.get(name)); },
  getAll(url, cb) { return cookieCallback(cb, visibleCookies.all()); },
  set() { warn('pm.cookies.jar().set() is a no-op: the cookie jar is read-only for scripts.'); return cookieCallback(arguments[arguments.length - 1]); },
  unset() { warn('pm.cookies.jar().unset() is a no-op: the cookie jar is read-only for scripts.'); return cookieCallback(arguments[arguments.length - 1]); },
  clear() { warn('pm.cookies.jar().clear() is a no-op: the cookie jar is read-only for scripts.'); return cookieCallback(arguments[arguments.length - 1]); },
};
const cookies = visibleCookies;
$defineProperty(cookies, 'jar', { value: function jar() { return cookieJar; }, enumerable: false });

const response = phase === 'test' && input.response ? new Response(input.response) : undefined;
const executionLocation = [String(input.origin)];
executionLocation.current = String(input.origin);

const pm = {
  info: {
    eventName: input.info.eventName,
    iteration: input.info.iteration,
    iterationCount: input.info.iterationCount,
    requestName: input.info.requestName,
    requestId: input.info.requestId,
  },
  variables: new LocalVariables(),
  environment: environmentScope,
  collectionVariables: new Scope('collectionVariables'),
  globals: new Scope('globals'),
  iterationData: new IterationData(),
  request: request,
  cookies: cookies,
  test: pmTest,
  expect: chai.expect,
  sendRequest: pmSendRequest,
  execution: {
    setNextRequest: setNextRequest,
    skipRequest: function skipRequest() {
      if (phase !== 'prerequest') throw new Error('pm.execution.skipRequest() can only be called from a pre-request script');
      skipRequestFlag = true;
    },
    location: executionLocation,
  },
  require: unsupported('pm.require()'),
  visualizer: { set: unsupported('pm.visualizer.set()'), clear: function () {} },
};
if (response !== undefined) pm.response = response;
$defineProperty(pm, 'toJSON', { value: function () { return {}; }, enumerable: false });

define('pm', pm);
define('expect', chai.expect);

// Legacy Postman API.
const testsProxy = new Proxy({}, {
  set(target, key, value) {
    const entry = pendingSlot(String(key));
    if (entry) { entry.pending = false; entry.passed = !!value; if (!value) entry.error = 'AssertionError: test "' + String(key) + '" was falsy'; }
    target[key] = value;
    return true;
  },
});
define('tests', testsProxy);
define('postman', {
  setEnvironmentVariable(k, v) { pm.environment.set(k, v); },
  getEnvironmentVariable(k) { return pm.environment.get(k); },
  clearEnvironmentVariable(k) { pm.environment.unset(k); },
  clearEnvironmentVariables() { pm.environment.clear(); },
  setGlobalVariable(k, v) { pm.globals.set(k, v); },
  getGlobalVariable(k) { return pm.globals.get(k); },
  clearGlobalVariable(k) { pm.globals.unset(k); },
  clearGlobalVariables() { pm.globals.clear(); },
  setNextRequest: setNextRequest,
  getResponseHeader(name) {
    if (!response) return null;
    const v = response.headers.get(name);
    return v === undefined ? null : v;
  },
});
if (response !== undefined) {
  define('responseBody', response.text());
  define('responseCode', { code: response.code, name: response.status, detail: response.status });
  define('responseHeaders', response.headers.toObject());
  define('responseTime', response.responseTime);
}

// Libraries that are deliberately not provided: fail loudly with a helpful message.
for (const lib of ['CryptoJS', '_', 'moment', 'cheerio', 'tv4', 'xml2Json']) {
  $defineProperty(G, lib, {
    get() { throw new Error(lib + ' is not available in the Aegis script sandbox (see docs/features/scripting.md).'); },
    set(v) { $defineProperty(G, lib, { value: v, writable: true, configurable: true, enumerable: false }); },
    configurable: true,
    enumerable: false,
  });
}

// ---------------------------------------------------------------- results
function snapshot() {
  const variables = {};
  for (const n of SCOPE_NAMES) variables[n] = mapToObject(stores[n]);
  const tests = [];
  for (const e of testEntries) {
    if (e === null) continue;
    const t = { name: e.name, passed: e.passed, durationMs: e.durationMs };
    if (e.skipped) t.skipped = true;
    if (e.pending) { t.passed = false; t.error = 'Test did not complete: its promise or done() callback never settled.'; }
    else if (e.error !== undefined) t.error = e.error;
    tests.push(t);
  }
  return $stringify({
    variables: variables,
    cleared: cleared,
    tests: tests,
    request: requestSnapshot(),
    skipRequest: skipRequestFlag,
    nextRequest: { called: nextRequestCalled, value: nextRequestValue },
  });
}
function describeJson(e) { return $stringify(describeError(e)); }
return { snapshot: snapshot, describe: describeJson };
`;
