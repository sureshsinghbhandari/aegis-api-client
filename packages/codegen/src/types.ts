/**
 * Input shape shared by every snippet generator: a request that has already been
 * resolved for DISPLAY (variables substituted except secrets, auth rendered as
 * headers/placeholders, only enabled rows). See `prepareSnippetRequest`.
 */

export interface SnippetHeader {
  name: string;
  value: string;
}

export interface SnippetFormPart {
  name: string;
  /** Text value, or for `file` parts a placeholder file name (never a local path). */
  value: string;
  file: boolean;
  contentType?: string;
}

export type SnippetBody =
  | { kind: 'none' }
  | { kind: 'text'; text: string; contentType: string }
  | { kind: 'urlencoded'; entries: Array<{ name: string; value: string }> }
  | { kind: 'multipart'; parts: SnippetFormPart[] }
  /** Binary upload; `fileName` is a placeholder/base name, never a full local path. */
  | { kind: 'file'; fileName: string; contentType: string };

export interface SnippetRequest {
  method: string;
  /** Final URL including the enabled query parameters (and API-key query auth). */
  url: string;
  headers: SnippetHeader[];
  body: SnippetBody;
  /** Human-readable remarks rendered as comments at the top of the snippet. */
  notes: string[];
}

export const SNIPPET_LANGUAGES = [
  { id: 'curl', label: 'cURL' },
  { id: 'http', label: 'HTTP/1.1 (raw)' },
  { id: 'javascript-fetch', label: 'JavaScript (fetch)' },
  { id: 'node-fetch', label: 'Node.js (fetch / undici)' },
  { id: 'python-requests', label: 'Python (requests)' },
  { id: 'powershell', label: 'PowerShell (Invoke-RestMethod)' },
  { id: 'go', label: 'Go (net/http)' },
  { id: 'java', label: 'Java (HttpClient)' },
  { id: 'csharp', label: 'C# (HttpClient)' },
  { id: 'php-curl', label: 'PHP (curl)' },
  { id: 'ruby', label: 'Ruby (Net::HTTP)' },
  { id: 'httpie', label: 'HTTPie' },
] as const;

export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number]['id'];

export type SnippetGenerator = (request: SnippetRequest) => string;
