/** Guest-side prelude, part 3: Response, response assertions and the JSON-schema subset. */
export const GUEST_RESPONSE: string = String.raw`
// ---------------------------------------------------------------- json helpers
function deepEqual(a, b) {
  try { chai.expect(a).to.eql(b); return true; } catch (e) { return false; }
}
function lookupPath(obj, path) {
  let p = String(path);
  if (p === '$') return { found: true, value: obj };
  p = p.replace(/^\$\.?/, '');
  const re = /\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]|([^.\[\]]+)/g;
  let cur = obj;
  let m;
  while ((m = re.exec(p)) !== null) {
    const tok = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    if (cur === null || cur === undefined || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, tok)) {
      return { found: false, value: undefined };
    }
    cur = cur[tok];
  }
  return { found: true, value: cur };
}
function show(v) {
  try {
    const s = typeof v === 'string' ? $stringify(v) : $stringify(v);
    return s === undefined ? String(v) : (s.length > 120 ? s.slice(0, 117) + '...' : s);
  } catch (e) {
    return String(v);
  }
}

// ---------------------------------------------------------------- response
// (JSON-schema validation lives in libs.ts: validateJsonSchema, backed by the bundled ajv / tv4.)
const RESP = new WeakMap();
class Response {
  constructor(s) {
    this.code = s.code;
    this.status = s.status;
    this.responseTime = s.responseTimeMs;
    this.responseSize = s.responseSizeBytes;
    this.headers = new PropertyList('header', true, s.headers.map(function (h) { return { key: h.name, value: h.value }; }));
    this.cookies = new CookieList(s.cookies);
    RESP.set(this, { body: s.bodyText });
  }
  text() { return RESP.get(this).body; }
  json() {
    const body = RESP.get(this).body;
    try {
      return $parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);
    } catch (e) {
      throw new Error('Unable to parse the response body as JSON: ' + (e && e.message ? e.message : String(e)));
    }
  }
  reason() { return this.status; }
  size() {
    let header = 0;
    for (const h of itemsOf(this.headers)) header += h.key.length + h.value.length + 4;
    return { body: this.responseSize, header: header, total: this.responseSize + header };
  }
  get to() { return new ResponseAssertion(this, false); }
  toJSON() {
    return { code: this.code, status: this.status, header: this.headers.toJSON(), responseTime: this.responseTime, responseSize: this.responseSize };
  }
}

const STATUS_CLASSES = {
  info: [function (c) { return c >= 100 && c < 200; }, 'informational (1xx)'],
  success: [function (c) { return c >= 200 && c < 300; }, 'successful (2xx)'],
  redirection: [function (c) { return c >= 300 && c < 400; }, 'a redirection (3xx)'],
  clientError: [function (c) { return c >= 400 && c < 500; }, 'a client error (4xx)'],
  serverError: [function (c) { return c >= 500 && c < 600; }, 'a server error (5xx)'],
  error: [function (c) { return c >= 400 && c < 600; }, 'an error (4xx or 5xx)'],
  ok: [function (c) { return c === 200; }, 'ok (200)'],
  accepted: [function (c) { return c === 202; }, 'accepted (202)'],
  badRequest: [function (c) { return c === 400; }, 'bad request (400)'],
  unauthorized: [function (c) { return c === 401; }, 'unauthorized (401)'],
  forbidden: [function (c) { return c === 403; }, 'forbidden (403)'],
  notFound: [function (c) { return c === 404; }, 'not found (404)'],
  rateLimited: [function (c) { return c === 429; }, 'rate limited (429)'],
};

class ResponseAssertion {
  #r;
  #neg;
  constructor(r, neg) { this.#r = r; this.#neg = neg; }
  get not() { return new ResponseAssertion(this.#r, !this.#neg); }
  #check(condition, positive, negative) {
    if (this.#neg ? condition : !condition) throw assertionError(this.#neg ? negative : positive);
    return this;
  }
  status(expected) {
    const r = this.#r;
    if (typeof expected === 'number') {
      return this.#check(r.code === expected, 'expected response to have status code ' + expected + ' but got ' + r.code, 'expected response to not have status code ' + expected);
    }
    if (typeof expected === 'string') {
      return this.#check(r.status === expected, "expected response to have status reason '" + expected + "' but got '" + r.status + "'", "expected response to not have status reason '" + expected + "'");
    }
    throw new TypeError('status() expects a status code (number) or a reason phrase (string)');
  }
  header(name, value) {
    const r = this.#r;
    const actual = r.headers.get(name);
    if (value === undefined) {
      return this.#check(actual !== undefined, "expected response to have header with key '" + name + "'", "expected response to not have header with key '" + name + "'");
    }
    return this.#check(actual === String(value), "expected response to have header '" + name + "' with value '" + value + "' but got " + (actual === undefined ? 'no such header' : "'" + actual + "'"), "expected response to not have header '" + name + "' with value '" + value + "'");
  }
  body(expected) {
    const text = this.#r.text();
    if (expected === undefined) return this.withBody;
    if (expected instanceof RegExp) {
      return this.#check(expected.test(text), 'expected response body to match ' + expected + ' but got ' + show(text), 'expected response body to not match ' + expected);
    }
    return this.#check(text === String(expected), 'expected response body to equal ' + show(String(expected)) + ' but got ' + show(text), 'expected response body to not equal ' + show(String(expected)));
  }
  jsonBody(path, value) {
    let parsed;
    let valid = true;
    try { parsed = this.#r.json(); } catch (e) { valid = false; }
    if (arguments.length === 0) {
      return this.#check(valid, 'expected response body to be valid JSON', 'expected response body to not be valid JSON');
    }
    if (!valid) throw assertionError('expected response body to be valid JSON');
    if (typeof path !== 'string') {
      return this.#check(deepEqual(parsed, path), 'expected response body to deeply equal ' + show(path) + ' but got ' + show(parsed), 'expected response body to not deeply equal ' + show(path));
    }
    const hit = lookupPath(parsed, path);
    if (arguments.length === 1) {
      return this.#check(hit.found, "expected response JSON body to have path '" + path + "'", "expected response JSON body to not have path '" + path + "'");
    }
    return this.#check(hit.found && deepEqual(hit.value, value), "expected response JSON body path '" + path + "' to equal " + show(value) + ' but got ' + (hit.found ? show(hit.value) : 'nothing'), "expected response JSON body path '" + path + "' to not equal " + show(value));
  }
  jsonSchema(schema, options) {
    let parsed;
    try { parsed = this.#r.json(); } catch (e) { throw assertionError('expected response body to be valid JSON'); }
    const errors = validateJsonSchema(parsed, schema, options);
    return this.#check(errors.length === 0, 'expected response body to match the JSON schema: ' + errors.slice(0, 3).join('; '), 'expected response body to not match the JSON schema');
  }
  get withBody() {
    return this.#check(this.#r.text().length > 0, 'expected response to have a body', 'expected response to not have a body');
  }
  get json() {
    let valid = true;
    try { this.#r.json(); } catch (e) { valid = false; }
    return this.#check(valid, 'expected response body to be JSON', 'expected response body to not be JSON');
  }
  _statusClass(name) {
    const spec = STATUS_CLASSES[name];
    const code = this.#r.code;
    return this.#check(spec[0](code), 'expected response to be ' + spec[1] + ' but got status code ' + code, 'expected response to not be ' + spec[1] + ' but got status code ' + code);
  }
}
for (const w of ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does']) {
  $defineProperty(ResponseAssertion.prototype, w, { get() { return this; }, configurable: true });
}
for (const name of $keys(STATUS_CLASSES)) {
  $defineProperty(ResponseAssertion.prototype, name, { get() { return this._statusClass(name); }, configurable: true });
}
`;
