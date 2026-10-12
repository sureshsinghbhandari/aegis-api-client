import { pyQuote } from '../escape';
import type { SnippetGenerator } from '../types';
import { headersWithout, noteLines } from './common';

export const generatePythonRequests: SnippetGenerator = (request) => {
  const body = request.body;
  let setup = '';
  let arg = '';
  let headers = request.headers;
  switch (body.kind) {
    case 'text':
      setup = `payload = ${pyQuote(body.text)}\n`;
      arg = ', data=payload.encode("utf-8")';
      break;
    case 'urlencoded':
      setup = `payload = [\n${body.entries.map((e) => `    (${pyQuote(e.name)}, ${pyQuote(e.value)}),`).join('\n')}\n]\n`;
      arg = ', data=payload';
      headers = headersWithout(request, ['content-type']);
      break;
    case 'multipart':
      setup = `files = [\n${body.parts.map((p) => (p.file ? `    (${pyQuote(p.name)}, (${pyQuote(p.value)}, open(${pyQuote(p.value)}, "rb")${p.contentType ? `, ${pyQuote(p.contentType)}` : ''})),` : `    (${pyQuote(p.name)}, (None, ${pyQuote(p.value)}${p.contentType ? `, ${pyQuote(p.contentType)}` : ''})),`)).join('\n')}\n]\n`;
      arg = ', files=files';
      headers = headersWithout(request, ['content-type']);
      break;
    case 'file':
      setup = `with open(${pyQuote(body.fileName)}, "rb") as f:\n    payload = f.read()\n`;
      arg = ', data=payload';
      break;
    default:
      break;
  }
  const headerBlock = headers.length ? `headers = {\n${headers.map((h) => `    ${pyQuote(h.name)}: ${pyQuote(h.value)},`).join('\n')}\n}\n` : 'headers = {}\n';
  return `${noteLines(request, '#')}import requests\n\nurl = ${pyQuote(request.url)}\n${headerBlock}${setup}\nresponse = requests.request(${pyQuote(request.method)}, url, headers=headers${arg})\nprint(response.status_code)\nprint(response.text)\n`;
};
