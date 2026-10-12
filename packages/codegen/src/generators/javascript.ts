import { jsQuote } from '../escape';
import type { SnippetGenerator, SnippetRequest } from '../types';
import { headersWithout, noteLines } from './common';

function fetchBody(request: SnippetRequest, fileRead: (name: string) => string): { setup: string; expr: string | null; dropContentType: boolean } {
  const body = request.body;
  switch (body.kind) {
    case 'text':
      return { setup: `const body = ${jsQuote(body.text)};\n`, expr: 'body', dropContentType: false };
    case 'urlencoded':
      return {
        setup: `const body = new URLSearchParams([\n${body.entries.map((e) => `  [${jsQuote(e.name)}, ${jsQuote(e.value)}],`).join('\n')}\n]);\n`,
        expr: 'body',
        dropContentType: true,
      };
    case 'multipart':
      return {
        setup: `const body = new FormData();\n${body.parts.map((p) => (p.file ? `body.append(${jsQuote(p.name)}, ${fileRead(p.value)}, ${jsQuote(p.value)});` : `body.append(${jsQuote(p.name)}, ${jsQuote(p.value)});`)).join('\n')}\n`,
        expr: 'body',
        dropContentType: true,
      };
    case 'file':
      return { setup: `const body = ${fileRead(body.fileName)};\n`, expr: 'body', dropContentType: false };
    default:
      return { setup: '', expr: null, dropContentType: false };
  }
}

function render(request: SnippetRequest, prelude: string, fileRead: (name: string) => string): string {
  const { setup, expr, dropContentType } = fetchBody(request, fileRead);
  const headers = dropContentType ? headersWithout(request, ['content-type']) : request.headers;
  const headerLines = headers.map((h) => `    ${jsQuote(h.name)}: ${jsQuote(h.value)},`).join('\n');
  const options = [`  method: ${jsQuote(request.method)},`, headers.length ? `  headers: {\n${headerLines}\n  },` : '  headers: {},', expr ? `  body: ${expr},` : null].filter(Boolean).join('\n');
  return `${noteLines(request, '//')}${prelude}${setup}const response = await fetch(${jsQuote(request.url)}, {\n${options}\n});\nconsole.log(response.status, await response.text());\n`;
}

export const generateJavaScriptFetch: SnippetGenerator = (request) => render(request, '', (name) => `/* File */ fileInput.files[0] /* ${name.replace(/\*\//g, '* /')} */`);

export const generateNodeFetch: SnippetGenerator = (request) => {
  const needsFile = request.body.kind === 'file' || (request.body.kind === 'multipart' && request.body.parts.some((p) => p.file));
  const prelude = `// Node.js 18+ (global fetch, powered by undici)\n${needsFile ? "import { readFile } from 'node:fs/promises';\n" : ''}`;
  const fileRead = (name: string) => (request.body.kind === 'file' ? `await readFile(${jsQuote(name)})` : `new Blob([await readFile(${jsQuote(name)})])`);
  return render(request, prelude, fileRead);
};
