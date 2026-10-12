import { shellQuote } from '../escape';
import type { SnippetGenerator } from '../types';
import { headersWithout, noteLines } from './common';

export const generateHttpie: SnippetGenerator = (request) => {
  const body = request.body;
  let headers = request.headers;
  let mode = '';
  const items: string[] = [];
  let trailing: string | null = null;
  switch (body.kind) {
    case 'text':
      trailing = `--raw ${shellQuote(body.text)}`;
      break;
    case 'urlencoded':
      mode = ' --form';
      headers = headersWithout(request, ['content-type']);
      for (const e of body.entries) items.push(shellQuote(`${e.name}=${e.value}`));
      break;
    case 'multipart':
      mode = ' --multipart';
      headers = headersWithout(request, ['content-type']);
      for (const p of body.parts) items.push(p.file ? shellQuote(`${p.name}@${p.value}${p.contentType ? `;type=${p.contentType}` : ''}`) : shellQuote(`${p.name}=${p.value}`));
      break;
    case 'file':
      trailing = `< ${shellQuote(body.fileName)}`;
      break;
    default:
      break;
  }
  const parts: string[] = [`http${mode} ${request.method} ${shellQuote(request.url)}`];
  for (const h of headers) parts.push(shellQuote(`${h.name}:${h.value}`));
  parts.push(...items);
  if (trailing) parts.push(trailing);
  return `${noteLines(request, '#')}${parts.join(' \\\n  ')}\n`;
};
