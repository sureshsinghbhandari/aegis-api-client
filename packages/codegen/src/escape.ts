/**
 * String-literal escaping for every target language. Each function returns a
 * COMPLETE literal (including its delimiters) such that no input value can
 * terminate the literal early or inject code: quotes, backslashes, newlines,
 * control characters and interpolation sigils are always escaped.
 */

const CONTROL = /[\u0000-\u001f\u007f]/;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function hex2(code: number): string {
  return code.toString(16).padStart(2, '0');
}

function hex4(code: number): string {
  return code.toString(16).padStart(4, '0');
}

/** POSIX shell: `'...'` when printable, `$'...'` (ANSI-C quoting) when the value holds control characters. */
export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (!CONTROL.test(value)) return `'${value.replace(/'/g, "'\\''")}'`;
  let out = "$'";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\x${hex2(code)}`;
    else out += ch;
  }
  return `${out}'`;
}

/** JavaScript / JSON double-quoted literal. U+2028/2029 are escaped for older engines. */
export function jsQuote(value: string): string {
  return JSON.stringify(value).split(LS).join('\\u2028').split(PS).join('\\u2029');
}

/** Generic C-style double-quoted literal; `extra` maps characters that need escaping beyond the common set. */
function cStyle(value: string, extra: Record<string, string>, control: (code: number) => string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (extra[ch] !== undefined) out += extra[ch];
    else if (code < 0x20 || code === 0x7f) out += control(code);
    else if (code === 0x2028 || code === 0x2029) out += `\\u${hex4(code)}`; // C# treats these as line terminators
    else out += ch;
  }
  return `${out}"`;
}

/** Python 3 `"..."` literal. */
export function pyQuote(value: string): string {
  return cStyle(value, {}, (c) => `\\x${hex2(c)}`);
}

/** Go `"..."` literal. */
export function goQuote(value: string): string {
  return cStyle(value, {}, (c) => `\\x${hex2(c)}`);
}

/** Java `"..."` literal (`\u000a`/`\u000d` are never emitted: Java pre-processes unicode escapes). */
export function javaQuote(value: string): string {
  return cStyle(value, {}, (c) => `\\u${hex4(c)}`);
}

/** C# `"..."` literal. */
export function csharpQuote(value: string): string {
  return cStyle(value, { '\0': '\\0' }, (c) => `\\u${hex4(c)}`);
}

/** Ruby `"..."` literal; `#` is escaped so `#{...}` can never interpolate. */
export function rubyQuote(value: string): string {
  return cStyle(value, { '#': '\\#' }, (c) => `\\x${hex2(c)}`);
}

/** PHP literal: `'...'` when printable, otherwise `"..."` with `$` escaped so no variable interpolation happens. */
export function phpQuote(value: string): string {
  if (!CONTROL.test(value)) return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return cStyle(value, { $: '\\$' }, (c) => `\\x${hex2(c)}`);
}

/**
 * PowerShell literal: `'...'` (no interpolation, only the doubled quote) when printable; otherwise a
 * double-quoted string with backtick escapes where `$`, `"` and the backtick itself are escaped so no
 * interpolation or sub-expression can run.
 */
export function psQuote(value: string): string {
  if (!CONTROL.test(value)) return `'${value.replace(/'/g, "''")}'`;
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '`') out += '``';
    else if (ch === '"') out += '`"';
    else if (ch === '$') out += '`$';
    else if (ch === '\n') out += '`n';
    else if (ch === '\r') out += '`r';
    else if (ch === '\t') out += '`t';
    else if (ch === '\0') out += '`0';
    else if (code < 0x20 || code === 0x7f) out += `$([char]${code})`; // works on Windows PowerShell 5.1 too (no \`u{} there)
    else out += ch;
  }
  return `${out}"`;
}

/** Make a string safe to appear inside a line comment: no line breaks. */
export function commentSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').split(LS).join(' ').split(PS).join(' ');
}

/** UTF-8 byte length without Node APIs. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Base64 of a UTF-8 string without Node APIs. */
export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += alphabet[(triple >> 18) & 63]! + alphabet[(triple >> 12) & 63]!;
    out += b === undefined ? '=' : alphabet[(triple >> 6) & 63]!;
    out += c === undefined ? '=' : alphabet[triple & 63]!;
  }
  return out;
}
