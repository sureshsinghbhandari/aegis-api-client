/**
 * Guest-side prelude, part 3b: script libraries. `require()` + the lazily loaded globals (`_`, `CryptoJS`,
 * `moment`, `tv4`, `xml2Json`, `Buffer`), the JSON-schema validator used by `pm.response.to.have.jsonSchema`,
 * `pm.visualizer` (Handlebars) and the `auth` helper of `pm.sendRequest`.
 * Bundled libraries are evaluated by the host on first use (host.requireLib) and only ever receive the
 * `cryptoShim` below; they cannot reach `host`. No backticks / dollar-brace sequences in this file (String.raw).
 */
export const GUEST_LIBS: string = String.raw`
// ---------------------------------------------------------------- library loader
const $Uint8Array = Uint8Array;
const $TextEncoder = G.TextEncoder;
const $TextDecoder = G.TextDecoder;
const $btoa = G.btoa;
const $atob = G.atob;
const MAX_VISUALIZER_CHARS = 2 * 1024 * 1024;
const cryptoShim = Object.freeze({
  getRandomValues(array) {
    if (!ArrayBuffer.isView(array)) throw new TypeError('getRandomValues() expects a typed array');
    const bytes = new $Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const hex = host.randomBytes(bytes.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return array;
  },
});
const libCache = {};
const libLoading = {};
function loadLib(name) {
  if (Object.prototype.hasOwnProperty.call(libCache, name)) return libCache[name];
  if (libLoading[name]) throw new Error('The "' + name + '" library is already being loaded');
  libLoading[name] = true;
  try {
    const factory = host.requireLib(name);
    const mod = factory(cryptoShim);
    libCache[name] = mod;
    return mod;
  } finally {
    libLoading[name] = false;
  }
}

// ---------------------------------------------------------------- Buffer (subset)
function normEncoding(enc) {
  const e = enc === undefined || enc === null ? 'utf8' : String(enc).toLowerCase();
  if (e === 'utf-8') return 'utf8';
  if (e === 'binary') return 'latin1';
  if (e === 'ucs2' || e === 'ucs-2' || e === 'utf-16le') return 'utf16le';
  if (['utf8', 'hex', 'base64', 'base64url', 'latin1', 'ascii', 'utf16le'].indexOf(e) === -1) throw new TypeError('Unknown encoding: ' + String(enc));
  return e;
}
function bytesFromString(str, enc) {
  const s = String(str);
  const e = normEncoding(enc);
  if (e === 'utf8') return new $TextEncoder().encode(s);
  if (e === 'hex') {
    const n = Math.floor(s.length / 2);
    const out = new $Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = parseInt(s.substr(i * 2, 2), 16);
      if (isNaN(v)) return out.subarray(0, i);
      out[i] = v;
    }
    return out;
  }
  if (e === 'base64' || e === 'base64url') {
    let b = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
    while (b.length % 4 !== 0) b += '=';
    const bin = $atob(b);
    const out = new $Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (e === 'utf16le') {
    const out = new $Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i * 2] = c & 255; out[i * 2 + 1] = c >> 8; }
    return out;
  }
  // latin1 / ascii
  const out = new $Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & (e === 'ascii' ? 127 : 255);
  return out;
}
function stringFromBytes(bytes, enc) {
  const e = normEncoding(enc);
  if (e === 'utf8') return new $TextDecoder().decode(bytes);
  if (e === 'hex') { let s = ''; for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }
  if (e === 'base64' || e === 'base64url') {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = $btoa(bin);
    return e === 'base64' ? b64 : b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  if (e === 'utf16le') { let s = ''; for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8)); return s; }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(e === 'ascii' ? bytes[i] & 127 : bytes[i]);
  return s;
}
class Buffer extends $Uint8Array {
  static from(value, encodingOrOffset, length) {
    if (typeof value === 'string') return wrapBuffer(bytesFromString(value, encodingOrOffset));
    if (value instanceof ArrayBuffer) return wrapBuffer(new $Uint8Array(value, encodingOrOffset || 0, length === undefined ? undefined : length), true);
    if (ArrayBuffer.isView(value)) return wrapBuffer(new $Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (value && typeof value === 'object' && value.type === 'Buffer' && $isArray(value.data)) return wrapBuffer(new $Uint8Array(value.data));
    if ($isArray(value) || (value && typeof value.length === 'number')) return wrapBuffer(new $Uint8Array(Array.from(value, function (x) { return Number(x) & 255; })));
    throw new TypeError('The first argument must be of type string, Buffer, ArrayBuffer, Array or Array-like Object');
  }
  static alloc(size, fill, encoding) {
    const b = wrapBuffer(new $Uint8Array(checkSize(size)));
    if (fill !== undefined && fill !== 0) b.fill(fill, 0, b.length, encoding);
    return b;
  }
  static allocUnsafe(size) { return wrapBuffer(new $Uint8Array(checkSize(size))); }
  static isBuffer(v) { return v instanceof Buffer; }
  static isEncoding(enc) { try { normEncoding(enc); return true; } catch (e) { return false; } }
  static byteLength(value, encoding) {
    if (typeof value === 'string') return bytesFromString(value, encoding).length;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength;
    throw new TypeError('The "string" argument must be of type string or an ArrayBuffer-like object');
  }
  static concat(list, totalLength) {
    if (!$isArray(list)) throw new TypeError('The "list" argument must be an Array of Buffers');
    const bufs = list.map(function (b) { return Buffer.isBuffer(b) ? b : Buffer.from(b); });
    const total = totalLength === undefined ? bufs.reduce(function (n, b) { return n + b.length; }, 0) : checkSize(totalLength);
    const out = Buffer.alloc(total);
    let pos = 0;
    for (const b of bufs) { if (pos >= total) break; out.set(b.subarray(0, Math.min(b.length, total - pos)), pos); pos += b.length; }
    return out;
  }
  static compare(a, b) { return a.compare(b); }
  toString(encoding, start, end) {
    const s = start === undefined ? 0 : Math.max(0, Number(start) | 0);
    const e = end === undefined ? this.length : Math.min(this.length, Number(end) | 0);
    return stringFromBytes(s === 0 && e === this.length ? this : this.subarray(s, e), encoding);
  }
  toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
  equals(other) {
    if (!(other instanceof $Uint8Array)) throw new TypeError('The "otherBuffer" argument must be an instance of Buffer or Uint8Array');
    if (other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }
  compare(other) {
    const n = Math.min(this.length, other.length);
    for (let i = 0; i < n; i++) if (this[i] !== other[i]) return this[i] < other[i] ? -1 : 1;
    return this.length === other.length ? 0 : this.length < other.length ? -1 : 1;
  }
  slice(start, end) { return this.subarray(start, end); }
  subarray(start, end) { return wrapBuffer($Uint8Array.prototype.subarray.call(this, start, end)); }
  write(string, offset, length, encoding) {
    if (typeof offset === 'string') { encoding = offset; offset = 0; length = undefined; }
    else if (typeof length === 'string') { encoding = length; length = undefined; }
    const bytes = bytesFromString(string, encoding);
    const off = offset === undefined ? 0 : Number(offset) | 0;
    const n = Math.min(bytes.length, length === undefined ? this.length - off : Number(length) | 0, this.length - off);
    this.set(bytes.subarray(0, Math.max(0, n)), off);
    return Math.max(0, n);
  }
  fill(value, offset, end, encoding) {
    if (typeof offset === 'string') { encoding = offset; offset = 0; end = this.length; }
    const s = offset === undefined ? 0 : Number(offset) | 0;
    const e = end === undefined ? this.length : Number(end) | 0;
    if (typeof value === 'number') { $Uint8Array.prototype.fill.call(this, value & 255, s, e); return this; }
    const pattern = typeof value === 'string' ? bytesFromString(value, encoding) : new $Uint8Array(value);
    if (pattern.length === 0) { $Uint8Array.prototype.fill.call(this, 0, s, e); return this; }
    for (let i = s, j = 0; i < e; i++, j = (j + 1) % pattern.length) this[i] = pattern[j];
    return this;
  }
  readUInt8(o) { return this[checkOffset(this, o, 1)]; }
  readUInt16BE(o) { const i = checkOffset(this, o, 2); return (this[i] << 8) | this[i + 1]; }
  readUInt16LE(o) { const i = checkOffset(this, o, 2); return this[i] | (this[i + 1] << 8); }
  readUInt32BE(o) { const i = checkOffset(this, o, 4); return ((this[i] << 24) >>> 0) + ((this[i + 1] << 16) | (this[i + 2] << 8) | this[i + 3]); }
  readUInt32LE(o) { const i = checkOffset(this, o, 4); return (this[i] | (this[i + 1] << 8) | (this[i + 2] << 16)) + this[i + 3] * 0x1000000; }
  readInt8(o) { const v = this.readUInt8(o); return v & 0x80 ? v - 0x100 : v; }
  readInt16BE(o) { const v = this.readUInt16BE(o); return v & 0x8000 ? v - 0x10000 : v; }
  readInt16LE(o) { const v = this.readUInt16LE(o); return v & 0x8000 ? v - 0x10000 : v; }
  readInt32BE(o) { const i = checkOffset(this, o, 4); return (this[i] << 24) | (this[i + 1] << 16) | (this[i + 2] << 8) | this[i + 3]; }
  readInt32LE(o) { const i = checkOffset(this, o, 4); return this[i] | (this[i + 1] << 8) | (this[i + 2] << 16) | (this[i + 3] << 24); }
  writeUInt8(v, o) { const i = checkOffset(this, o, 1); this[i] = v & 255; return i + 1; }
  writeUInt16BE(v, o) { const i = checkOffset(this, o, 2); this[i] = (v >>> 8) & 255; this[i + 1] = v & 255; return i + 2; }
  writeUInt16LE(v, o) { const i = checkOffset(this, o, 2); this[i] = v & 255; this[i + 1] = (v >>> 8) & 255; return i + 2; }
  writeUInt32BE(v, o) { const i = checkOffset(this, o, 4); this[i] = (v >>> 24) & 255; this[i + 1] = (v >>> 16) & 255; this[i + 2] = (v >>> 8) & 255; this[i + 3] = v & 255; return i + 4; }
  writeUInt32LE(v, o) { const i = checkOffset(this, o, 4); this[i] = v & 255; this[i + 1] = (v >>> 8) & 255; this[i + 2] = (v >>> 16) & 255; this[i + 3] = (v >>> 24) & 255; return i + 4; }
  indexOf(value, byteOffset, encoding) {
    const needle = typeof value === 'number' ? new $Uint8Array([value & 255]) : typeof value === 'string' ? bytesFromString(value, encoding) : new $Uint8Array(value);
    const start = byteOffset === undefined ? 0 : Math.max(0, Number(byteOffset) | 0);
    if (needle.length === 0) return Math.min(start, this.length);
    outer: for (let i = start; i + needle.length <= this.length; i++) {
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }
  includes(value, byteOffset, encoding) { return this.indexOf(value, byteOffset, encoding) !== -1; }
  get [Symbol.toStringTag]() { return 'Uint8Array'; }
}
Buffer.poolSize = 8192;
function checkSize(size) {
  const n = Number(size);
  if (!(n >= 0) || n > 64 * 1024 * 1024 || Math.floor(n) !== n) throw new RangeError('The value of "size" is out of range. It must be an integer between 0 and 67108864.');
  return n;
}
function checkOffset(buf, offset, width) {
  const o = offset === undefined ? 0 : Number(offset);
  if (!(o >= 0) || Math.floor(o) !== o || o + width > buf.length) throw new RangeError('The value of "offset" is out of range.');
  return o;
}
function wrapBuffer(view) {
  return Object.setPrototypeOf(view, Buffer.prototype);
}

// ---------------------------------------------------------------- csv-parse (sync subset)
function csvParse(inputText, options) {
  const o = options && typeof options === 'object' ? options : {};
  const delimiter = o.delimiter === undefined ? ',' : String(o.delimiter);
  const quote = o.quote === undefined ? '"' : o.quote === false || o.quote === null ? '' : String(o.quote);
  const escape = o.escape === undefined ? quote : o.escape === false || o.escape === null ? '' : String(o.escape);
  const comment = o.comment === undefined ? '' : String(o.comment);
  const trim = !!o.trim;
  const ltrim = trim || !!o.ltrim;
  const rtrim = trim || !!o.rtrim;
  const skipEmpty = !!o.skip_empty_lines || !!o.skipEmptyLines;
  const relaxCount = !!o.relax_column_count || !!o.relaxColumnCount;
  const fromLine = o.from_line === undefined ? 1 : Number(o.from_line);
  const toLine = o.to_line === undefined ? Infinity : Number(o.to_line);
  const cast = o.cast;
  let text = inputText instanceof $Uint8Array ? stringFromBytes(inputText, 'utf8') : String(inputText);
  if (o.bom !== false && text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  let line = 1;
  let lineStart = true;
  function endField() {
    let v = field;
    if (!wasQuoted) { if (ltrim) v = v.replace(/^\s+/, ''); if (rtrim) v = v.replace(/\s+$/, ''); }
    row.push(v);
    field = '';
    wasQuoted = false;
  }
  function endRow() {
    endField();
    const empty = row.length === 1 && row[0] === '';
    if (!(skipEmpty && empty)) rows.push({ line: line, cells: row });
    row = [];
    line++;
    lineStart = true;
  }
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (escape && c === escape && text[i + 1] === quote) { field += quote; i += 2; continue; }
      if (c === quote) { quoted = false; i++; continue; }
      if (c === '\n') line++;
      field += c;
      i++;
      continue;
    }
    if (lineStart && comment && c === comment && field === '' && row.length === 0) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      line++;
      continue;
    }
    lineStart = false;
    if (quote && c === quote && field.replace(/\s/g, '') === '') { quoted = true; wasQuoted = true; field = ''; i++; continue; }
    if (text.startsWith(delimiter, i)) { endField(); i += delimiter.length; continue; }
    if (c === '\r' && text[i + 1] === '\n') { endRow(); i += 2; continue; }
    if (c === '\n' || c === '\r') { endRow(); i++; continue; }
    field += c;
    i++;
  }
  if (quoted) throw new Error('Invalid closing quote: the quoted field is not terminated (line ' + line + ')');
  if (field !== '' || row.length > 0 || wasQuoted) endRow();

  const selected = rows.filter(function (r) { return r.line >= fromLine && r.line <= toLine; });
  let columns = null;
  let records = selected;
  if (o.columns === true) {
    if (records.length === 0) return [];
    columns = records[0].cells.map(String);
    records = records.slice(1);
  } else if ($isArray(o.columns)) {
    columns = o.columns.map(function (c) { return c && typeof c === 'object' ? c.name : c; });
  }
  const width = columns ? columns.length : records.length ? records[0].cells.length : 0;
  return records.map(function (r, idx) {
    if (!relaxCount && r.cells.length !== width) {
      throw new Error('Invalid Record Length: expect ' + width + ', got ' + r.cells.length + ' on line ' + r.line);
    }
    const cells = typeof cast === 'function' ? r.cells.map(function (v, col) { return cast(v, { lines: r.line, column: columns ? columns[col] : col, index: col, records: idx, header: false, quoting: false }); }) : r.cells;
    if (!columns) return cells;
    const rec = {};
    for (let c = 0; c < columns.length; c++) if (columns[c] !== undefined && columns[c] !== null && columns[c] !== false) setOwn(rec, String(columns[c]), c < cells.length ? cells[c] : undefined);
    return rec;
  });
}

// ---------------------------------------------------------------- xml2Json / xml2js (fast-xml-parser facade)
function xmlParserOptions(opts) {
  const o = opts || {};
  const explicitArray = o.explicitArray === undefined ? false : !!o.explicitArray;
  const options = {
    ignoreAttributes: !!o.ignoreAttrs,
    attributesGroupName: o.attrkey === undefined ? '$' : String(o.attrkey),
    attributeNamePrefix: '',
    textNodeName: o.charkey === undefined ? '_' : String(o.charkey),
    trimValues: o.trim === undefined ? true : !!o.trim,
    parseTagValue: false,
    parseAttributeValue: false,
    allowBooleanAttributes: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    processEntities: true,
    htmlEntities: true, // also enables numeric character references (&#65;), like xml2js
  };
  // fast-xml-parser merges options with Object.assign: an explicit undefined would clobber its defaults.
  if (explicitArray) options.isArray = function (name, jpath, isLeaf, isAttr) { return !isAttr; };
  if (o.normalizeTags) options.transformTagName = function (n) { return String(n).toLowerCase(); };
  return options;
}
function parseXml(xml, opts) {
  const lib = loadLib('xml');
  const text = typeof xml === 'string' ? xml : xml instanceof $Uint8Array ? stringFromBytes(xml, 'utf8') : toStr(xml);
  const o = opts || {};
  // xml2js rejects malformed documents; fast-xml-parser is lenient, so validate first.
  const valid = lib.XMLValidator.validate(text, { allowBooleanAttributes: true });
  if (valid !== true) throw new Error('Invalid XML: ' + (valid && valid.err ? valid.err.msg + ' (line ' + valid.err.line + ')' : 'malformed document'));
  const out = new lib.XMLParser(xmlParserOptions(o)).parse(text);
  if (o.explicitArray) {
    // xml2js never wraps the root element itself.
    for (const k of $keys(out)) if ($isArray(out[k]) && out[k].length === 1) out[k] = out[k][0];
  }
  if (o.explicitRoot === false) {
    const keys = $keys(out);
    return keys.length === 1 ? out[keys[0]] : out;
  }
  return out;
}
function xml2Json(xml) {
  return parseXml(xml, { explicitArray: false });
}
function xml2jsModule() {
  function parseString(xml, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    let result;
    try { result = parseXml(xml, Object.assign({ explicitArray: true }, opts || {})); } catch (e) {
      if (typeof cb === 'function') { cb(e); return; }
      throw e;
    }
    if (typeof cb === 'function') cb(null, result);
  }
  function parseStringPromise(xml, opts) {
    return new Promise(function (resolve, reject) { parseString(xml, opts, function (err, res) { if (err) reject(err); else resolve(res); }); });
  }
  class Parser {
    constructor(opts) { this.options = opts || {}; }
    parseString(xml, cb) { return parseString(xml, this.options, cb); }
    parseStringPromise(xml) { return parseStringPromise(xml, this.options); }
  }
  class Builder {
    constructor(opts) { this.options = opts || {}; }
    buildObject(obj) {
      const lib = loadLib('xml');
      const o = this.options;
      return new lib.XMLBuilder({ ignoreAttributes: false, attributesGroupName: o.attrkey === undefined ? '$' : String(o.attrkey), attributeNamePrefix: '', textNodeName: o.charkey === undefined ? '_' : String(o.charkey), format: !!(o.renderOpts && o.renderOpts.pretty) }).build(obj);
    }
  }
  return { parseString: parseString, parseStringPromise: parseStringPromise, Parser: Parser, Builder: Builder };
}

// ---------------------------------------------------------------- JSON schema (ajv draft-06/07, tv4 for draft-04)
const RE_DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
const RE_TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
const RE_EMAIL = /^[a-z0-9.!#$%&'*+\/=?^_\x60{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const RE_HOSTNAME = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
const RE_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const RE_URI = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i;
const RE_URI_REF = /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\s]*)?$/i;
const RE_UUID = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const RE_JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
const RE_REL_JSON_POINTER = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
const RE_BYTE = /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/;
function isValidDate(s) {
  const m = RE_DATE.exec(s);
  if (!m) return false;
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1];
}
function isValidTime(s, requireTz) {
  const m = RE_TIME.exec(s);
  if (!m) return false;
  const h = +m[1]; const mi = +m[2]; const sec = parseFloat(m[3]);
  if (h > 23 || mi > 59 || sec >= 61) return false;
  if (requireTz && !m[4]) return false;
  if (m[5] && (+m[6] > 23 || (m[7] !== undefined && +m[7] > 59))) return false;
  return true;
}
function isValidDateTime(s) {
  const parts = String(s).split(/[tT\s]/);
  return parts.length === 2 && isValidDate(parts[0]) && isValidTime(parts[1], true);
}
function isValidIpv6(s) {
  if (typeof s !== 'string' || s.length > 45) return false;
  let str = s;
  const v4 = /:(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (v4) { if (!RE_IPV4.test(v4[1])) return false; str = str.slice(0, v4.index) + ':0:0'; }
  const halves = str.split('::');
  if (halves.length > 2) return false;
  const groups = halves.map(function (h) { return h === '' ? [] : h.split(':'); });
  const all = groups[0].concat(groups.length === 2 ? groups[1] : []);
  if (!all.every(function (g) { return /^[0-9a-f]{1,4}$/i.test(g); })) return false;
  return halves.length === 2 ? all.length < 8 : all.length === 8;
}
function isValidRegex(s) { try { new RegExp(s); return true; } catch (e) { return false; } }
const STRING_FORMATS = {
  'date': isValidDate,
  'time': function (s) { return isValidTime(s, true); },
  'date-time': isValidDateTime,
  'iso-time': function (s) { return isValidTime(s, false); },
  'iso-date-time': function (s) { const p = String(s).split(/[tT\s]/); return p.length === 2 && isValidDate(p[0]) && isValidTime(p[1], false); },
  'duration': function (s) { return /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/.test(s); },
  'email': function (s) { return RE_EMAIL.test(s); },
  'hostname': function (s) { return RE_HOSTNAME.test(s); },
  'ipv4': function (s) { return RE_IPV4.test(s); },
  'ipv6': isValidIpv6,
  'uri': function (s) { return RE_URI.test(s); },
  'uri-reference': function (s) { return RE_URI_REF.test(s); },
  'uri-template': function (s) { return /^(?:(?:[^\x00-\x20"'<>%\\^\x60{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i.test(s); },
  'url': function (s) { return RE_URI.test(s) && /^[a-z][a-z0-9+\-.]*:\/\//i.test(s); },
  'uuid': function (s) { return RE_UUID.test(s); },
  'regex': isValidRegex,
  'json-pointer': function (s) { return RE_JSON_POINTER.test(s); },
  'relative-json-pointer': function (s) { return RE_REL_JSON_POINTER.test(s); },
  'byte': function (s) { return RE_BYTE.test(s); },
  'binary': function () { return true; },
  'password': function () { return true; },
};
const NUMBER_FORMATS = {
  'int32': function (n) { return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647; },
  'int64': function (n) { return Number.isInteger(n); },
  'float': function (n) { return typeof n === 'number'; },
  'double': function (n) { return typeof n === 'number'; },
};
function registerAjvFormats(ajv) {
  for (const name of $keys(STRING_FORMATS)) ajv.addFormat(name, { type: 'string', validate: STRING_FORMATS[name] });
  for (const name of $keys(NUMBER_FORMATS)) ajv.addFormat(name, { type: 'number', validate: NUMBER_FORMATS[name] });
}
let ajvClass = null;
/** require('ajv'): ajv 8 with the draft-06 meta-schema and the formats above pre-registered (Postman's ajv 6 had built-in formats). */
function ajvWithFormats() {
  if (ajvClass) return ajvClass;
  const lib = loadLib('ajv');
  class Ajv extends lib.Ajv {
    constructor(options) {
      super(options);
      try { this.addMetaSchema(lib.draft06); } catch (e) { /* already present */ }
      registerAjvFormats(this);
    }
  }
  Ajv.default = Ajv;
  ajvClass = Ajv;
  return Ajv;
}
function tv4WithFormats() {
  const tv4 = loadLib('tv4');
  if (!tv4.__aegisFormats) {
    tv4.__aegisFormats = true;
    for (const name of $keys(STRING_FORMATS)) {
      tv4.addFormat(name, function (data) { return typeof data !== 'string' || STRING_FORMATS[name](data) ? null : 'must match format "' + name + '"'; });
    }
    for (const name of $keys(NUMBER_FORMATS)) {
      tv4.addFormat(name, function (data) { return typeof data !== 'number' || NUMBER_FORMATS[name](data) ? null : 'must match format "' + name + '"'; });
    }
  }
  return tv4;
}
function pointerToPath(p) {
  return '$' + String(p || '').replace(/\/([^/]*)/g, function (whole, seg) {
    const s = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    return /^\d+$/.test(s) ? '[' + s + ']' : '.' + s;
  });
}
/** Returns a list of human-readable violations (empty when valid). Throws for invalid schemas. */
function validateJsonSchema(data, schema, options) {
  if (schema === null || typeof schema !== 'object' || $isArray(schema)) throw new TypeError('jsonSchema() expects a JSON schema object');
  const id = typeof schema.$schema === 'string' ? schema.$schema : '';
  if (/draft-0?4\b/.test(id)) {
    const tv4 = tv4WithFormats();
    const res = tv4.validateMultiple(data, schema, false, false);
    if (res.missing && res.missing.length) throw new Error('Invalid JSON schema: unresolved $ref ' + res.missing.join(', '));
    return res.valid ? [] : res.errors.map(function (e) { return pointerToPath(e.dataPath) + ' ' + e.message; });
  }
  const Ajv = ajvWithFormats();
  const opts = Object.assign({ allErrors: true, strict: false, validateFormats: true, logger: false }, options && typeof options === 'object' ? options : {});
  const ajv = new Ajv(opts);
  let validate;
  try { validate = ajv.compile(schema); } catch (e) { throw new Error('Invalid JSON schema: ' + (e && e.message ? e.message : String(e))); }
  if (validate(data)) return [];
  return (validate.errors || []).map(function (e) {
    let msg = pointerToPath(e.instancePath) + ' ' + e.message;
    if (e.params && e.params.additionalProperty !== undefined) msg += ' ("' + e.params.additionalProperty + '")';
    if (e.params && e.params.allowedValues !== undefined) msg += ' ' + show(e.params.allowedValues);
    return msg;
  });
}

// ---------------------------------------------------------------- require()
const MODULES = {
  'lodash': function () { return loadLib('lodash'); },
  'moment': function () { return loadLib('moment'); },
  'crypto-js': function () { return loadLib('crypto-js'); },
  'uuid': function () { return loadLib('uuid'); },
  'ajv': function () { return ajvWithFormats(); },
  'tv4': function () { return tv4WithFormats(); },
  'xml2js': function () { return xml2jsModule(); },
  'chai': function () { return chai; },
  'atob': function () { return $atob; },
  'btoa': function () { return $btoa; },
  'buffer': function () { return { Buffer: Buffer }; },
  'csv-parse/lib/sync': function () { return csvParse; },
  'csv-parse/sync': function () { return { parse: csvParse }; },
};
const NOT_AVAILABLE = ['cheerio', 'postman-collection', 'assert', 'events', 'path', 'punycode', 'querystring', 'stream', 'string_decoder', 'timers', 'tty', 'url', 'util'];
const moduleCache = {};
function requireModule(name) {
  const id = String(name);
  if (Object.prototype.hasOwnProperty.call(MODULES, id)) {
    if (!Object.prototype.hasOwnProperty.call(moduleCache, id)) moduleCache[id] = MODULES[id]();
    return moduleCache[id];
  }
  if (NOT_AVAILABLE.indexOf(id) !== -1) {
    throw new Error("Module '" + id + "' is not available in the Aegis script sandbox (see docs/features/scripting.md). Available: " + $keys(MODULES).join(', '));
  }
  const err = new Error("Cannot find module '" + id + "'. The Aegis script sandbox provides only: " + $keys(MODULES).join(', ') + '.');
  err.code = 'MODULE_NOT_FOUND';
  throw err;
}
requireModule.resolve = function resolve(name) { requireModule(name); return String(name); };
function lazyGlobal(name, loader, libName) {
  $defineProperty(G, name, {
    get() {
      // Re-entrancy guard: libraries read globals while initialising (lodash reads root._ for noConflict);
      // while the library is loading the global reads as undefined and stays lazy.
      if (libName && libLoading[libName]) return undefined;
      $defineProperty(G, name, { value: undefined, writable: true, configurable: true, enumerable: false });
      let value;
      try { value = loader(); } catch (e) { lazyGlobal(name, loader, libName); throw e; }
      $defineProperty(G, name, { value: value, writable: true, configurable: true, enumerable: false });
      return value;
    },
    set(v) { $defineProperty(G, name, { value: v, writable: true, configurable: true, enumerable: false }); },
    configurable: true,
    enumerable: false,
  });
}
$defineProperty(G, 'require', { value: requireModule, writable: true, configurable: true, enumerable: false });
lazyGlobal('_', function () { return loadLib('lodash'); }, 'lodash');
lazyGlobal('CryptoJS', function () { return loadLib('crypto-js'); }, 'crypto-js');
lazyGlobal('moment', function () { return loadLib('moment'); }, 'moment');
lazyGlobal('tv4', function () { return tv4WithFormats(); }, 'tv4');
lazyGlobal('xml2Json', function () { return xml2Json; });
lazyGlobal('Buffer', function () { return Buffer; });
for (const lib of ['cheerio']) {
  $defineProperty(G, lib, {
    get() { throw new Error(lib + ' is not available in the Aegis script sandbox (see docs/features/scripting.md).'); },
    set(v) { $defineProperty(G, lib, { value: v, writable: true, configurable: true, enumerable: false }); },
    configurable: true,
    enumerable: false,
  });
}

// ---------------------------------------------------------------- pm.visualizer (Handlebars)
let visualizerHtml = null;
const pmVisualizer = {
  set(template, data, options) {
    if (typeof template !== 'string') throw new TypeError('pm.visualizer.set() expects a Handlebars template string as its first argument');
    if (template.length > MAX_VISUALIZER_CHARS) throw new RangeError('pm.visualizer.set(): the template exceeds ' + MAX_VISUALIZER_CHARS + ' characters');
    const hb = loadLib('handlebars');
    const compiled = hb.compile(template, options && typeof options === 'object' ? options : undefined);
    const html = String(compiled(data === undefined || data === null ? {} : data));
    if (html.length > MAX_VISUALIZER_CHARS) throw new RangeError('pm.visualizer.set(): the rendered HTML exceeds ' + MAX_VISUALIZER_CHARS + ' characters');
    visualizerHtml = html;
  },
  clear() { visualizerHtml = null; },
};

// ---------------------------------------------------------------- pm.sendRequest auth option
function authParam(auth, type, key) {
  const list = auth[type];
  if ($isArray(list)) {
    for (const it of list) if (it && String(it.key) === key) return it.value === undefined || it.value === null ? '' : toStr(it.value);
  } else if (list && typeof list === 'object' && list[key] !== undefined) {
    return toStr(list[key]);
  }
  return auth[key] === undefined || auth[key] === null ? '' : toStr(auth[key]);
}
function upsertHeader(headers, name, value) {
  const i = headers.findIndex(function (h) { return h.name.toLowerCase() === name.toLowerCase(); });
  if (i === -1) headers.push({ name: name, value: value }); else headers[i] = { name: name, value: value };
}
function applySendRequestAuth(req, auth) {
  if (auth === undefined || auth === null) return;
  if (typeof auth !== 'object') throw new TypeError('pm.sendRequest(): "auth" must be an object');
  const type = String(auth.type || 'noauth').toLowerCase();
  if (type === 'noauth' || type === 'none') return;
  if (type === 'basic') {
    const token = Buffer.from(authParam(auth, type, 'username') + ':' + authParam(auth, type, 'password'), 'utf8').toString('base64');
    upsertHeader(req.headers, 'Authorization', 'Basic ' + token);
  } else if (type === 'bearer') {
    upsertHeader(req.headers, 'Authorization', 'Bearer ' + authParam(auth, type, 'token'));
  } else if (type === 'apikey') {
    const key = authParam(auth, type, 'key');
    const value = authParam(auth, type, 'value');
    if (!key) throw new TypeError('pm.sendRequest(): apikey auth requires a "key"');
    if (authParam(auth, type, 'in') === 'query') {
      req.url += (req.url.indexOf('?') === -1 ? '?' : '&') + encodeURIComponent(key) + '=' + encodeURIComponent(value);
    } else {
      upsertHeader(req.headers, key, value);
    }
  } else {
    throw new TypeError('pm.sendRequest(): unsupported auth type "' + type + '" (supported: basic, bearer, apikey, noauth)');
  }
}
`;
