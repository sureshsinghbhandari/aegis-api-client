/** Guest-side prelude, part 2: Url, Body and pm.request. */
export const GUEST_REQUEST: string = String.raw`
// ---------------------------------------------------------------- url
const URLMETA = new WeakMap();

function asHostString(h) { return $isArray(h) ? h.join('.') : (h === undefined || h === null ? '' : String(h)); }
function asPathArray(p) {
  if ($isArray(p)) return p.map(String);
  if (p === undefined || p === null || p === '') return [];
  return String(p).replace(/^\//, '').split('/');
}
function parseQueryString(qs) {
  const out = [];
  if (!qs) return out;
  for (const pair of qs.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rk = eq === -1 ? pair : pair.slice(0, eq);
    const rv = eq === -1 ? null : pair.slice(eq + 1);
    const item = { key: safeDecode(rk), value: rv === null ? null : safeDecode(rv) };
    hidden(item, '_raw', [rk, rv]);
    out.push(item);
  }
  return out;
}
function queryItemString(it) {
  const raw = it._raw;
  const k = raw && safeDecode(raw[0]) === it.key ? raw[0] : encodeKeepVars(it.key);
  if (it.value === null || it.value === undefined) return k;
  const v = raw && raw[1] !== null && safeDecode(raw[1]) === it.value ? raw[1] : encodeKeepVars(it.value);
  return k + '=' + v;
}
function urlSignature(u) {
  const q = itemsOf(u.query).map(function (i) { return [i.key, i.value, !!i.disabled]; });
  return $stringify([String(u.protocol || '').replace(/:?\/*$/, ''), u.auth || '', asHostString(u.host), u.port ? String(u.port) : '', asPathArray(u.path), u.hash || '', q]);
}
function setQueryItems(list, items) {
  const a = itemsOf(list);
  a.length = 0;
  for (const it of items) a.push(it);
}

class Url {
  constructor(str) {
    URLMETA.set(this, { query: new PropertyList('query', false, []), orig: '', sig: '' });
    this.protocol = '';
    this.auth = '';
    this.host = [];
    this.port = '';
    this.path = [];
    this.hash = '';
    this.update(str === undefined ? '' : str);
  }
  get query() { return URLMETA.get(this).query; }
  set query(v) {
    const q = URLMETA.get(this).query;
    if (typeof v === 'string') setQueryItems(q, parseQueryString(v.replace(/^\?/, '')));
    else q.populate(v);
  }
  update(v) {
    const meta = URLMETA.get(this);
    if (typeof v === 'string') {
      let rest = v;
      let hash = '';
      const hi = rest.indexOf('#');
      if (hi !== -1) { hash = rest.slice(hi + 1); rest = rest.slice(0, hi); }
      let qs = '';
      const qi = rest.indexOf('?');
      if (qi !== -1) { qs = rest.slice(qi + 1); rest = rest.slice(0, qi); }
      let protocol = '';
      const pm = /^([A-Za-z][A-Za-z0-9+.\-]*):\/\//.exec(rest);
      if (pm) { protocol = pm[1]; rest = rest.slice(pm[0].length); }
      const slash = rest.indexOf('/');
      let hostport = slash === -1 ? rest : rest.slice(0, slash);
      const pathStr = slash === -1 ? null : rest.slice(slash + 1);
      let auth = '';
      const at = hostport.lastIndexOf('@');
      if (at !== -1) { auth = hostport.slice(0, at); hostport = hostport.slice(at + 1); }
      let port = '';
      const portMatch = /:(\d+)$/.exec(hostport);
      if (portMatch) { port = portMatch[1]; hostport = hostport.slice(0, portMatch.index); }
      this.protocol = protocol;
      this.auth = auth;
      this.host = hostport === '' ? [] : hostport.split('.');
      this.port = port;
      this.path = pathStr === null ? [] : pathStr.split('/');
      this.hash = hash;
      setQueryItems(meta.query, parseQueryString(qs));
      meta.orig = v;
      meta.sig = urlSignature(this);
      return;
    }
    if (v === null || typeof v !== 'object') throw new TypeError('url.update() expects a string or an object');
    if (typeof v.raw === 'string') this.update(v.raw);
    if (v.protocol !== undefined) this.protocol = v.protocol;
    if (v.auth !== undefined) this.auth = v.auth;
    if (v.host !== undefined) this.host = v.host;
    if (v.port !== undefined) this.port = v.port;
    if (v.path !== undefined) this.path = v.path;
    if (v.hash !== undefined) this.hash = v.hash;
    if (v.query !== undefined) this.query = v.query;
  }
  getHost() { return asHostString(this.host); }
  getPath() { return '/' + asPathArray(this.path).join('/'); }
  getQueryString() {
    return itemsOf(this.query).filter(function (i) { return !i.disabled; }).map(queryItemString).join('&');
  }
  getPathWithQuery() {
    const qs = this.getQueryString();
    return this.getPath() + (qs ? '?' + qs : '');
  }
  getRemote() { return this.getHost() + (this.port ? ':' + this.port : ''); }
  toString() {
    const meta = URLMETA.get(this);
    // Untouched URLs round-trip byte for byte.
    if (urlSignature(this) === meta.sig) return meta.orig;
    let s = '';
    const protocol = String(this.protocol || '').replace(/:?\/*$/, '');
    if (protocol) s += protocol + '://';
    if (this.auth) s += this.auth + '@';
    s += this.getHost();
    if (this.port) s += ':' + this.port;
    const path = asPathArray(this.path);
    if (path.length) s += '/' + path.join('/');
    const qs = this.getQueryString();
    if (qs) s += '?' + qs;
    if (this.hash) s += '#' + this.hash;
    return s;
  }
  toJSON() {
    return {
      raw: this.toString(),
      protocol: this.protocol,
      host: asHostString(this.host).split('.'),
      port: this.port,
      path: asPathArray(this.path),
      query: itemsOf(this.query).slice(),
      hash: this.hash,
    };
  }
}

// ---------------------------------------------------------------- body
const BODY_MODES = ['none', 'raw', 'urlencoded', 'formdata', 'binary'];
function entryToItem(e) {
  const it = { key: e.key, value: e.value };
  if (e.enabled === false) it.disabled = true;
  if (e.description !== undefined) it.description = e.description;
  if (e.type !== undefined) it.type = e.type;
  return it;
}

class Body {
  constructor(snap) {
    this.mode = snap.mode;
    if (typeof snap.raw === 'string') this.raw = snap.raw;
    this.options = snap.rawLanguage ? { raw: { language: snap.rawLanguage } } : {};
    this.urlencoded = new PropertyList('form', false, (snap.urlencoded || []).map(entryToItem));
    this.formdata = new PropertyList('form', false, (snap.formdata || []).map(entryToItem));
  }
  update(v) {
    if (typeof v === 'string') { this.mode = 'raw'; this.raw = v; return; }
    if (v === null || typeof v !== 'object') throw new TypeError('body.update() expects a string or an object');
    if (v.mode !== undefined) this.mode = String(v.mode);
    if (v.raw !== undefined) this.raw = String(v.raw);
    if (v.options !== undefined) this.options = v.options;
    if (v.urlencoded !== undefined) this.urlencoded.populate(v.urlencoded);
    if (v.formdata !== undefined) this.formdata.populate(v.formdata);
  }
  isEmpty() {
    if (this.mode === 'raw') return !this.raw;
    if (this.mode === 'urlencoded') return this.urlencoded.count() === 0;
    if (this.mode === 'formdata') return this.formdata.count() === 0;
    return this.mode === 'none';
  }
  toString() {
    if (this.mode === 'raw') return this.raw === undefined ? '' : String(this.raw);
    if (this.mode === 'urlencoded') return this.urlencoded.toString();
    return '';
  }
  toJSON() {
    const o = { mode: this.mode };
    if (this.raw !== undefined) o.raw = this.raw;
    o.urlencoded = this.urlencoded.toJSON();
    o.formdata = this.formdata.toJSON();
    o.options = this.options;
    return o;
  }
}

// ---------------------------------------------------------------- pm.request
const requestUrl = new Url(input.request.url);
const request = {
  method: input.request.method,
  headers: new PropertyList('header', true, input.request.headers.map(entryToItem)),
  body: new Body(input.request.body),
  getHeaders(opts) {
    const ignoreCase = !!(opts && opts.ignoreCase);
    const enabledOnly = !opts || opts.enabled !== false;
    const o = {};
    for (const h of itemsOf(this.headers)) {
      if (h.disabled && enabledOnly) continue;
      setOwn(o, ignoreCase ? h.key.toLowerCase() : h.key, h.value);
    }
    return o;
  },
  addHeader(h) { this.headers.add(h); },
  removeHeader(name) { this.headers.remove(name); },
  toJSON() {
    return { method: String(this.method), url: requestUrl.toJSON(), header: this.headers.toJSON(), body: this.body.toJSON() };
  },
};
$defineProperty(request, 'url', {
  get() { return requestUrl; },
  set(v) { requestUrl.update(v); },
  enumerable: true,
  configurable: true,
});

// pm.request.auth: a frozen, read-only view (credential parameters are masked by the host before they get here).
function buildRequestAuth(a) {
  if (!a || typeof a !== 'object') return undefined;
  const type = a.type === 'none' ? 'noauth' : String(a.type);
  const params = a.params && typeof a.params === 'object' ? a.params : {};
  const items = $keys(params).map(function (k) {
    const v = params[k];
    return Object.freeze({ key: k, value: v, type: typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'string' });
  });
  const auth = { type: type };
  setOwn(auth, type, Object.freeze(items.slice()));
  hidden(auth, 'parameters', function parameters() { return new PropertyList('auth', false, items.map(function (it) { return { key: it.key, value: it.value }; })); });
  hidden(auth, 'toJSON', function toJSON() { const o = { type: type }; setOwn(o, type, items.map(function (it) { return { key: it.key, value: it.value, type: it.type }; })); return o; });
  hidden(auth, 'toString', function toString() { return type; });
  return Object.freeze(auth);
}
$defineProperty(request, 'auth', { value: buildRequestAuth(input.auth), writable: false, enumerable: true, configurable: false });

function requestSnapshot() {
  if (phase !== 'prerequest') return null;
  const headers = itemsOf(request.headers).map(function (h) {
    const e = { key: String(h.key), value: String(h.value === null ? '' : h.value), enabled: !h.disabled };
    if (h.description !== undefined) e.description = String(h.description);
    return e;
  });
  const b = request.body;
  const mode = BODY_MODES.indexOf(b.mode) === -1 ? input.request.body.mode : b.mode;
  const body = { mode: mode };
  if (b.raw !== undefined) body.raw = String(b.raw);
  const lang = b.options && b.options.raw && b.options.raw.language;
  if (lang) body.rawLanguage = String(lang);
  const urlencoded = itemsOf(b.urlencoded).map(function (e) {
    const o = { key: String(e.key), value: String(e.value === null ? '' : e.value), enabled: !e.disabled };
    if (e.description !== undefined) o.description = String(e.description);
    return o;
  });
  const formdata = itemsOf(b.formdata).map(function (e) {
    return { key: String(e.key), value: String(e.value === null ? '' : e.value), type: String(e.type || 'text'), enabled: !e.disabled };
  });
  // Only emit lists that carry data (or existed on input) so untouched requests round-trip unchanged.
  if (urlencoded.length > 0 || input.request.body.urlencoded !== undefined) body.urlencoded = urlencoded;
  if (formdata.length > 0 || input.request.body.formdata !== undefined) body.formdata = formdata;
  return { method: String(request.method), url: requestUrl.toString(), headers: headers, body: body };
}
`;
