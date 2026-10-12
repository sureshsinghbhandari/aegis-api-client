/**
 * String literal helpers for the generators. Pure functions, no platform APIs.
 */

/** POSIX shell single-quoted literal: `'` becomes `'\''`. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single-quoted literal (`'` doubled). */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** PowerShell here-string for multi-line text. */
export function psHereString(s: string): string {
  return `@'\n${s}\n'@`;
}

/** C-like double-quoted literal (JavaScript, Java, C#, Go, Python, PHP double quotes). */
export function cQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
      }
    }
  }
  return out + '"';
}

/** Python literal: a `"""` block for multi-line text, a plain double-quoted string otherwise. */
export function pyQuote(s: string): string {
  if (s.includes('\n') && !s.includes('"""') && !s.endsWith('"')) return `"""${s.replace(/\\/g, '\\\\')}"""`;
  return cQuote(s);
}

/** PHP / Ruby single-quoted literal (only `\` and `'` are escaped; newlines stay literal). */
export function sqQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Go string: raw backtick literal when possible, escaped otherwise. */
export function goQuote(s: string): string {
  return s.includes('`') || /[\r]/.test(s) ? cQuote(s) : `\`${s}\``;
}

/** C# verbatim string literal. */
export function csQuote(s: string): string {
  return s.includes('\n') || s.includes('\\') ? `@"${s.replace(/"/g, '""')}"` : cQuote(s);
}

/** Java string: text block for multi-line content, escaped literal otherwise. */
export function javaQuote(s: string): string {
  if (s.includes('\n') && !s.includes('"""')) return `"""\n${s.replace(/\\/g, '\\\\')}\n"""`;
  return cQuote(s);
}

/** Pretty-print JSON text if it parses; otherwise return null. */
export function prettyJson(text: string, indent = 2): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, indent);
  } catch {
    return null;
  }
}

export function indentLines(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => (l === '' ? l : pad + l))
    .join('\n');
}

/** Strip characters that would split a header line. */
export function cleanHeaderValue(v: string): string {
  return v.replace(/[\r\n\0]/g, ' ');
}

export function isJsonContentType(ct: string): boolean {
  const c = ct.toLowerCase();
  return c.includes('json');
}

export function hasHeader(headers: ReadonlyArray<{ name: string }>, name: string): boolean {
  const n = name.toLowerCase();
  return headers.some((h) => h.name.toLowerCase() === n);
}

export function headerValueOf(headers: ReadonlyArray<{ name: string; value: string }>, name: string): string | undefined {
  const n = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === n)?.value;
}

/** Base64 of UTF-8 text without Buffer/btoa (works in every runtime). */
export function base64Utf8(text: string): string {
  const bytes: number[] = [];
  for (const ch of text) {
    let code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      code = 0;
    }
  }
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(triple >> 18) & 63]! + ALPHABET[(triple >> 12) & 63]! + (b === undefined ? '=' : ALPHABET[(triple >> 6) & 63]!) + (c === undefined ? '=' : ALPHABET[triple & 63]!);
  }
  return out;
}

/** Split a URL into origin-relative parts for raw HTTP output. Tolerates `{{placeholders}}`. */
export function splitUrlForHttp(url: string): { host: string; pathWithQuery: string; https: boolean } {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^#]*)/.exec(url);
  if (!m) {
    const slash = url.indexOf('/');
    return { host: slash === -1 ? url : url.slice(0, slash), pathWithQuery: slash === -1 ? '/' : url.slice(slash), https: false };
  }
  const rest = m[3] ?? '';
  return { host: m[2] ?? '', pathWithQuery: rest === '' ? '/' : rest, https: (m[1] ?? '').toLowerCase() === 'https' };
}

/** Percent-encode a form value (application/x-www-form-urlencoded) while keeping `{{placeholders}}` readable. */
export function formEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+').replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

export function serializeForm(entries: ReadonlyArray<{ name: string; value: string }>): string {
  return entries.map((e) => `${formEncode(e.name)}=${formEncode(e.value)}`).join('&');
}
