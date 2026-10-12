/**
 * Minimal, safe Markdown renderer for request/collection descriptions.
 * Every piece of text is HTML-escaped; raw HTML in the source is shown literally.
 * Links keep only http(s)/mailto URLs, images only inline `data:image/*` URLs (no remote
 * images). The fragment is meant to be wrapped by `buildPreviewDocument` (restrictive CSP)
 * and shown inside an `<iframe sandbox="">`.
 *
 * Supported: ATX headings, paragraphs, hard breaks (two trailing spaces), `**bold**`, `*italic*`,
 * `~~strike~~`, `` `code` ``, fenced and indented code blocks, blockquotes, nested bullet and
 * numbered lists, task list items, horizontal rules, GFM tables, links, images, autolinks.
 */
import { buildPreviewDocument } from '@aegis/core';

const MAX_INPUT = 200_000;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Returns the URL when it is safe for a link, otherwise null. */
export function safeLinkUrl(url: string): string | null {
  const u = url.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^(#|\/|\.\/|\.\.\/)/.test(u)) return null; // relative links point nowhere inside the sandbox
  return null;
}

/** Returns the URL when it is an inline data image, otherwise null (remote images are never loaded). */
export function safeImageUrl(url: string): string | null {
  const u = url.trim();
  return /^data:image\/(png|gif|jpe?g|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(u) ? u : null;
}

// ----------------------------------------------------------------------------- inline

function findClosing(src: string, from: number, delim: string): number {
  let i = from;
  while (i < src.length) {
    if (src.startsWith(delim, i) && !/\s/.test(src[i - 1] ?? '') && src[i - 1] !== '\\') return i;
    if (src[i] === '\n' && src[i + 1] === '\n') return -1;
    i++;
  }
  return -1;
}

const EMPHASIS: ReadonlyArray<readonly [string, string]> = [
  ['**', 'strong'],
  ['__', 'strong'],
  ['~~', 'del'],
  ['*', 'em'],
  ['_', 'em'],
];

export function renderInline(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  scan: while (i < n) {
    const ch = src[i]!;

    if (ch === '\\' && i + 1 < n && /[\\`*_{}[\]()#+\-.!~<>|]/.test(src[i + 1]!)) {
      out += escapeHtml(src[i + 1]!);
      i += 2;
      continue;
    }

    if (ch === '`') {
      let run = 0;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = src.indexOf(fence, i + run);
      if (close !== -1) {
        out += `<code>${escapeHtml(src.slice(i + run, close).trim())}</code>`;
        i = close + run;
        continue;
      }
      out += escapeHtml(fence);
      i += run;
      continue;
    }

    if (ch === '!' && src[i + 1] === '[') {
      const link = parseLink(src, i + 1);
      if (link) {
        const url = safeImageUrl(link.url);
        out += url ? `<img alt="${escapeHtml(link.text)}" src="${escapeHtml(url)}"${link.title ? ` title="${escapeHtml(link.title)}"` : ''}>` : `<span class="md-noimg">[image: ${escapeHtml(link.text || link.url)}]</span>`;
        i = link.end;
        continue;
      }
    }

    if (ch === '[') {
      const link = parseLink(src, i);
      if (link) {
        const url = safeLinkUrl(link.url);
        const inner = renderInline(link.text);
        out += url ? `<a href="${escapeHtml(url)}"${link.title ? ` title="${escapeHtml(link.title)}"` : ''} rel="noreferrer">${inner}</a>` : `<span class="md-nolink" title="${escapeHtml(link.url)}">${inner}</span>`;
        i = link.end;
        continue;
      }
    }

    if (ch === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i));
      if (m) {
        const url = safeLinkUrl(m[1]!);
        out += url ? `<a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(m[1]!)}</a>` : escapeHtml(m[0]);
        i += m[0].length;
        continue;
      }
    }

    for (const [delim, tag] of EMPHASIS) {
      if (src.startsWith(delim, i) && !/\s/.test(src[i + delim.length] ?? ' ') && (delim !== '_' || !/\w/.test(src[i - 1] ?? ''))) {
        const close = findClosing(src, i + delim.length, delim);
        if (close !== -1 && close > i + delim.length) {
          out += `<${tag}>${renderInline(src.slice(i + delim.length, close))}</${tag}>`;
          i = close + delim.length;
          continue scan;
        }
      }
    }

    if (ch === '\n') {
      out += /  $/.test(out) ? '<br>\n' : '\n';
      i++;
      continue;
    }

    out += escapeHtml(ch);
    i++;
  }
  return out;
}

function parseLink(src: string, at: number): { text: string; url: string; title: string; end: number } | null {
  if (src[at] !== '[') return null;
  let depth = 0;
  let i = at;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) break;
    } else if (src[i] === '\n' && src[i + 1] === '\n') return null;
  }
  if (i >= src.length || src[i + 1] !== '(') return null;
  const text = src.slice(at + 1, i);
  // closing paren of the destination, allowing balanced parentheses inside the URL
  let close = -1;
  let parens = 0;
  for (let j = i + 2; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '\n') break;
    if (c === '(') parens++;
    else if (c === ')') {
      if (parens === 0) {
        close = j;
        break;
      }
      parens--;
    }
  }
  if (close === -1) return null;
  const body = src.slice(i + 2, close).trim();
  const m = /^(\S*)(?:\s+"([^"]*)")?$/.exec(body);
  if (!m) return null;
  return { text, url: m[1] ?? '', title: m[2] ?? '', end: close + 1 };
}

// ----------------------------------------------------------------------------- blocks

const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i]!.trim().startsWith(marker[0]!.repeat(3)) && /^ {0,3}(`{3,}|~{3,})\s*$/.test(lines[i]!))) body.push(lines[i++]!);
      i++; // closing fence (or EOF)
      out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang.replace(/[^\w+#.-]/g, ''))}"` : ''}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (/^ {0,3}>/.test(lines[i]!) || (lines[i]!.trim() !== '' && inner.length > 0 && !LIST.test(lines[i]!) && !HEADING.test(lines[i]!)))) {
        inner.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
        i++;
      }
      out.push(`<blockquote>\n${renderBlocks(inner)}</blockquote>`);
      continue;
    }

    if (/^( {4}|\t)/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]!) || lines[i]!.trim() === '')) body.push(lines[i++]!.replace(/^( {4}|\t)/, ''));
      while (body.length && body[body.length - 1]!.trim() === '') body.pop();
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }

    if (LIST.test(line)) {
      const { html, next } = renderList(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|')) rows.push(splitRow(lines[i++]!));
      const cell = (tag: 'th' | 'td', c: string, idx: number) => `<${tag}${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${renderInline(c)}</${tag}>`;
      out.push(
        `<table>\n<thead><tr>${header.map((c, idx) => cell('th', c, idx)).join('')}</tr></thead>\n<tbody>\n${rows
          .map((r) => `<tr>${header.map((_, idx) => cell('td', r[idx] ?? '', idx)).join('')}</tr>`)
          .join('\n')}\n</tbody>\n</table>`,
      );
      continue;
    }

    // paragraph
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !HEADING.test(lines[i]!) && !FENCE.test(lines[i]!) && !HR.test(lines[i]!) && !/^ {0,3}>/.test(lines[i]!) && !LIST.test(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    out.push(`<p>${renderInline(para.join('\n'))}</p>`);
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

function renderList(lines: string[], start: number): { html: string; next: number } {
  interface Item {
    indent: number;
    ordered: boolean;
    startNumber: number;
    lines: string[];
  }
  const items: Item[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = LIST.exec(line);
    if (m) {
      const indent = m[1]!.replace(/\t/g, '    ').length;
      const marker = m[2]!;
      const ordered = /\d/.test(marker);
      if (items.length && indent < items[0]!.indent) break;
      // a different list type at the base indentation starts a new list
      if (items.length && indent === items[0]!.indent && ordered !== items[0]!.ordered) break;
      items.push({ indent, ordered, startNumber: ordered ? Number(marker.slice(0, -1)) : 1, lines: [m[3] ?? ''] });
      i++;
      continue;
    }
    if (line.trim() === '') {
      // blank line inside the list: continue when the next line is still indented or a list item
      const nextLine = lines[i + 1];
      if (nextLine !== undefined && (LIST.test(nextLine) || /^\s{2,}\S/.test(nextLine))) {
        items[items.length - 1]?.lines.push('');
        i++;
        continue;
      }
      break;
    }
    const last = items[items.length - 1];
    if (last && /^\s{2,}\S/.test(line)) {
      last.lines.push(line.replace(/^\s{2,4}/, ''));
      i++;
      continue;
    }
    break;
  }
  if (items.length === 0) return { html: '', next: start + 1 };

  const base = items[0]!.indent;
  const ordered = items[0]!.ordered;
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && items[0]!.startNumber !== 1 ? ` start="${items[0]!.startNumber}"` : '';
  const parts: string[] = [];
  let k = 0;
  while (k < items.length) {
    const it = items[k]!;
    if (it.indent > base) {
      // nested list: gather consecutive deeper items and render them inside the previous <li>
      const nested: string[] = [];
      while (k < items.length && items[k]!.indent > base) {
        const d = items[k]!;
        const pad = ' '.repeat(d.indent - base);
        const [first = '', ...rest] = d.lines;
        nested.push(`${pad}${d.ordered ? `${d.startNumber}.` : '-'} ${first}`);
        for (const extra of rest) nested.push(extra === '' ? '' : `${pad}  ${extra}`);
        k++;
      }
      const sub = renderBlocks(nested).replace(/\n$/, '');
      if (parts.length) parts[parts.length - 1] = parts[parts.length - 1]!.replace(/<\/li>$/, `\n${sub}</li>`);
      else parts.push(`<li>${sub}</li>`);
      continue;
    }
    const itemLines = [...it.lines];
    while (itemLines.length > 1 && itemLines[itemLines.length - 1]!.trim() === '') itemLines.pop();
    let body = itemLines.join('\n');
    let cls = '';
    const task = /^\[([ xX])\]\s+/.exec(body);
    if (task) {
      body = body.slice(task[0].length);
      cls = ` class="task"`;
      body = `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${body}`;
    }
    const multi = body.includes('\n\n');
    const inner = multi ? renderBlocks(body.split('\n')) : task ? body.replace(/^(<input[^>]*>) ([\s\S]*)$/, (_m, box: string, rest: string) => `${box} ${renderInline(rest)}`) : renderInline(body);
    parts.push(`<li${cls}>${inner}</li>`);
    k++;
  }
  return { html: `<${tag}${startAttr}>\n${parts.join('\n')}\n</${tag}>`, next: i };
}

/** Render Markdown to an HTML fragment (already escaped; safe to embed in the preview document). */
export function renderMarkdown(markdown: string): string {
  const src = (markdown.length > MAX_INPUT ? markdown.slice(0, MAX_INPUT) : markdown).replace(/\r\n?/g, '\n');
  return renderBlocks(src.split('\n'));
}

const BASE_CSS = `
:root{color-scheme:light dark}
body{margin:0;padding:12px 16px;font:13px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--fg);overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{margin:1em 0 .4em;line-height:1.25}h1{font-size:1.5em}h2{font-size:1.3em}h3{font-size:1.15em}
h1:first-child,h2:first-child,h3:first-child,p:first-child{margin-top:0}
p{margin:0 0 .8em}a{color:var(--link)}code{font-family:"Cascadia Mono",Consolas,monospace;font-size:.92em;background:var(--code);padding:1px 4px;border-radius:3px}
pre{background:var(--code);padding:8px 10px;border-radius:4px;overflow:auto}pre code{background:none;padding:0}
blockquote{margin:0 0 .8em;padding:2px 12px;border-left:3px solid var(--border);color:var(--dim)}
table{border-collapse:collapse;margin:0 0 .8em}th,td{border:1px solid var(--border);padding:3px 8px;text-align:left}th{background:var(--code)}
ul,ol{padding-left:22px;margin:0 0 .8em}li{margin:2px 0}li.task{list-style:none;margin-left:-18px}hr{border:none;border-top:1px solid var(--border);margin:1em 0}
img{max-width:100%}.md-nolink{text-decoration:underline dotted;color:var(--dim)}.md-noimg{color:var(--dim);font-style:italic}
`;

const THEMES = {
  dark: '--bg:#1e1f24;--fg:#e4e6eb;--dim:#9aa0ab;--link:#7db4ff;--code:#2b2d35;--border:#3a3d47',
  light: '--bg:#ffffff;--fg:#1f2328;--dim:#6b7280;--link:#0b61d8;--code:#f3f4f6;--border:#d8dbe0',
} as const;

/** Full sandboxed document (restrictive CSP) for an `<iframe sandbox="">`. */
export function buildMarkdownDocument(markdown: string, theme: 'dark' | 'light' = 'light'): string {
  const html = renderMarkdown(markdown);
  return buildPreviewDocument(`<style>:root{${THEMES[theme]}}${BASE_CSS}</style><main class="md">${html}</main>`);
}
