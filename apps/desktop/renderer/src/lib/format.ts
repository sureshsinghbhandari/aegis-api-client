/**
 * Pure text formatting / detection helpers for request bodies and responses.
 * No React, no DOM: importable from vitest (node environment).
 */

export type ContentKind = 'json' | 'xml' | 'html' | 'text' | 'image' | 'pdf' | 'binary';

/** Re-indent valid JSON text without altering any literal (numbers, escapes, key order). Returns null when invalid. */
export function formatJson(text: string, indent = 2): string | null {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    JSON.parse(src);
  } catch {
    return null;
  }
  const pad = ' '.repeat(indent);
  let out = '';
  let level = 0;
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        out += ch;
        break;
      case '{':
      case '[': {
        // keep empty containers compact
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j]!)) j++;
        if (src[j] === (ch === '{' ? '}' : ']')) {
          out += ch + src[j]!;
          i = j;
        } else {
          level++;
          out += ch + '\n' + pad.repeat(level);
        }
        break;
      }
      case '}':
      case ']':
        level = Math.max(0, level - 1);
        out += '\n' + pad.repeat(level) + ch;
        break;
      case ',':
        out += ',\n' + pad.repeat(level);
        break;
      case ':':
        out += ': ';
        break;
      case ' ':
      case '\t':
      case '\n':
      case '\r':
        break;
      default:
        out += ch;
    }
  }
  return out;
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'pre', 'textarea']);

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z_][^>]*>|[^<]+|</g;


function tokenizeMarkup(text: string, html: boolean): string[] {
  const tokens: string[] = [];
  const re = new RegExp(TOKEN.source, 'y');
  let pos = 0;
  while (pos < text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) break;
    const tok = m[0];
    pos = re.lastIndex;
    tokens.push(tok);
    if (!html) continue;
    const open = /^<([A-Za-z][\w:-]*)(?:\s[^>]*)?>$/.exec(tok);
    const name = open?.[1]?.toLowerCase() ?? '';
    if (!name || !RAW_TEXT_ELEMENTS.has(name) || tok.endsWith('/>')) continue;
    // Raw text element: its content up to the closing tag is a single token.
    const close = new RegExp(`</${name}\\s*>`, 'i').exec(text.slice(pos));
    if (!close) continue;
    const raw = text.slice(pos, pos + close.index);
    if (raw.trim()) tokens.push(raw);
    tokens.push(close[0]);
    pos += close.index + close[0].length;
  }
  return tokens;
}

/** Simple, forgiving XML/HTML pretty printer. Never throws; returns the input unchanged if it contains no markup. */
export function formatMarkup(text: string, options: { html?: boolean; indent?: number } = {}): string {
  const html = options.html ?? false;
  const pad = ' '.repeat(options.indent ?? 2);
  const tokens = tokenizeMarkup(text, html);
  if (tokens.length === 0) return text;
  const lines: string[] = [];
  let depth = 0;
  const emit = (s: string) => lines.push(pad.repeat(Math.max(0, depth)) + s);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.startsWith('<') || tok === '<') {
      const t = tok.replace(/\s+/g, ' ').trim();
      if (t) emit(t);
      continue;
    }
    if (tok.startsWith('<!--') || tok.startsWith('<![CDATA[') || tok.startsWith('<?') || tok.startsWith('<!')) {
      emit(tok.trim());
      continue;
    }
    if (tok.startsWith('</')) {
      depth--;
      emit(tok);
      continue;
    }
    const nameMatch = /^<([^\s/>]+)/.exec(tok);
    const name = nameMatch?.[1]?.toLowerCase() ?? '';
    const selfClosing = tok.endsWith('/>') || (html && VOID_ELEMENTS.has(name));
    if (selfClosing) {
      emit(tok);
      continue;
    }
    // <a>text</a> stays on a single line
    const next = tokens[i + 1];
    const after = tokens[i + 2];
    if (next !== undefined && after !== undefined && !next.startsWith('<') && after.startsWith('</') && next.indexOf('\n') === -1 && (html ? !RAW_TEXT_ELEMENTS.has(name) : true)) {
      const t = next.trim();
      if (t.length <= 160) {
        emit(tok + t + after);
        i += 2;
        continue;
      }
    }
    emit(tok);
    depth++;
  }
  return lines.join('\n');
}

export function formatXml(text: string): string {
  return formatMarkup(text, { html: false });
}

export function formatHtml(text: string): string {
  return formatMarkup(text, { html: true });
}

/** Content kind from a Content-Type header, falling back to sniffing the body start. */
export function detectContentKind(contentType: string, bodyStart: string, isBinary: boolean): ContentKind {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('image/')) return ct.includes('svg') ? 'xml' : 'image';
  if (ct.includes('application/pdf')) return 'pdf';
  if (ct.includes('json') || ct.includes('+json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  if (isBinary) return 'binary';
  const s = bodyStart.trimStart();
  if (ct === '' || ct.startsWith('text/plain') || ct.includes('octet-stream')) {
    if (s.startsWith('{') || s.startsWith('[')) return 'json';
    if (/^<!doctype html|^<html[\s>]/i.test(s)) return 'html';
    if (s.startsWith('<?xml')) return 'xml';
  }
  return 'text';
}

/** Pretty-print a body for the "Pretty" view; falls back to the original text when it cannot be parsed. */
export function prettyPrint(kind: ContentKind, body: string): string {
  if (kind === 'json') return formatJson(body) ?? body;
  if (kind === 'xml') return formatXml(body);
  if (kind === 'html') return formatHtml(body);
  return body;
}

/** Monaco language id for a content kind. */
export function monacoLanguage(kind: ContentKind): string {
  switch (kind) {
    case 'json':
      return 'json';
    case 'xml':
      return 'xml';
    case 'html':
      return 'html';
    default:
      return 'plaintext';
  }
}

/** Suggested download file name for a response. */
export function suggestedFileName(contentType: string, url: string): string {
  let base = 'response';
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last) base = decodeURIComponent(last);
  } catch {
    /* keep default */
  }
  if (/\.[A-Za-z0-9]{1,6}$/.test(base)) return base;
  const ct = contentType.toLowerCase();
  const ext = ct.includes('json') ? 'json' : ct.includes('html') ? 'html' : ct.includes('xml') ? 'xml' : ct.startsWith('text/') ? 'txt' : ct.includes('pdf') ? 'pdf' : ct.startsWith('image/') ? (ct.split('/')[1] ?? 'bin').split(/[;+]/)[0]! : 'bin';
  return `${base}.${ext}`;
}
