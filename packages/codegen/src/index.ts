/**
 * @aegis/codegen - cURL import and code snippet generation. Pure TypeScript with no
 * Node APIs so the renderer and the CLI can share it.
 */
import { GENERATORS } from './generators/index';
import { SNIPPET_LANGUAGES, type SnippetLanguage, type SnippetRequest } from './types';

export { parseCurl, isCurlCommand, tokenizeShell, CURL_MAX_INPUT, type CurlParseResult } from './curl-parse';
export { prepareSnippetRequest, snippetRequestFromSent, isSecretRef, fileNameOf, type DisplayVariable, type PrepareOptions } from './prepare';
export { SNIPPET_LANGUAGES, type SnippetLanguage, type SnippetRequest, type SnippetBody, type SnippetHeader, type SnippetFormPart, type SnippetGenerator } from './types';
export { shellQuote, jsQuote, pyQuote, goQuote, javaQuote, csharpQuote, rubyQuote, phpQuote, psQuote, base64Utf8 } from './escape';

export function isSnippetLanguage(value: string): value is SnippetLanguage {
  return SNIPPET_LANGUAGES.some((l) => l.id === value);
}

/** Generate a code snippet for a display-resolved request (see `prepareSnippetRequest`). */
export function generateSnippet(language: SnippetLanguage, input: SnippetRequest): string {
  const generator = GENERATORS[language];
  if (!generator) throw new TypeError(`Unknown snippet language "${String(language)}".`);
  return generator(input);
}
