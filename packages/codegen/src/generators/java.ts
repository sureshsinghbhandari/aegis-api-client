import { javaQuote } from '../escape';
import type { SnippetGenerator } from '../types';
import { headersWithout, noteLines } from './common';
import { httpBodyText } from './http';

/** Headers the JDK HttpClient refuses to set by hand. */
const RESTRICTED = ['connection', 'content-length', 'expect', 'host', 'upgrade'];

export const generateJava: SnippetGenerator = (request) => {
  const body = request.body;
  const lines: string[] = [];
  const imports = ['java.net.URI', 'java.net.http.HttpClient', 'java.net.http.HttpRequest', 'java.net.http.HttpResponse'];
  let publisher = 'HttpRequest.BodyPublishers.noBody()';
  let headers = request.headers;
  const setup: string[] = [];
  switch (body.kind) {
    case 'text':
      publisher = `HttpRequest.BodyPublishers.ofString(${javaQuote(body.text)})`;
      break;
    case 'urlencoded':
      publisher = `HttpRequest.BodyPublishers.ofString(${javaQuote(httpBodyText(request))})`;
      break;
    case 'multipart':
      // The JDK client has no multipart helper; the encoded body is emitted as text with file placeholders.
      publisher = `HttpRequest.BodyPublishers.ofString(${javaQuote(httpBodyText(request))})`;
      headers = [...headersWithout(request, ['content-type']), { name: 'Content-Type', value: 'multipart/form-data; boundary=----AegisFormBoundary' }];
      setup.push('// Multipart bodies: replace the file placeholders with the file contents (or use a library such as OkHttp).');
      break;
    case 'file':
      imports.push('java.nio.file.Path');
      publisher = `HttpRequest.BodyPublishers.ofFile(Path.of(${javaQuote(body.fileName)}))`;
      break;
    default:
      break;
  }
  lines.push(...imports.map((i) => `import ${i};`), '', 'public class Main {', '    public static void main(String[] args) throws Exception {');
  for (const s of setup) lines.push(`        ${s}`);
  lines.push('        HttpClient client = HttpClient.newHttpClient();', '        HttpRequest request = HttpRequest.newBuilder()', `            .uri(URI.create(${javaQuote(request.url)}))`);
  for (const h of headers) {
    if (RESTRICTED.includes(h.name.toLowerCase())) lines.push(`            // header ${javaQuote(h.name)} is set by the client and cannot be overridden`);
    else lines.push(`            .header(${javaQuote(h.name)}, ${javaQuote(h.value)})`);
  }
  lines.push(`            .method(${javaQuote(request.method)}, ${publisher})`, '            .build();', '        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());', '        System.out.println(response.statusCode());', '        System.out.println(response.body());', '    }', '}');
  return `${noteLines(request, '//')}${lines.join('\n')}\n`;
};
