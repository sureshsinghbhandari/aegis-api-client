/**
 * Paste detection for the URL bar: when the pasted text is a curl command the UI offers
 * "Import cURL" instead of dropping the whole command into the URL field. Pure (no React).
 */
import { isCurlCommand } from '@aegis/codegen';

/** Upper bound for text we are willing to parse from the clipboard. */
export const CURL_PASTE_MAX = 256 * 1024;

/** True when a pasted text should be offered as a cURL import. */
export function looksLikeCurlPaste(text: string | null | undefined): boolean {
  if (!text || text.length > CURL_PASTE_MAX) return false;
  return isCurlCommand(text);
}

/** Text of a paste event (`null` when the clipboard holds no text). */
export function pastedText(data: { getData(type: string): string } | null | undefined): string | null {
  if (!data) return null;
  try {
    const text = data.getData('text/plain');
    return typeof text === 'string' && text !== '' ? text : null;
  } catch {
    return null;
  }
}
