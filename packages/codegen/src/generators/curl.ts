import { shellQuote } from '../escape';
import type { SnippetGenerator } from '../types';
import { noteLines } from './common';

export const generateCurl: SnippetGenerator = (request) => {
  const lines: string[] = [];
  const method = request.method;
  const explicitMethod = method !== 'GET' && !(method === 'POST' && request.body.kind !== 'none' && request.body.kind !== 'file');
  lines.push(`curl${explicitMethod ? ` -X ${method}` : ''}${method === 'HEAD' ? ' --head' : ''} ${shellQuote(request.url)}`);
  for (const h of request.headers) lines.push(`-H ${shellQuote(`${h.name}: ${h.value}`)}`);
  const body = request.body;
  switch (body.kind) {
    case 'text':
      lines.push(`--data-raw ${shellQuote(body.text)}`);
      break;
    case 'urlencoded':
      for (const e of body.entries) lines.push(`--data-urlencode ${shellQuote(`${e.name}=${e.value}`)}`);
      if (!body.entries.length) lines.push("--data-raw ''");
      break;
    case 'multipart':
      for (const p of body.parts) {
        const type = p.contentType ? `;type=${p.contentType}` : '';
        lines.push(p.file ? `-F ${shellQuote(`${p.name}=@${p.value}${type}`)}` : `--form-string ${shellQuote(`${p.name}=${p.value}`)}`);
      }
      break;
    case 'file':
      lines.push(`--data-binary ${shellQuote(`@${body.fileName}`)}`);
      break;
    default:
      break;
  }
  return `${noteLines(request, '#')}${lines.join(' \\\n  ')}\n`;
};
