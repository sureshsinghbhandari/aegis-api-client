/**
 * Guest-side prelude, part 1: helpers, property lists, variable scopes.
 * Concatenated (see ../prelude.ts) into ONE function body evaluated in QuickJS.
 * No backticks and no dollar+brace sequences in this file (String.raw).
 */
export const GUEST_CORE: string = String.raw`
const G = globalThis;
const input = JSON.parse(inputJson);
const phase = input.phase;
const $stringify = JSON.stringify;
const $parse = JSON.parse;
const $defineProperty = Object.defineProperty;
const $keys = Object.keys;
const $isArray = Array.isArray;
const $now = Date.now.bind(Date);
const MAX_TESTS = 5000;

function setOwn(obj, key, value) {
  $defineProperty(obj, key, { value: value, enumerable: true, writable: true, configurable: true });
}
function hidden(obj, key, value) {
  $defineProperty(obj, key, { value: value, enumerable: false, writable: true, configurable: true });
}
function toStr(v) {
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object') {
    try {
      const s = $stringify(v);
      return s === undefined ? String(v) : s;
    } catch (e) {
      return String(v);
    }
  }
  return String(v);
}
function isThenable(v) {
  return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}
// Encode for use in a URL but keep {{variable}} references intact.
function encodeKeepVars(s) {
  return String(s).split(/(\{\{[^{}]*\}\})/).map(function (part, i) {
    return i % 2 === 1 ? part : encodeURIComponent(part);
  }).join('');
}
function assertionError(message) {
  return new chai.AssertionError(message);
}
function describeError(e) {
  let name = 'Error';
  let message = '';
  let stack = '';
  try {
    if (e !== null && typeof e === 'object') {
      name = String(e.name || 'Error');
      message = String(e.message === undefined ? '' : e.message);
      stack = typeof e.stack === 'string' ? e.stack : '';
    } else {
      message = String(e);
    }
  } catch (x) {
    message = 'Unprintable error';
  }
  return { name: name, message: message, stack: stack };
}
function errorToString(e) {
  const d = describeError(e);
  return d.message ? d.name + ': ' + d.message : d.name;
}
function mapToObject(m) {
  const o = {};
  for (const entry of m) setOwn(o, entry[0], entry[1]);
  return o;
}
function warn(message) {
  host.log('warn', message);
}

// ---------------------------------------------------------------- property lists
const ITEMS = new WeakMap();
function itemsOf(list) { return ITEMS.get(list).a; }

function normItem(kind, it) {
  if (typeof it === 'string') {
    if (kind === 'header') {
      const i = it.indexOf(':');
      return { key: (i === -1 ? it : it.slice(0, i)).trim(), value: i === -1 ? '' : it.slice(i + 1).trim() };
    }
    const j = it.indexOf('=');
    return { key: j === -1 ? it : it.slice(0, j), value: j === -1 ? (kind === 'query' ? null : '') : it.slice(j + 1) };
  }
  if (it === null || typeof it !== 'object') throw new TypeError('Expected an object with "key" and "value" (or a string)');
  const out = {
    key: String(it.key),
    value: it.value === null && kind === 'query' ? null : (it.value === undefined || it.value === null ? '' : toStr(it.value)),
  };
  if (it.disabled) out.disabled = true;
  if (it.description !== undefined && it.description !== null) out.description = String(it.description);
  if (kind === 'form') out.type = it.type === undefined ? 'text' : String(it.type);
  return out;
}

class PropertyList {
  constructor(kind, ci, items) {
    const a = [];
    ITEMS.set(this, { a: a, kind: kind, ci: ci });
    if (items) for (const it of items) a.push(normItem(kind, it));
  }
  #match(it, name) {
    const m = ITEMS.get(this);
    if (it.key === null || it.key === undefined) return false;
    return m.ci ? String(it.key).toLowerCase() === String(name).toLowerCase() : it.key === String(name);
  }
  get(name) {
    for (const it of ITEMS.get(this).a) if (!it.disabled && this.#match(it, name)) return it.value;
    return undefined;
  }
  one(name) {
    for (const it of ITEMS.get(this).a) if (!it.disabled && this.#match(it, name)) return it;
    return undefined;
  }
  has(name, value) {
    for (const it of ITEMS.get(this).a) {
      if (!it.disabled && this.#match(it, name) && (value === undefined || it.value === value)) return true;
    }
    return false;
  }
  add(item) { const m = ITEMS.get(this); m.a.push(normItem(m.kind, item)); }
  append(item) { this.add(item); }
  prepend(item) { const m = ITEMS.get(this); m.a.unshift(normItem(m.kind, item)); }
  insert(item, before) {
    const m = ITEMS.get(this);
    const n = normItem(m.kind, item);
    const i = before === undefined ? -1 : m.a.findIndex((x) => this.#match(x, before));
    if (i === -1) m.a.push(n); else m.a.splice(i, 0, n);
  }
  upsert(item) {
    const m = ITEMS.get(this);
    const n = normItem(m.kind, item);
    const i = m.a.findIndex((x) => this.#match(x, n.key));
    if (i === -1) { m.a.push(n); return; }
    m.a[i] = n;
    for (let j = m.a.length - 1; j > i; j--) if (this.#match(m.a[j], n.key)) m.a.splice(j, 1);
  }
  remove(arg) {
    const m = ITEMS.get(this);
    const keep = m.a.filter((it) => !(typeof arg === 'function' ? arg(it) : this.#match(it, arg)));
    m.a.length = 0;
    for (const it of keep) m.a.push(it);
  }
  clear() { ITEMS.get(this).a.length = 0; }
  populate(items) {
    const m = ITEMS.get(this);
    m.a.length = 0;
    if (items) for (const it of items) m.a.push(normItem(m.kind, it));
  }
  each(cb, ctx) { for (const it of ITEMS.get(this).a.slice()) cb.call(ctx, it); }
  forEach(cb, ctx) { this.each(cb, ctx); }
  map(cb, ctx) { return ITEMS.get(this).a.map((it) => cb.call(ctx, it)); }
  filter(cb, ctx) { return ITEMS.get(this).a.filter((it) => cb.call(ctx, it)); }
  find(cb, ctx) { return ITEMS.get(this).a.find((it) => cb.call(ctx, it)); }
  count() { return ITEMS.get(this).a.length; }
  get length() { return ITEMS.get(this).a.length; }
  idx(i) { return ITEMS.get(this).a[i]; }
  all() { return ITEMS.get(this).a.slice(); }
  get members() { return ITEMS.get(this).a; }
  toObject(excludeDisabled) {
    const o = {};
    for (const it of ITEMS.get(this).a) {
      if (it.disabled && excludeDisabled !== false) continue;
      setOwn(o, it.key, it.value);
    }
    return o;
  }
  toJSON() { return ITEMS.get(this).a.slice(); }
  toString() {
    const m = ITEMS.get(this);
    if (m.kind === 'header') return m.a.map((it) => it.key + ': ' + it.value).join('\n');
    return m.a.filter((it) => !it.disabled).map((it) => (it.value === null ? encodeKeepVars(it.key) : encodeKeepVars(it.key) + '=' + encodeKeepVars(it.value))).join('&');
  }
  [Symbol.iterator]() { return ITEMS.get(this).a[Symbol.iterator](); }
}

class CookieList {
  constructor(cookies) {
    ITEMS.set(this, { a: cookies.map(function (c) { return Object.assign({}, c); }) });
  }
  get(name) { const c = this.one(name); return c ? c.value : undefined; }
  one(name) { return ITEMS.get(this).a.find((c) => c.name === String(name)); }
  has(name) { return this.one(name) !== undefined; }
  count() { return ITEMS.get(this).a.length; }
  all() { return ITEMS.get(this).a.slice(); }
  each(cb, ctx) { for (const c of ITEMS.get(this).a.slice()) cb.call(ctx, c); }
  forEach(cb, ctx) { this.each(cb, ctx); }
  map(cb, ctx) { return ITEMS.get(this).a.map((c) => cb.call(ctx, c)); }
  filter(cb, ctx) { return ITEMS.get(this).a.filter((c) => cb.call(ctx, c)); }
  toObject() {
    const o = {};
    for (const c of ITEMS.get(this).a) setOwn(o, c.name, c.value);
    return o;
  }
  toJSON() { return ITEMS.get(this).a.slice(); }
  [Symbol.iterator]() { return ITEMS.get(this).a[Symbol.iterator](); }
}

// ---------------------------------------------------------------- variables
const SCOPE_NAMES = ['globals', 'environment', 'collectionVariables', 'variables', 'iterationData'];
// Highest precedence first.
const PRECEDENCE = ['variables', 'iterationData', 'environment', 'collectionVariables', 'globals'];
const stores = {};
const cleared = {};
for (const n of SCOPE_NAMES) {
  const m = new Map();
  const src = input.variables[n] || {};
  for (const k of $keys(src)) m.set(k, String(src[k]));
  stores[n] = m;
  cleared[n] = false;
}
function resolveVar(k) {
  for (const n of PRECEDENCE) {
    const m = stores[n];
    if (m.has(k)) return m.get(k);
  }
  return undefined;
}
function mergedObject() {
  const o = {};
  for (let i = PRECEDENCE.length - 1; i >= 0; i--) {
    for (const entry of stores[PRECEDENCE[i]]) setOwn(o, entry[0], entry[1]);
  }
  return o;
}
function replaceIn(str, depth) {
  if (typeof str !== 'string') return str;
  const d = depth || 0;
  return str.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (whole, name) {
    const v = name.charAt(0) === '$' ? host.dynamic(name) : resolveVar(name);
    if (v === undefined || v === null) return whole;
    return d < 10 && v.indexOf('{{') !== -1 ? replaceIn(v, d + 1) : v;
  });
}

class Scope {
  #n;
  constructor(n) { this.#n = n; }
  get(k) { return stores[this.#n].get(String(k)); }
  set(k, v) { stores[this.#n].set(String(k), toStr(v)); }
  unset(k) { stores[this.#n].delete(String(k)); }
  has(k) { return stores[this.#n].has(String(k)); }
  clear() { stores[this.#n].clear(); cleared[this.#n] = true; }
  toObject() { return mapToObject(stores[this.#n]); }
  toJSON() { return this.toObject(); }
  replaceIn(s) { return replaceIn(s); }
}
// pm.variables: reads resolve across all scopes, writes go to the local scope.
class LocalVariables extends Scope {
  constructor() { super('variables'); }
  get(k) { return resolveVar(String(k)); }
  has(k) { return resolveVar(String(k)) !== undefined; }
  toObject() { return mergedObject(); }
}
// pm.iterationData is (almost) read-only for scripts.
class IterationData {
  get(k) { return stores.iterationData.get(String(k)); }
  has(k) { return stores.iterationData.has(String(k)); }
  unset(k) { stores.iterationData.delete(String(k)); }
  toObject() { return mapToObject(stores.iterationData); }
  toJSON() { return this.toObject(); }
  replaceIn(s) { return replaceIn(s); }
}
`;
