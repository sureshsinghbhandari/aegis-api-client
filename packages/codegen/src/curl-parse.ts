/**
 * cURL command parser -> `RequestDraft`. Pure TS (no Node APIs), usable by the renderer and the CLI.
 *
 * Supported: `-X/--request`, `-H/--header`, `-d/--data/--data-raw/--data-ascii/--data-binary/--data-urlencode`,
 * `--json`, `-F/--form/--form-string`, `-u/--user`, `--oauth2-bearer`, `--url`, `-k/--insecure` (warning only),
 * `-L/--location`, `--compressed`, `-b/--cookie`, `-A/--user-agent`, `-e/--referer`, `-I/--head`, `-G/--get`,
 * `-m/--max-time`, `--max-redirs`, `--http1.1/--http2`; single/double quotes, `$'...'` ANSI-C quoting, backslash
 * (POSIX), caret (cmd.exe) and backtick (PowerShell) line continuations.
 *
 * Security: file references (`@file`, `-F x=@file`, `-F x=<file`, `--cookie file`, `-T file`) are REJECTED with a
 * warning and never stored; `-k` never disables TLS verification; everything unknown becomes a warning.
 */
import { emptyRequestDraft, extractPathVariableNames, parseQueryString, splitUrl, type FormDataEntry, type KeyValueEntry, type RawLanguage, type RequestDraft } from '@aegis/core';

export interface CurlParseResult {
  draft: RequestDraft;
  warnings: string[];
  /** False when the text could not be recognised as a curl command with a URL. */
  ok: boolean;
}

export const CURL_MAX_INPUT = 1024 * 1024;
const MAX_TOKENS = 10_000;

/** True when the text starts with a curl invocation (optionally after a `$ `/`> ` prompt). */
export function isCurlCommand(text: string): boolean {
  return /^\s*(?:[$>]\s+)?(?:sudo\s+)?curl(?:\.exe)?(?:\s|$)/i.test(text);
}

// ----------------------------------------------------------------------------- tokenizer

interface Tokenized {
  tokens: string[];
  warnings: string[];
}

const CMD_SPECIAL = new Set(['"', '&', '|', '<', '>', '^', '%', '(', ')', '!']);

function ansiEscape(src: string, i: number): { text: string; next: number } {
  // src[i] is the character after the backslash
  const ch = src[i];
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', E: '\x1b', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  if (ch === undefined) return { text: '\\', next: i };
  if (simple[ch] !== undefined) return { text: simple[ch]!, next: i + 1 };
  if (ch === 'x') {
    const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 1, i + 3));
    if (m) return { text: String.fromCharCode(parseInt(m[0], 16)), next: i + 1 + m[0].length };
    return { text: '\\x', next: i + 1 };
  }
  if (ch === 'u' || ch === 'U') {
    const len = ch === 'u' ? 4 : 8;
    const m = new RegExp(`^[0-9a-fA-F]{1,${len}}`).exec(src.slice(i + 1, i + 1 + len));
    if (m) {
      const code = parseInt(m[0], 16);
      return { text: code <= 0x10ffff ? String.fromCodePoint(code) : '�', next: i + 1 + m[0].length };
    }
    return { text: `\\${ch}`, next: i + 1 };
  }
  if (/[0-7]/.test(ch)) {
    const m = /^[0-7]{1,3}/.exec(src.slice(i, i + 3))!;
    return { text: String.fromCharCode(parseInt(m[0], 8) & 0xff), next: i + m[0].length };
  }
  return { text: `\\${ch}`, next: i + 1 };
}

export function tokenizeShell(input: string): Tokenized {
  const src = input.replace(/\r\n?/g, '\n');
  const tokens: string[] = [];
  const warnings: string[] = [];
  let i = 0;
  let cur = '';
  let started = false;

  const flush = () => {
    if (started) tokens.push(cur);
    cur = '';
    started = false;
  };

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      flush();
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === '\n') {
        i += 2; // POSIX line continuation
        continue;
      }
      if (next === undefined) {
        i++;
        continue;
      }
      cur += next;
      started = true;
      i += 2;
      continue;
    }
    if (ch === '^' || ch === '`') {
      const next = src[i + 1];
      if (next === '\n') {
        i += 2; // cmd.exe / PowerShell line continuation
        continue;
      }
      if (ch === '^' && next !== undefined && CMD_SPECIAL.has(next)) {
        cur += next;
        started = true;
        i += 2;
        continue;
      }
      cur += ch;
      started = true;
      i++;
      continue;
    }
    if (ch === "'" || (ch === '$' && src[i + 1] === "'")) {
      const ansi = ch === '$';
      i += ansi ? 2 : 1;
      started = true;
      let closed = false;
      while (i < src.length) {
        const c = src[i]!;
        if (c === "'") {
          closed = true;
          i++;
          break;
        }
        if (ansi && c === '\\') {
          const e = ansiEscape(src, i + 1);
          cur += e.text;
          i = e.next;
          continue;
        }
        cur += c;
        i++;
      }
      if (!closed) warnings.push('Unterminated single quote; the rest of the command was taken literally.');
      continue;
    }
    if (ch === '"' || (ch === '$' && src[i + 1] === '"')) {
      i += ch === '$' ? 2 : 1;
      started = true;
      let closed = false;
      while (i < src.length) {
        const c = src[i]!;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === '\\') {
          const next = src[i + 1];
          if (next === '\n') {
            i += 2;
            continue;
          }
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            cur += next;
            i += 2;
            continue;
          }
          cur += c;
          i++;
          continue;
        }
        cur += c;
        i++;
      }
      if (!closed) warnings.push('Unterminated double quote; the rest of the command was taken literally.');
      continue;
    }
    cur += ch;
    started = true;
    i++;
    if (tokens.length > MAX_TOKENS) break;
  }
  flush();
  if (tokens.length > MAX_TOKENS) {
    warnings.push(`Command has more than ${MAX_TOKENS} arguments; the rest was ignored.`);
    tokens.length = MAX_TOKENS;
  }
  return { tokens, warnings };
}

// ----------------------------------------------------------------------------- option table

type OptId =
  | 'request'
  | 'header'
  | 'data'
  | 'data-raw'
  | 'data-binary'
  | 'data-urlencode'
  | 'json'
  | 'form'
  | 'form-string'
  | 'user'
  | 'oauth2-bearer'
  | 'url'
  | 'insecure'
  | 'location'
  | 'compressed'
  | 'cookie'
  | 'user-agent'
  | 'referer'
  | 'head'
  | 'get'
  | 'max-time'
  | 'max-redirs'
  | 'http1.1'
  | 'http2'
  | 'basic'
  | 'upload-file';

const VALUE_OPTS = new Set<OptId>(['request', 'header', 'data', 'data-raw', 'data-binary', 'data-urlencode', 'json', 'form', 'form-string', 'user', 'oauth2-bearer', 'url', 'cookie', 'user-agent', 'referer', 'max-time', 'max-redirs', 'upload-file']);

const LONG: Record<string, OptId> = {
  request: 'request',
  header: 'header',
  data: 'data',
  'data-ascii': 'data',
  'data-raw': 'data-raw',
  'data-binary': 'data-binary',
  'data-urlencode': 'data-urlencode',
  json: 'json',
  form: 'form',
  'form-string': 'form-string',
  user: 'user',
  'oauth2-bearer': 'oauth2-bearer',
  url: 'url',
  insecure: 'insecure',
  location: 'location',
  compressed: 'compressed',
  cookie: 'cookie',
  'user-agent': 'user-agent',
  referer: 'referer',
  head: 'head',
  get: 'get',
  'max-time': 'max-time',
  'max-redirs': 'max-redirs',
  'http1.1': 'http1.1',
  http2: 'http2',
  'http2-prior-knowledge': 'http2',
  basic: 'basic',
  'upload-file': 'upload-file',
};

const SHORT: Record<string, OptId> = { X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', k: 'insecure', L: 'location', b: 'cookie', A: 'user-agent', e: 'referer', I: 'head', G: 'get', m: 'max-time', T: 'upload-file' };

/** Unsupported options that consume a value (so the value is not mistaken for a URL). */
const UNSUPPORTED_WITH_VALUE_LONG = new Set([
  'abstract-unix-socket', 'alt-svc', 'aws-sigv4', 'cacert', 'capath', 'cert', 'cert-type', 'ciphers', 'config', 'connect-timeout', 'connect-to', 'continue-at', 'cookie-jar', 'crlfile', 'curves', 'delegation', 'dns-interface', 'dns-ipv4-addr', 'dns-ipv6-addr', 'dns-servers', 'doh-url', 'dump-header', 'egd-file', 'engine', 'etag-compare', 'etag-save', 'expect100-timeout', 'ftp-account', 'ftp-alternative-to-user', 'ftp-method', 'ftp-port', 'happy-eyeballs-timeout-ms', 'hostpubmd5', 'hostpubsha256', 'hsts', 'interface', 'keepalive-time', 'key', 'key-type', 'krb', 'libcurl', 'limit-rate', 'local-port', 'login-options', 'mail-auth', 'mail-from', 'mail-rcpt', 'max-filesize', 'netrc-file', 'noproxy', 'output', 'output-dir', 'pass', 'pinnedpubkey', 'proto', 'proto-default', 'proto-redir', 'proxy', 'proxy-cacert', 'proxy-capath', 'proxy-cert', 'proxy-cert-type', 'proxy-ciphers', 'proxy-crlfile', 'proxy-header', 'proxy-key', 'proxy-key-type', 'proxy-pass', 'proxy-pinnedpubkey', 'proxy-service-name', 'proxy-tls13-ciphers', 'proxy-tlsauthtype', 'proxy-tlspassword', 'proxy-tlsuser', 'proxy-user', 'proxy1.0', 'pubkey', 'quote', 'random-file', 'range', 'rate', 'resolve', 'retry', 'retry-delay', 'retry-max-time', 'sasl-authzid', 'service-name', 'socks4', 'socks4a', 'socks5', 'socks5-gssapi-service', 'socks5-hostname', 'speed-limit', 'speed-time', 'stderr', 'telnet-option', 'tftp-blksize', 'time-cond', 'tls-max', 'tls13-ciphers', 'tlsauthtype', 'tlspassword', 'tlsuser', 'trace', 'trace-ascii', 'unix-socket', 'variable', 'write-out',
]);
const UNSUPPORTED_WITH_VALUE_SHORT = new Set(['o', 'w', 'x', 'U', 'E', 'c', 'D', 'r', 'K', 'y', 'Y', 'z', 'C', 't', 'P', 'Q']);

// ----------------------------------------------------------------------------- parser

interface Parsed {
  method?: string;
  url?: string;
  headers: KeyValueEntry[];
  data: Array<{ value: string; kind: 'data' | 'raw' | 'binary' | 'urlencode' | 'json' }>;
  form: FormDataEntry[];
  /** True when any -F/--form was given, even if every part was rejected. */
  formSeen: boolean;
  user?: string;
  bearer?: string;
  get: boolean;
  head: boolean;
  location: boolean;
  compressed: boolean;
  cookies: string[];
  maxTimeMs?: number;
  maxRedirects?: number;
  httpVersion?: '1.1' | '2';
}

function urlencodeValue(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

function parseFormPart(raw: string, literal: boolean, warnings: string[]): FormDataEntry | null {
  const eq = raw.indexOf('=');
  if (eq === -1) {
    warnings.push(`Form field "${raw.slice(0, 60)}" has no "=" and was ignored.`);
    return null;
  }
  const key = raw.slice(0, eq);
  let value = raw.slice(eq + 1);
  let contentType: string | undefined;
  if (!literal) {
    if (value.startsWith('@') || value.startsWith('<')) {
      warnings.push(`Form field "${key}" references a local file; file references are not imported. Pick the file in the Body tab.`);
      return null;
    }
    // `value;type=text/plain;filename=x` - only the type is meaningful for text parts
    const parts = value.split(';');
    if (parts.length > 1) {
      value = parts[0]!;
      for (const p of parts.slice(1)) {
        const m = /^\s*type=(.+)$/i.exec(p);
        if (m) contentType = m[1]!.trim();
      }
    }
  }
  return { key, type: 'text', value, enabled: true, ...(contentType ? { contentType } : {}) };
}

function addHeader(p: Parsed, raw: string, warnings: string[]): void {
  const colon = raw.indexOf(':');
  if (colon === -1) {
    if (raw.endsWith(';')) {
      p.headers.push({ key: raw.slice(0, -1).trim(), value: '', enabled: true });
      return;
    }
    warnings.push(`Header "${raw.slice(0, 60)}" has no ":" and was ignored.`);
    return;
  }
  const key = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (!key) {
    warnings.push(`Header "${raw.slice(0, 60)}" has an empty name and was ignored.`);
    return;
  }
  p.headers.push({ key, value, enabled: true });
}

function rawLanguageFor(contentType: string | undefined, text: string): RawLanguage {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('html')) return 'html';
  if (ct.includes('javascript')) return 'javascript';
  if (!ct || ct.includes('x-www-form-urlencoded') || ct.includes('text/plain')) {
    const t = text.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        JSON.parse(t);
        return 'json';
      } catch {
        /* not JSON */
      }
    }
    if (t.startsWith('<') && t.endsWith('>')) return 'xml';
  }
  return 'text';
}

/** `a=b&c=d` where every pair has a key and no raw whitespace/braces: safe to show as a urlencoded table. */
function looksUrlencoded(text: string): boolean {
  if (!text || /[\s{}[\]"]/.test(text)) return false;
  return text.split('&').every((pair) => pair.length > 0 && pair.indexOf('=') > 0);
}

function applyOption(p: Parsed, id: OptId, value: string | undefined, warnings: string[]): void {
  const v = value ?? '';
  switch (id) {
    case 'request': {
      const m = v.trim().toUpperCase();
      if (/^[A-Z][A-Z0-9_-]*$/.test(m)) p.method = m;
      else warnings.push(`Invalid HTTP method "${v.slice(0, 20)}" was ignored.`);
      return;
    }
    case 'header':
      addHeader(p, v, warnings);
      return;
    case 'data':
    case 'data-binary': {
      if (v.startsWith('@')) {
        warnings.push(`Request body from file "${v.slice(1, 61)}" is not imported; file references are rejected. Paste the content or pick the file in the Body tab.`);
        return;
      }
      p.data.push({ value: v, kind: id === 'data' ? 'data' : 'binary' });
      return;
    }
    case 'data-raw':
      p.data.push({ value: v, kind: 'raw' });
      return;
    case 'json':
      p.data.push({ value: v, kind: 'json' });
      return;
    case 'data-urlencode': {
      // content | =content | name=content | @file | name@file
      const eq = v.indexOf('=');
      const at = v.indexOf('@');
      if (eq === -1 && at !== -1) {
        warnings.push(`--data-urlencode from file "${v.slice(0, 60)}" is not imported; file references are rejected.`);
        return;
      }
      if (eq === -1) {
        p.data.push({ value: urlencodeValue(v), kind: 'urlencode' });
        return;
      }
      if (at !== -1 && at < eq) {
        warnings.push(`--data-urlencode from file "${v.slice(0, 60)}" is not imported; file references are rejected.`);
        return;
      }
      const name = v.slice(0, eq);
      const content = v.slice(eq + 1);
      p.data.push({ value: name ? `${name}=${urlencodeValue(content)}` : urlencodeValue(content), kind: 'urlencode' });
      return;
    }
    case 'form':
    case 'form-string': {
      p.formSeen = true;
      const part = parseFormPart(v, id === 'form-string', warnings);
      if (part) p.form.push(part);
      return;
    }
    case 'user':
      p.user = v;
      return;
    case 'oauth2-bearer':
      p.bearer = v;
      return;
    case 'url':
      if (p.url !== undefined) warnings.push('More than one URL given; only the first one was imported.');
      else p.url = v;
      return;
    case 'insecure':
      warnings.push('-k/--insecure was ignored: TLS certificate verification stays enabled (policy controlled).');
      return;
    case 'location':
      p.location = true;
      return;
    case 'compressed':
      p.compressed = true;
      return;
    case 'cookie':
      if (v.includes('=')) p.cookies.push(v);
      else warnings.push(`Cookie file "${v.slice(0, 60)}" is not imported; file references are rejected.`);
      return;
    case 'user-agent':
      p.headers.push({ key: 'User-Agent', value: v, enabled: true });
      return;
    case 'referer':
      p.headers.push({ key: 'Referer', value: v.replace(/;auto$/, ''), enabled: true });
      return;
    case 'head':
      p.head = true;
      return;
    case 'get':
      p.get = true;
      return;
    case 'max-time': {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) p.maxTimeMs = Math.round(n * 1000);
      else warnings.push(`Invalid --max-time "${v.slice(0, 20)}" was ignored.`);
      return;
    }
    case 'max-redirs': {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0) p.maxRedirects = n;
      else warnings.push(`Invalid --max-redirs "${v.slice(0, 20)}" was ignored.`);
      return;
    }
    case 'http1.1':
      p.httpVersion = '1.1';
      return;
    case 'http2':
      p.httpVersion = '2';
      return;
    case 'basic':
      return;
    case 'upload-file':
      warnings.push(`-T/--upload-file "${v.slice(0, 60)}" is not imported; file references are rejected. Use a binary body and pick the file.`);
      return;
    default:
      return;
  }
}

function parseTokens(tokens: string[], warnings: string[]): Parsed {
  const p: Parsed = { headers: [], data: [], form: [], formSeen: false, get: false, head: false, location: false, compressed: false, cookies: [] };
  let i = 0;
  let endOfOptions = false;
  const takeValue = (): string | undefined => {
    if (i < tokens.length) return tokens[i++];
    return undefined;
  };

  while (i < tokens.length) {
    const tok = tokens[i++]!;
    if (endOfOptions || tok === '-' || !tok.startsWith('-')) {
      if (p.url !== undefined) warnings.push(`Extra argument "${tok.slice(0, 60)}" was ignored (only the first URL is imported).`);
      else p.url = tok;
      continue;
    }
    if (tok === '--') {
      endOfOptions = true;
      continue;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = (eq === -1 ? tok.slice(2) : tok.slice(2, eq)).toLowerCase();
      const inline = eq === -1 ? undefined : tok.slice(eq + 1);
      const id = LONG[name];
      if (id) {
        if (VALUE_OPTS.has(id)) {
          const value = inline ?? takeValue();
          if (value === undefined) {
            warnings.push(`Option --${name} is missing its value.`);
            continue;
          }
          applyOption(p, id, value, warnings);
        } else applyOption(p, id, undefined, warnings);
        continue;
      }
      if (UNSUPPORTED_WITH_VALUE_LONG.has(name)) {
        if (inline === undefined) takeValue();
        warnings.push(`Option --${name} is not supported and was ignored.`);
        continue;
      }
      warnings.push(`Option --${name} is not supported and was ignored.`);
      continue;
    }
    // short option(s): -X POST, -XPOST, -sSL, -H'...'
    const letters = tok.slice(1);
    let consumed = false;
    for (let j = 0; j < letters.length && !consumed; j++) {
      const letter = letters[j]!;
      const id = SHORT[letter];
      if (id) {
        if (VALUE_OPTS.has(id)) {
          const rest = letters.slice(j + 1);
          const value = rest !== '' ? rest : takeValue();
          consumed = true;
          if (value === undefined) {
            warnings.push(`Option -${letter} is missing its value.`);
            break;
          }
          applyOption(p, id, value, warnings);
        } else applyOption(p, id, undefined, warnings);
        continue;
      }
      if (UNSUPPORTED_WITH_VALUE_SHORT.has(letter)) {
        const rest = letters.slice(j + 1);
        if (rest === '') takeValue();
        consumed = true;
        warnings.push(`Option -${letter} is not supported and was ignored.`);
        break;
      }
      warnings.push(`Option -${letter} is not supported and was ignored.`);
    }
  }
  return p;
}

// ----------------------------------------------------------------------------- draft assembly

function nameFor(method: string, url: string): string {
  const { base } = splitUrl(url);
  const short = base.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const text = short || 'request';
  return `${method} ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`;
}

/** Parse a curl command line into a request draft plus warnings. Never throws on user input. */
export function parseCurl(input: string): CurlParseResult {
  const warnings: string[] = [];
  if (input.length > CURL_MAX_INPUT) {
    return { draft: emptyRequestDraft(), warnings: ['The pasted command is larger than 1 MiB and was not parsed.'], ok: false };
  }
  let text = input.trim().replace(/^[$>]\s+/, '');
  const head = /^(?:sudo\s+)?curl(?:\.exe)?(?:\s|$)/i.exec(text);
  if (head) text = text.slice(head[0].length);
  else warnings.push('The text does not start with "curl"; it was parsed as curl arguments anyway.');

  const tokenized = tokenizeShell(text);
  warnings.push(...tokenized.warnings);
  const p = parseTokens(tokenized.tokens, warnings);

  if (p.url === undefined) {
    warnings.push('No URL found in the command.');
    return { draft: emptyRequestDraft(), warnings, ok: false };
  }

  // ---- URL and query
  let rawUrl = p.url.trim();
  if (/^["'<]/.test(rawUrl) && /["'>]$/.test(rawUrl)) rawUrl = rawUrl.slice(1, -1);
  const dataText = p.data.map((d) => d.value).join('&');
  if (p.get && dataText) {
    const { base, query, hash } = splitUrl(rawUrl);
    rawUrl = `${base}?${[query, dataText].filter(Boolean).join('&')}${hash}`;
  }
  const { base, query, hash } = splitUrl(rawUrl);
  const url = base + hash;
  if (hash) warnings.push('The URL fragment (#...) is kept in the URL field but never sent.');
  const queryParams = parseQueryString(query);
  const pathVariables = extractPathVariableNames(url).map((key) => ({ key, value: '', enabled: true }));

  // ---- headers
  const headers = [...p.headers];
  if (p.cookies.length) {
    const existing = headers.find((h) => h.key.toLowerCase() === 'cookie');
    const joined = p.cookies.join('; ');
    if (existing) existing.value = existing.value ? `${existing.value}; ${joined}` : joined;
    else headers.push({ key: 'Cookie', value: joined, enabled: true });
  }
  if (p.compressed && !headers.some((h) => h.key.toLowerCase() === 'accept-encoding')) headers.push({ key: 'Accept-Encoding', value: 'deflate, gzip, br', enabled: true });
  const hasJson = p.data.some((d) => d.kind === 'json');
  if (hasJson) {
    if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
    if (!headers.some((h) => h.key.toLowerCase() === 'accept')) headers.push({ key: 'Accept', value: 'application/json', enabled: true });
  }

  // ---- body
  const draft = emptyRequestDraft();
  const contentType = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value;
  const hasBody = !p.get && dataText !== '';
  if (p.formSeen) {
    if (hasBody) warnings.push('Both -F and -d were given; curl would reject this. The form data was kept and the -d body ignored.');
    draft.body = { mode: 'formdata', formData: p.form };
  } else if (hasBody) {
    const ct = (contentType ?? '').toLowerCase();
    const defaultForm = contentType === undefined || ct.includes('x-www-form-urlencoded');
    if (defaultForm && !hasJson && looksUrlencoded(dataText)) {
      const entries = parseQueryString(dataText);
      draft.body = { mode: 'urlencoded', urlencoded: entries };
    } else {
      const rawLanguage = rawLanguageFor(hasJson ? 'application/json' : contentType, dataText);
      draft.body = { mode: 'raw', raw: dataText, rawLanguage };
    }
  }

  // ---- method
  const method = p.method ?? (p.head ? 'HEAD' : hasBody || p.formSeen ? 'POST' : 'GET');
  if (p.method && p.head && p.method !== 'HEAD') warnings.push('-I/--head was ignored because an explicit -X method was given.');

  // ---- auth
  if (p.bearer !== undefined) {
    draft.auth = { type: 'bearer', params: { token: p.bearer } };
    if (p.user !== undefined) warnings.push('Both --oauth2-bearer and -u were given; the bearer token was used.');
  } else if (p.user !== undefined) {
    const colon = p.user.indexOf(':');
    if (colon === -1) {
      draft.auth = { type: 'basic', params: { username: p.user, password: '' } };
      warnings.push('-u was given without a password (curl would prompt for it); enter the password in the Authorization tab.');
    } else draft.auth = { type: 'basic', params: { username: p.user.slice(0, colon), password: p.user.slice(colon + 1) } };
  } else draft.auth = { type: 'inherit', params: {} };

  // ---- settings
  if (p.location) draft.settings.followRedirects = true;
  if (p.maxRedirects !== undefined) draft.settings.maxRedirects = p.maxRedirects;
  if (p.maxTimeMs !== undefined) draft.settings.timeoutMs = p.maxTimeMs;
  if (p.httpVersion) draft.settings.httpVersion = p.httpVersion;

  draft.method = method;
  draft.url = url;
  draft.queryParams = queryParams;
  draft.pathVariables = pathVariables;
  draft.headers = headers;
  draft.name = nameFor(method, url);
  return { draft, warnings, ok: true };
}
