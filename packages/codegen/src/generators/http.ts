import { utf8Length } from '../escape';
import type { SnippetGenerator, SnippetRequest } from '../types';

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]+)/i.exec(url);
    return m?.[1] ?? url;
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    const rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i, '');
    return rest || '/';
  }
}

export function httpBodyText(request: SnippetRequest): string {
  const body = request.body;
  switch (body.kind) {
    case 'text':
      return body.text;
    case 'urlencoded':
      return body.entries.map((e) => `${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`).join('&');
    case 'multipart': {
      const boundary = '----AegisFormBoundary';
      const parts = body.parts.map((p) => {
        const disposition = p.file ? `Content-Disposition: form-data; name="${p.name.replace(/"/g, '%22')}"; filename="${p.value.replace(/"/g, '%22')}"` : `Content-Disposition: form-data; name="${p.name.replace(/"/g, '%22')}"`;
        const type = p.contentType ? `\r\nContent-Type: ${p.contentType}` : p.file ? '\r\nContent-Type: application/octet-stream' : '';
        const content = p.file ? `<contents of ${p.value}>` : p.value;
        return `--${boundary}\r\n${disposition}${type}\r\n\r\n${content}`;
      });
      return `${parts.join('\r\n')}\r\n--${boundary}--`;
    }
    case 'file':
      return `<contents of ${body.fileName}>`;
    default:
      return '';
  }
}

/** Raw HTTP/1.1 message. Header values were already flattened (no CR/LF) by `prepareSnippetRequest`. */
export const generateHttp: SnippetGenerator = (request) => {
  const lines: string[] = [];
  for (const n of request.notes) lines.push(`# ${n.replace(/[\r\n]+/g, ' ')}`);
  lines.push(`${request.method} ${pathOf(request.url)} HTTP/1.1`);
  const headers = [...request.headers];
  if (!headers.some((h) => h.name.toLowerCase() === 'host')) headers.unshift({ name: 'Host', value: hostOf(request.url) });
  const body = httpBodyText(request);
  if (request.body.kind === 'multipart' && !headers.some((h) => h.name.toLowerCase() === 'content-type')) headers.push({ name: 'Content-Type', value: 'multipart/form-data; boundary=----AegisFormBoundary' });
  if (request.body.kind !== 'none' && !headers.some((h) => h.name.toLowerCase() === 'content-length')) headers.push({ name: 'Content-Length', value: String(utf8Length(body)) });
  for (const h of headers) lines.push(`${h.name}: ${h.value.replace(/[\r\n]+/g, ' ')}`);
  lines.push('');
  if (request.body.kind !== 'none') lines.push(body);
  return `${lines.join('\r\n')}\r\n`;
};
