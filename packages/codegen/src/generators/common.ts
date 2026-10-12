import { commentSafe } from '../escape';
import type { SnippetRequest } from '../types';

/** Render the request notes as line comments with the given prefix (empty when there are none). */
export function noteLines(request: SnippetRequest, prefix: string): string {
  if (!request.notes.length) return '';
  return `${request.notes.map((n) => `${prefix} ${commentSafe(n)}`).join('\n')}\n`;
}

export function methodHasBody(request: SnippetRequest): boolean {
  return request.body.kind !== 'none';
}

/** Headers minus the ones a given library sets itself (e.g. Content-Type for multipart). */
export function headersWithout(request: SnippetRequest, names: string[]): SnippetRequest['headers'] {
  const lower = names.map((n) => n.toLowerCase());
  return request.headers.filter((h) => !lower.includes(h.name.toLowerCase()));
}

/** Indent every line of a block. */
export function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => (l === '' ? l : pad + l))
    .join('\n');
}
