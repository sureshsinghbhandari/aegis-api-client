import { goQuote } from '../escape';
import type { SnippetGenerator } from '../types';
import { headersWithout, noteLines } from './common';

export const generateGo: SnippetGenerator = (request) => {
  const body = request.body;
  const imports = new Set(['fmt', 'io', 'net/http']);
  const setup: string[] = [];
  let bodyExpr = 'nil';
  let headers = request.headers;
  switch (body.kind) {
    case 'text':
      imports.add('strings');
      setup.push(`payload := strings.NewReader(${goQuote(body.text)})`);
      bodyExpr = 'payload';
      break;
    case 'urlencoded':
      imports.add('net/url');
      imports.add('strings');
      setup.push('form := url.Values{}');
      for (const e of body.entries) setup.push(`form.Add(${goQuote(e.name)}, ${goQuote(e.value)})`);
      setup.push('payload := strings.NewReader(form.Encode())');
      bodyExpr = 'payload';
      break;
    case 'multipart':
      imports.add('bytes');
      imports.add('mime/multipart');
      headers = headersWithout(request, ['content-type']);
      setup.push('var buf bytes.Buffer', 'writer := multipart.NewWriter(&buf)');
      for (const p of body.parts) {
        if (p.file) {
          imports.add('os');
          setup.push(`file, err := os.Open(${goQuote(p.value)})`, 'if err != nil {', '\tpanic(err)', '}', 'defer file.Close()', `part, _ := writer.CreateFormFile(${goQuote(p.name)}, ${goQuote(p.value)})`, 'io.Copy(part, file)');
        } else setup.push(`writer.WriteField(${goQuote(p.name)}, ${goQuote(p.value)})`);
      }
      setup.push('writer.Close()');
      bodyExpr = '&buf';
      break;
    case 'file':
      imports.add('os');
      setup.push(`payload, err := os.Open(${goQuote(body.fileName)})`, 'if err != nil {', '\tpanic(err)', '}', 'defer payload.Close()');
      bodyExpr = 'payload';
      break;
    default:
      break;
  }
  const lines: string[] = [];
  lines.push('package main', '', 'import (');
  for (const i of [...imports].sort()) lines.push(`\t${goQuote(i)}`);
  lines.push(')', '', 'func main() {');
  for (const s of setup) lines.push(`\t${s}`);
  lines.push(`\treq, err := http.NewRequest(${goQuote(request.method)}, ${goQuote(request.url)}, ${bodyExpr})`, '\tif err != nil {', '\t\tpanic(err)', '\t}');
  for (const h of headers) lines.push(`\treq.Header.Set(${goQuote(h.name)}, ${goQuote(h.value)})`);
  if (body.kind === 'multipart') lines.push('\treq.Header.Set("Content-Type", writer.FormDataContentType())');
  lines.push('\tres, err := http.DefaultClient.Do(req)', '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer res.Body.Close()', '\tdata, _ := io.ReadAll(res.Body)', '\tfmt.Println(res.Status)', '\tfmt.Println(string(data))', '}');
  return `${noteLines(request, '//')}${lines.join('\n')}\n`;
};
