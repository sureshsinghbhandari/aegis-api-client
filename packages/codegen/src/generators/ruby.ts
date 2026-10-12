import { rubyQuote } from '../escape';
import type { SnippetGenerator } from '../types';
import { headersWithout, noteLines } from './common';

export const generateRuby: SnippetGenerator = (request) => {
  const body = request.body;
  const lines: string[] = ["require 'net/http'", "require 'uri'", '', `uri = URI(${rubyQuote(request.url)})`, `request = Net::HTTP::GenericRequest.new(${rubyQuote(request.method)}, ${body.kind === 'none' ? 'false' : 'true'}, true, uri)`];
  let headers = request.headers;
  switch (body.kind) {
    case 'text':
      lines.push(`request.body = ${rubyQuote(body.text)}`);
      break;
    case 'urlencoded':
      headers = headersWithout(request, ['content-type']);
      lines.push('request.set_form_data([', ...body.entries.map((e) => `  [${rubyQuote(e.name)}, ${rubyQuote(e.value)}],`), '])');
      break;
    case 'multipart':
      headers = headersWithout(request, ['content-type']);
      lines.push('request.set_form([', ...body.parts.map((p) => (p.file ? `  [${rubyQuote(p.name)}, File.open(${rubyQuote(p.value)})${p.contentType ? `, { content_type: ${rubyQuote(p.contentType)} }` : ''}],` : `  [${rubyQuote(p.name)}, ${rubyQuote(p.value)}],`)), "], 'multipart/form-data')");
      break;
    case 'file':
      lines.push(`request.body = File.binread(${rubyQuote(body.fileName)})`);
      break;
    default:
      break;
  }
  for (const h of headers) lines.push(`request[${rubyQuote(h.name)}] = ${rubyQuote(h.value)}`);
  lines.push('', "response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https') do |http|", '  http.request(request)', 'end', 'puts response.code', 'puts response.body');
  return `${noteLines(request, '#')}${lines.join('\n')}\n`;
};
