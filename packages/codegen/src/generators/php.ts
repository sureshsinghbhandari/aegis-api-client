import { phpQuote } from '../escape';
import type { SnippetGenerator } from '../types';
import { headersWithout, noteLines } from './common';
import { httpBodyText } from './http';

export const generatePhpCurl: SnippetGenerator = (request) => {
  const body = request.body;
  const lines: string[] = ['<?php', ...noteLines(request, '//').trimEnd().split('\n').filter(Boolean), '', '$ch = curl_init();', ''];
  let headers = request.headers;
  const setup: string[] = [];
  switch (body.kind) {
    case 'text':
      setup.push(`  CURLOPT_POSTFIELDS => ${phpQuote(body.text)},`);
      break;
    case 'urlencoded':
      setup.push(`  CURLOPT_POSTFIELDS => ${phpQuote(httpBodyText(request))},`);
      break;
    case 'multipart':
      headers = headersWithout(request, ['content-type']);
      setup.push('  CURLOPT_POSTFIELDS => [');
      for (const p of body.parts) {
        setup.push(p.file ? `    ${phpQuote(p.name)} => new CURLFile(${phpQuote(p.value)}${p.contentType ? `, ${phpQuote(p.contentType)}` : ''}),` : `    ${phpQuote(p.name)} => ${phpQuote(p.value)},`);
      }
      setup.push('  ],');
      break;
    case 'file':
      setup.push(`  CURLOPT_POSTFIELDS => file_get_contents(${phpQuote(body.fileName)}),`);
      break;
    default:
      break;
  }
  lines.push('curl_setopt_array($ch, [', `  CURLOPT_URL => ${phpQuote(request.url)},`, `  CURLOPT_CUSTOMREQUEST => ${phpQuote(request.method)},`, '  CURLOPT_RETURNTRANSFER => true,');
  if (request.method === 'HEAD') lines.push('  CURLOPT_NOBODY => true,');
  lines.push(...setup);
  if (headers.length) {
    lines.push('  CURLOPT_HTTPHEADER => [');
    for (const h of headers) lines.push(`    ${phpQuote(`${h.name}: ${h.value}`)},`);
    lines.push('  ],');
  }
  lines.push(']);', '', '$response = curl_exec($ch);', 'if ($response === false) {', "  echo 'cURL error: ' . curl_error($ch);", '} else {', '  echo curl_getinfo($ch, CURLINFO_RESPONSE_CODE), PHP_EOL;', '  echo $response;', '}', 'curl_close($ch);');
  return `${lines.join('\n')}\n`;
};
