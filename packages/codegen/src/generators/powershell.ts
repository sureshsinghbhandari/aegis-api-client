import { psQuote } from '../escape';
import type { SnippetGenerator } from '../types';
import { headersWithout, noteLines } from './common';

export const generatePowerShell: SnippetGenerator = (request) => {
  const body = request.body;
  const lines: string[] = [noteLines(request, '#').trimEnd()].filter(Boolean);
  let headers = request.headers;
  let bodyArg = '';
  let contentType: string | null = null;
  switch (body.kind) {
    case 'text':
      lines.push(`$body = ${psQuote(body.text)}`);
      bodyArg = ' -Body $body';
      contentType = body.contentType;
      headers = headersWithout(request, ['content-type']);
      break;
    case 'urlencoded':
      lines.push(`$body = @{`);
      for (const e of body.entries) lines.push(`  ${psQuote(e.name)} = ${psQuote(e.value)}`);
      lines.push('}');
      bodyArg = ' -Body $body';
      contentType = 'application/x-www-form-urlencoded';
      headers = headersWithout(request, ['content-type']);
      break;
    case 'multipart':
      lines.push(`$form = @{`);
      for (const p of body.parts) lines.push(`  ${psQuote(p.name)} = ${p.file ? `Get-Item -Path ${psQuote(p.value)}` : psQuote(p.value)}`);
      lines.push('}');
      bodyArg = ' -Form $form';
      headers = headersWithout(request, ['content-type']);
      break;
    case 'file':
      bodyArg = ` -InFile ${psQuote(body.fileName)}`;
      contentType = body.contentType;
      headers = headersWithout(request, ['content-type']);
      break;
    default:
      break;
  }
  if (headers.length) {
    lines.push('$headers = @{');
    for (const h of headers) lines.push(`  ${psQuote(h.name)} = ${psQuote(h.value)}`);
    lines.push('}');
  }
  const headerArg = headers.length ? ' -Headers $headers' : '';
  const ctArg = contentType ? ` -ContentType ${psQuote(contentType)}` : '';
  lines.push(`$response = Invoke-RestMethod -Method ${psQuote(request.method)} -Uri ${psQuote(request.url)}${headerArg}${ctArg}${bodyArg}`);
  lines.push('$response');
  return `${lines.join('\n')}\n`;
};
