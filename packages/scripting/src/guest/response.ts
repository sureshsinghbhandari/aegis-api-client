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

// ---------------------------------------------------------------- JSON schema subset
const SCHEMA_KEYWORDS = {
  type: 1, properties: 1, required: 1, items: 1, enum: 1, const: 1, minimum: 1, maximum: 1,
  minLength: 1, maxLength: 1, pattern: 1, minItems: 1, maxItems: 1, additionalProperties: 1,
  allOf: 1, anyOf: 1, oneOf: 1, not: 1,
};
const SCHEMA_ANNOTATIONS = { title: 1, description: 1, $schema: 1, $id: 1, $comment: 1, default: 1, examples: 1, format: 1 };
function jsonTypeOf(v) {
  if (v === null) return 'null';
  if ($isArray(v)) return 'array';
  return typeof v;
}
function matchesType(v, t) {
  const actual = jsonTypeOf(v);
  if (t === 'integer') return actual === 'number' && Math.floor(v) === v;
  if (t === 'number') return actual === 'number' && isFinite(v);
  return actual === t;
}
function schemaErrors(value, schema, path, out, depth) {
  if (depth > 32) throw new Error('JSON schema is nested too deeply');
  if (schema === true) return;
  if (schema === false) { out.push(path + ' is not allowed'); return; }
  if (schema === null || typeof schema !== 'object') throw new Error('Invalid JSON schema: expected an object');
  for (const key of $keys(schema)) {
    if (!SCHEMA_KEYWORDS[key] && !SCHEMA_ANNOTATIONS[key]) {
      throw new Error('Unsupported JSON schema keyword "' + key + '". Supported: ' + $keys(SCHEMA_KEYWORDS).join(', '));
    }
  }
  if (schema.type !== undefined) {
    const types = $isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(function (t) { return matchesType(value, t); })) {
      out.push(path + ' should be ' + types.join(' or ') + ' but was ' + jsonTypeOf(value));
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some(function (e) { return deepEqual(e, value); })) {
    out.push(path + ' should be one of ' + show(schema.enum));
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) out.push(path + ' should equal ' + show(schema.const));
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(path + ' should be >= ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(path + ' should be <= ' + schema.maximum);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(path + ' should have length >= ' + schema.minLength);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(path + ' should have length <= ' + schema.maxLength);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push(path + ' should match pattern ' + schema.pattern);
  }
  if ($isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(path + ' should have at least ' + schema.minItems + ' items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(path + ' should have at most ' + schema.maxItems + ' items');
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i++) schemaErrors(value[i], schema.items, path + '[' + i + ']', out, depth + 1);
    }
  }
  if (value !== null && typeof value === 'object' && !$isArray(value)) {
    if (schema.required !== undefined) {
      for (const r of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, r)) out.push(path + ' is missing required property "' + r + '"');
      }
    }
    const props = schema.properties || {};
    for (const k of $keys(props)) {
      if (Object.prototype.hasOwnProperty.call(value, k)) schemaErrors(value[k], props[k], path + '.' + k, out, depth + 1);
    }
    if (schema.additionalProperties === false) {
      for (const k of $keys(value)) if (!Object.prototype.hasOwnProperty.call(props, k)) out.push(path + ' has unexpected property "' + k + '"');
    } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      throw new Error('Unsupported JSON schema: additionalProperties must be a boolean');
    }
  }
  if (schema.allOf !== undefined) for (const s of schema.allOf) schemaErrors(value, s, path, out, depth + 1);
  if (schema.anyOf !== undefined) {
    const ok = schema.anyOf.some(function (s) { const e = []; schemaErrors(value, s, path, e, depth + 1); return e.length === 0; });
    if (!ok) out.push(path + ' should match at least one schema in anyOf');
  }
  if (schema.oneOf !== undefined) {
    const n = schema.oneOf.filter(function (s) { const e = []; schemaErrors(value, s, path, e, depth + 1); return e.length === 0; }).length;
    if (n !== 1) out.push(path + ' should match exactly one schema in oneOf (matched ' + n + ')');
  }
  if (schema.not !== undefined) {
    const e = [];
    schemaErrors(value, schema.not, path, e, depth + 1);
    if (e.length === 0) out.push(path + ' should not match the "not" schema');
  }
}

// ---------------------------------------------------------------- response
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
  jsonSchema(schema) {
    let parsed;
    try { parsed = this.#r.json(); } catch (e) { throw assertionError('expected response body to be valid JSON'); }
    const errors = [];
    schemaErrors(parsed, schema, '$', errors, 0);
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
