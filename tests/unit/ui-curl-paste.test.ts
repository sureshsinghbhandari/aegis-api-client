import { describe, expect, it } from 'vitest';
import { CURL_PASTE_MAX, looksLikeCurlPaste, pastedText } from '../../apps/desktop/renderer/src/lib/curl-paste';

describe('curl paste detection', () => {
  it('offers an import for pasted curl commands only', () => {
    expect(looksLikeCurlPaste('curl https://api.example.com/users')).toBe(true);
    expect(looksLikeCurlPaste("  curl -X POST 'https://x.test' -d a=1")).toBe(true);
    expect(looksLikeCurlPaste('$ curl https://x.test')).toBe(true);
    expect(looksLikeCurlPaste('https://api.example.com/users')).toBe(false);
    expect(looksLikeCurlPaste('{{baseUrl}}/curl')).toBe(false);
    expect(looksLikeCurlPaste('')).toBe(false);
    expect(looksLikeCurlPaste(null)).toBe(false);
    expect(looksLikeCurlPaste(undefined)).toBe(false);
  });
  it('ignores oversized clipboard text', () => {
    expect(looksLikeCurlPaste(`curl ${'x'.repeat(CURL_PASTE_MAX)}`)).toBe(false);
  });
  it('reads plain text from a clipboard-like object and tolerates failures', () => {
    expect(pastedText({ getData: (t) => (t === 'text/plain' ? 'curl https://x.test' : '') })).toBe('curl https://x.test');
    expect(pastedText({ getData: () => '' })).toBeNull();
    expect(
      pastedText({
        getData: () => {
          throw new Error('denied');
        },
      }),
    ).toBeNull();
    expect(pastedText(null)).toBeNull();
  });
});
