import { csharpQuote } from '../escape';
import type { SnippetGenerator } from '../types';
import { headersWithout, noteLines } from './common';

export const generateCSharp: SnippetGenerator = (request) => {
  const body = request.body;
  const lines: string[] = [];
  const headers = body.kind === 'none' ? request.headers : headersWithout(request, ['content-type']);
  const contentType = request.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value;
  lines.push('using System.Net.Http;', 'using System.Net.Http.Headers;', 'using System.Text;', '', 'using var client = new HttpClient();', `using var request = new HttpRequestMessage(new HttpMethod(${csharpQuote(request.method)}), ${csharpQuote(request.url)});`);
  for (const h of headers) lines.push(`request.Headers.TryAddWithoutValidation(${csharpQuote(h.name)}, ${csharpQuote(h.value)});`);
  switch (body.kind) {
    case 'text':
      lines.push(`request.Content = new StringContent(${csharpQuote(body.text)}, Encoding.UTF8);`);
      lines.push(`request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${csharpQuote(contentType ?? body.contentType)});`);
      break;
    case 'urlencoded':
      lines.push('request.Content = new FormUrlEncodedContent(new[]', '{');
      for (const e of body.entries) lines.push(`    new KeyValuePair<string, string>(${csharpQuote(e.name)}, ${csharpQuote(e.value)}),`);
      lines.push('});');
      break;
    case 'multipart':
      lines.push('var form = new MultipartFormDataContent();');
      for (const p of body.parts) {
        if (p.file) {
          lines.push(`var fileContent = new StreamContent(File.OpenRead(${csharpQuote(p.value)}));`);
          if (p.contentType) lines.push(`fileContent.Headers.ContentType = MediaTypeHeaderValue.Parse(${csharpQuote(p.contentType)});`);
          lines.push(`form.Add(fileContent, ${csharpQuote(p.name)}, ${csharpQuote(p.value)});`);
        } else lines.push(`form.Add(new StringContent(${csharpQuote(p.value)}), ${csharpQuote(p.name)});`);
      }
      lines.push('request.Content = form;');
      break;
    case 'file':
      lines.push(`request.Content = new StreamContent(File.OpenRead(${csharpQuote(body.fileName)}));`);
      lines.push(`request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${csharpQuote(contentType ?? body.contentType)});`);
      break;
    default:
      break;
  }
  lines.push('', 'using var response = await client.SendAsync(request);', 'Console.WriteLine((int)response.StatusCode);', 'Console.WriteLine(await response.Content.ReadAsStringAsync());');
  return `${noteLines(request, '//')}${lines.join('\n')}\n`;
};
