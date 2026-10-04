/**
 * Guest-side (QuickJS) sources. They are plain JavaScript stored as strings and
 * evaluated ONLY inside the sandbox. They must not contain backticks or the
 * two-character sequence dollar+brace (this file uses String.raw).
 */

/** Minimal Event/EventTarget so the bundled chai can initialise. Removed again by the prelude. */
export const GUEST_SHIMS: string = String.raw`
(function () {
  'use strict';
  var G = globalThis;
  class Event {
    constructor(type) { this.type = type; }
  }
  class EventTarget {
    constructor() { this.listeners = {}; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
      var l = this.listeners[type] || [];
      var i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    }
    dispatchEvent(ev) {
      var l = (this.listeners[ev.type] || []).slice();
      for (var i = 0; i < l.length; i++) l[i].call(this, ev);
      return true;
    }
  }
  Object.defineProperty(G, 'Event', { value: Event, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(G, 'EventTarget', { value: EventTarget, writable: true, configurable: true, enumerable: false });
})();
`;

/** Small, dependency-free web-platform built-ins that QuickJS does not ship (atob, btoa, TextEncoder, URL, ...). */
export const GUEST_BUILTINS: string = String.raw`
(function () {
  'use strict';
  var G = globalThis;
  function def(name, value) {
    Object.defineProperty(G, name, { value: value, writable: true, configurable: true, enumerable: false });
  }
  function domError(name, message) {
    var e = new Error(message);
    e.name = name;
    return e;
  }

  // ---- atob / btoa ----
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  def('btoa', function btoa(input) {
    var s = String(input);
    var out = '';
    for (var i = 0; i < s.length; i += 3) {
      var a = s.charCodeAt(i);
      var b = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
      var c = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
      if (a > 255 || b > 255 || c > 255) {
        throw domError('InvalidCharacterError', 'The string to be encoded contains characters outside of the Latin1 range.');
      }
      var n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
      out += isNaN(b) ? '=' : B64.charAt((n >> 6) & 63);
      out += isNaN(c) ? '=' : B64.charAt(n & 63);
    }
    return out;
  });
  def('atob', function atob(input) {
    var s = String(input).replace(/[\t\n\f\r ]+/g, '');
    if (s.length % 4 === 0) s = s.replace(/==?$/, '');
    if (s.length % 4 === 1 || /[^A-Za-z0-9+\/]/.test(s)) {
      throw domError('InvalidCharacterError', 'The string to be decoded is not correctly encoded.');
    }
    var out = '';
    var buf = 0;
    var bits = 0;
    for (var i = 0; i < s.length; i++) {
      buf = (buf << 6) | B64.indexOf(s.charAt(i));
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buf >> bits) & 255);
        buf &= (1 << bits) - 1;
      }
    }
    return out;
  });

  // ---- TextEncoder / TextDecoder (UTF-8 only) ----
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(input) {
      var s = input === undefined ? '' : String(input);
      var bytes = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.codePointAt(i);
        if (c > 0xffff) i++;
        if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(bytes);
    }
  }
  class TextDecoder {
    constructor(label, options) {
      var l = label === undefined ? 'utf-8' : String(label).toLowerCase();
      if (l !== 'utf-8' && l !== 'utf8') throw new RangeError('Only the utf-8 encoding is supported');
      this.fatal = !!(options && options.fatal);
      this.ignoreBOM = !!(options && options.ignoreBOM);
    }
    get encoding() { return 'utf-8'; }
    decode(input) {
      if (input === undefined) return '';
      var bytes;
      if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
      else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      else throw new TypeError('The "input" argument must be an ArrayBuffer or ArrayBufferView');
      var out = '';
      var i = 0;
      var n = bytes.length;
      var fatal = this.fatal;
      function bad() {
        if (fatal) throw new TypeError('The encoded data was not valid utf-8');
        out += '�';
      }
      while (i < n) {
        var b = bytes[i++];
        if (b < 0x80) { out += String.fromCharCode(b); continue; }
        var need = 0;
        var min = 0;
        var cp = 0;
        if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; min = 0x80; }
        else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0x0f; min = 0x800; }
        else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x07; min = 0x10000; }
        else { bad(); continue; }
        var j = 0;
        for (; j < need; j++) {
          var nb = bytes[i + j];
          if (nb === undefined || (nb & 0xc0) !== 0x80) break;
          cp = (cp << 6) | (nb & 0x3f);
        }
        if (j < need || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { i += j; bad(); continue; }
        i += need;
        out += String.fromCodePoint(cp);
      }
      if (!this.ignoreBOM && out.charCodeAt(0) === 0xfeff) out = out.slice(1);
      return out;
    }
  }
  def('TextEncoder', TextEncoder);
  def('TextDecoder', TextDecoder);

  // ---- URLSearchParams / URL (WHATWG subset) ----
  function encForm(s) {
    return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }
  function decForm(s) {
    var t = s.replace(/\+/g, ' ');
    try { return decodeURIComponent(t); } catch (e) { return t; }
  }
  var SP_LINK = new WeakMap();
  var SP_LIST = new WeakMap();
  function parsePairs(str) {
    var list = [];
    var s = str.charAt(0) === '?' ? str.slice(1) : str;
    if (s === '') return list;
    var parts = s.split('&');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '') continue;
      var eq = parts[i].indexOf('=');
      var k = eq === -1 ? parts[i] : parts[i].slice(0, eq);
      var v = eq === -1 ? '' : parts[i].slice(eq + 1);
      list.push([decForm(k), decForm(v)]);
    }
    return list;
  }
  function spChanged(sp) {
    var link = SP_LINK.get(sp);
    if (link) link(sp.toString());
  }
  class URLSearchParams {
    constructor(init) {
      var list = [];
      SP_LIST.set(this, list);
      if (init === undefined || init === null) return;
      if (typeof init === 'string') {
        var parsed = parsePairs(init);
        for (var i = 0; i < parsed.length; i++) list.push(parsed[i]);
      } else if (init instanceof URLSearchParams) {
        var src = SP_LIST.get(init);
        for (var j = 0; j < src.length; j++) list.push([src[j][0], src[j][1]]);
      } else if (typeof init === 'object' && typeof init[Symbol.iterator] === 'function') {
        for (var pair of init) {
          var arr = Array.from(pair);
          if (arr.length !== 2) throw new TypeError('Each query pair must be an iterable [name, value] tuple');
          list.push([String(arr[0]), String(arr[1])]);
        }
      } else if (typeof init === 'object') {
        var keys = Object.keys(init);
        for (var k = 0; k < keys.length; k++) list.push([keys[k], String(init[keys[k]])]);
      } else {
        var p2 = parsePairs(String(init));
        for (var m = 0; m < p2.length; m++) list.push(p2[m]);
      }
    }
    get size() { return SP_LIST.get(this).length; }
    append(name, value) { SP_LIST.get(this).push([String(name), String(value)]); spChanged(this); }
    delete(name) {
      var l = SP_LIST.get(this);
      var n = String(name);
      for (var i = l.length - 1; i >= 0; i--) if (l[i][0] === n) l.splice(i, 1);
      spChanged(this);
    }
    get(name) {
      var l = SP_LIST.get(this);
      var n = String(name);
      for (var i = 0; i < l.length; i++) if (l[i][0] === n) return l[i][1];
      return null;
    }
    getAll(name) {
      var l = SP_LIST.get(this);
      var n = String(name);
      var out = [];
      for (var i = 0; i < l.length; i++) if (l[i][0] === n) out.push(l[i][1]);
      return out;
    }
    has(name) { return this.get(name) !== null; }
    set(name, value) {
      var l = SP_LIST.get(this);
      var n = String(name);
      var v = String(value);
      var found = false;
      for (var i = 0; i < l.length; i++) {
        if (l[i][0] !== n) continue;
        if (!found) { l[i][1] = v; found = true; } else { l.splice(i, 1); i--; }
      }
      if (!found) l.push([n, v]);
      spChanged(this);
    }
    sort() {
      var l = SP_LIST.get(this);
      l.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
      spChanged(this);
    }
    forEach(cb, thisArg) {
      var l = SP_LIST.get(this).slice();
      for (var i = 0; i < l.length; i++) cb.call(thisArg, l[i][1], l[i][0], this);
    }
    keys() { return SP_LIST.get(this).map(function (p) { return p[0]; })[Symbol.iterator](); }
    values() { return SP_LIST.get(this).map(function (p) { return p[1]; })[Symbol.iterator](); }
    entries() { return SP_LIST.get(this).map(function (p) { return [p[0], p[1]]; })[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() {
      return SP_LIST.get(this).map(function (p) { return encForm(p[0]) + '=' + encForm(p[1]); }).join('&');
    }
  }
  def('URLSearchParams', URLSearchParams);

  var SPECIAL = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21', 'file:': '' };
  var URL_RE = /^([A-Za-z][A-Za-z0-9+.\-]*:)(?:\/\/([^\/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/;
  function normalizePath(path) {
    var out = [];
    var segs = path.split('/');
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s === '..') { if (out.length > 1) out.pop(); }
      else if (s !== '.') out.push(s);
    }
    var last = segs[segs.length - 1];
    if (last === '.' || last === '..') out.push('');
    var joined = out.join('/');
    return joined.charAt(0) === '/' ? joined : '/' + joined;
  }
  function resolveAgainst(input, base) {
    var b = URL_RE.exec(base);
    if (!b || (SPECIAL[b[1].toLowerCase()] !== undefined && b[2] === undefined)) throw new TypeError('Invalid URL');
    var origin = b[1] + (b[2] !== undefined ? '//' + b[2] : '');
    var bpath = b[3] || '/';
    if (input.slice(0, 2) === '//') return b[1] + input;
    if (input.charAt(0) === '/') return origin + normalizePath(input.split(/[?#]/)[0]) + input.slice(input.split(/[?#]/)[0].length);
    if (input.charAt(0) === '?') return origin + bpath + input;
    if (input.charAt(0) === '#') return origin + bpath + (b[4] || '') + input;
    if (input === '') return origin + bpath + (b[4] || '');
    var rel = input.split(/[?#]/)[0];
    var dir = bpath.slice(0, bpath.lastIndexOf('/') + 1);
    return origin + normalizePath(dir + rel) + input.slice(rel.length);
  }
  class URL {
    #p = {};
    #sp;
    constructor(input, base) {
      var str = String(input);
      var m = URL_RE.exec(str);
      if (!m) {
        if (base === undefined) throw new TypeError('Invalid URL');
        m = URL_RE.exec(resolveAgainst(str, String(base)));
        if (!m) throw new TypeError('Invalid URL');
      }
      var protocol = m[1].toLowerCase();
      var special = SPECIAL[protocol] !== undefined;
      if (special && m[2] === undefined) throw new TypeError('Invalid URL');
      var p = this.#p;
      p.protocol = protocol;
      p.username = '';
      p.password = '';
      p.hostname = '';
      p.port = '';
      if (m[2] !== undefined) {
        var auth = m[2];
        var at = auth.lastIndexOf('@');
        if (at !== -1) {
          var ui = auth.slice(0, at);
          auth = auth.slice(at + 1);
          var colon = ui.indexOf(':');
          p.username = colon === -1 ? ui : ui.slice(0, colon);
          p.password = colon === -1 ? '' : ui.slice(colon + 1);
        }
        var pm = /:(\d*)$/.exec(auth);
        if (pm) {
          var portNum = pm[1];
          auth = auth.slice(0, auth.length - pm[0].length);
          p.port = portNum === SPECIAL[protocol] ? '' : portNum;
        }
        p.hostname = auth.toLowerCase();
        if (special && p.hostname === '') throw new TypeError('Invalid URL');
      }
      var path = m[3] || '';
      p.pathname = special ? (path === '' ? '/' : path) : path;
      p.search = m[4] && m[4] !== '?' ? m[4] : '';
      p.hash = m[5] && m[5] !== '#' ? m[5] : '';
      this.#sp = new URLSearchParams(p.search);
      SP_LINK.set(this.#sp, function (s) { p.search = s ? '?' + s : ''; });
    }
    get protocol() { return this.#p.protocol; }
    get username() { return this.#p.username; }
    get password() { return this.#p.password; }
    get hostname() { return this.#p.hostname; }
    get port() { return this.#p.port; }
    get host() { return this.#p.hostname + (this.#p.port ? ':' + this.#p.port : ''); }
    get origin() { return SPECIAL[this.#p.protocol] !== undefined ? this.#p.protocol + '//' + this.host : 'null'; }
    get pathname() { return this.#p.pathname; }
    set pathname(v) { var s = String(v); this.#p.pathname = s.charAt(0) === '/' ? s : '/' + s; }
    get search() { return this.#p.search; }
    set search(v) {
      var s = String(v);
      this.#p.search = s === '' || s === '?' ? '' : (s.charAt(0) === '?' ? s : '?' + s);
      var fresh = parsePairs(this.#p.search);
      var list = SP_LIST.get(this.#sp);
      list.length = 0;
      for (var i = 0; i < fresh.length; i++) list.push(fresh[i]);
    }
    get hash() { return this.#p.hash; }
    set hash(v) { var s = String(v); this.#p.hash = s === '' || s === '#' ? '' : (s.charAt(0) === '#' ? s : '#' + s); }
    get searchParams() { return this.#sp; }
    get href() {
      var p = this.#p;
      var userinfo = p.username ? p.username + (p.password ? ':' + p.password : '') + '@' : '';
      var authority = p.hostname !== '' || SPECIAL[p.protocol] !== undefined ? '//' + userinfo + this.host : '';
      return p.protocol + authority + p.pathname + p.search + p.hash;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }
  def('URL', URL);

  def('queueMicrotask', function queueMicrotask(fn) {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    Promise.resolve().then(fn);
  });
})();
`;
