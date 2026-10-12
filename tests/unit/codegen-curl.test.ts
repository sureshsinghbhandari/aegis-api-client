import { describe, expect, it } from 'vitest';
import { isCurlCommand, parseCurl, tokenizeShell, CURL_MAX_INPUT } from '@aegis/codegen';
import type { RequestDraft } from '@aegis/core';

type Expect = Partial<Pick<RequestDraft, 'method' | 'url'>> & {
  query?: Array<[string, string]>;
  headers?: Array<[string, string]>;
  bodyMode?: RequestDraft['body']['mode'];
  raw?: string;
  rawLanguage?: string;
  urlencoded?: Array<[string, string]>;
  formData?: Array<[string, string]>;
  auth?: { type: string; params?: Record<string, unknown> };
  settings?: Record<string, unknown>;
  warnings?: RegExp[];
  noWarnings?: boolean;
  ok?: boolean;
};

const TABLE: Array<[string, string, Expect]> = [
  ['plain GET', 'curl https://api.example.com/users', { method: 'GET', url: 'https://api.example.com/users', noWarnings: true, auth: { type: 'inherit' } }],
  ['query string split into params', 'curl "https://api.example.com/users?limit=10&sort=name"', { url: 'https://api.example.com/users', query: [['limit', '10'], ['sort', 'name']] }],
  ['explicit method', 'curl -X DELETE https://api.example.com/users/1', { method: 'DELETE' }],
  ['attached short option value', 'curl -XPATCH https://api.example.com/users/1', { method: 'PATCH' }],
  ['long request option with equals', 'curl --request=PUT https://api.example.com/users/1', { method: 'PUT' }],
  ['lower-case method is normalised', 'curl -X post https://api.example.com/users', { method: 'POST' }],
  ['-d implies POST and urlencoded table', "curl https://api.example.com/login -d 'user=ada&pass=lovelace'", { method: 'POST', bodyMode: 'urlencoded', urlencoded: [['user', 'ada'], ['pass', 'lovelace']] }],
  ['JSON body with content type', `curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{"name":"Ada","tags":["x","y"]}'`, { method: 'POST', bodyMode: 'raw', raw: '{"name":"Ada","tags":["x","y"]}', rawLanguage: 'json', headers: [['Content-Type', 'application/json']] }],
  ['JSON body sniffed without content type', `curl https://api.example.com/users -d '{"a":1}'`, { method: 'POST', bodyMode: 'raw', rawLanguage: 'json' }],
  ['--data-raw keeps @ literally', "curl https://api.example.com/x --data-raw '@not-a-file'", { bodyMode: 'raw', raw: '@not-a-file', noWarnings: true }],
  ['--data @file is rejected', 'curl https://api.example.com/x --data @payload.json', { method: 'GET', bodyMode: 'none', warnings: [/file "payload\.json"/i, /rejected/] }],
  ['--data-binary @file is rejected', 'curl https://api.example.com/x --data-binary @/etc/passwd', { bodyMode: 'none', warnings: [/not imported/] }],
  ['--data-urlencode encodes the value', "curl https://api.example.com/x --data-urlencode 'q=a b&c'", { method: 'POST', bodyMode: 'urlencoded', urlencoded: [['q', 'a b&c']] }],
  ['--data-urlencode name@file is rejected', 'curl https://api.example.com/x --data-urlencode name@secrets.txt', { bodyMode: 'none', warnings: [/rejected/] }],
  ['multiple -d are joined with &', 'curl https://api.example.com/x -d a=1 -d b=2', { bodyMode: 'urlencoded', urlencoded: [['a', '1'], ['b', '2']] }],
  ['-G moves data to the query', 'curl -G https://api.example.com/search -d q=curl -d page=2', { method: 'GET', bodyMode: 'none', query: [['q', 'curl'], ['page', '2']] }],
  ['--json sets headers', `curl https://api.example.com/x --json '{"a":1}'`, { method: 'POST', bodyMode: 'raw', rawLanguage: 'json', headers: [['Content-Type', 'application/json'], ['Accept', 'application/json']] }],
  ['-F text parts', "curl https://api.example.com/upload -F name=Ada -F 'note=hello world'", { method: 'POST', bodyMode: 'formdata', formData: [['name', 'Ada'], ['note', 'hello world']] }],
  ['-F file part is rejected but text parts kept', "curl https://api.example.com/upload -F name=Ada -F 'file=@/home/ada/secret.pdf;type=application/pdf'", { bodyMode: 'formdata', formData: [['name', 'Ada']], warnings: [/Form field "file" references a local file/] }],
  ['-F <file part is rejected', 'curl https://api.example.com/upload -F "data=<payload.txt"', { bodyMode: 'formdata', formData: [], warnings: [/references a local file/] }],
  ['--form-string keeps @ literally', 'curl https://api.example.com/upload --form-string "handle=@ada"', { bodyMode: 'formdata', formData: [['handle', '@ada']], noWarnings: true }],
  ['-F with content type suffix', "curl https://api.example.com/upload -F 'meta={\"a\":1};type=application/json'", { bodyMode: 'formdata', formData: [['meta', '{"a":1}']] }],
  ['-u basic auth', 'curl -u ada:lovelace https://api.example.com/private', { auth: { type: 'basic', params: { username: 'ada', password: 'lovelace' } } }],
  ['-u without password warns', 'curl -u ada https://api.example.com/private', { auth: { type: 'basic', params: { username: 'ada', password: '' } }, warnings: [/without a password/] }],
  ['--user with colon in password', "curl --user 'ada:pa:ss' https://api.example.com/private", { auth: { type: 'basic', params: { username: 'ada', password: 'pa:ss' } } }],
  ['--oauth2-bearer becomes bearer auth', 'curl --oauth2-bearer tok123 https://api.example.com/me', { auth: { type: 'bearer', params: { token: 'tok123' } } }],
  ['Authorization header stays a header', "curl https://api.example.com/me -H 'Authorization: Bearer abc'", { headers: [['Authorization', 'Bearer abc']], auth: { type: 'inherit' } }],
  ['--url option', 'curl --url https://api.example.com/x -H "Accept: */*"', { url: 'https://api.example.com/x', headers: [['Accept', '*/*']] }],
  ['-k only warns and never touches TLS', 'curl -k https://self-signed.example.com/', { settings: {}, warnings: [/TLS certificate verification stays enabled/] }],
  ['--insecure long form', 'curl --insecure https://self-signed.example.com/', { settings: {}, warnings: [/insecure/] }],
  ['-L sets followRedirects', 'curl -L https://api.example.com/redirect', { settings: { followRedirects: true } }],
  ['combined short flags -sSL', 'curl -sSL https://api.example.com/redirect', { settings: { followRedirects: true }, warnings: [/-s is not supported/, /-S is not supported/] }],
  ['--compressed adds Accept-Encoding', 'curl --compressed https://api.example.com/x', { headers: [['Accept-Encoding', 'deflate, gzip, br']] }],
  ['-b cookie string becomes a Cookie header', "curl -b 'session=abc; theme=dark' https://api.example.com/x", { headers: [['Cookie', 'session=abc; theme=dark']] }],
  ['-b cookie file is rejected', 'curl -b cookies.txt https://api.example.com/x', { headers: [], warnings: [/Cookie file "cookies\.txt" is not imported/] }],
  ['-A and -e become headers', "curl -A 'MyAgent/1.0' -e https://ref.example.com https://api.example.com/x", { headers: [['User-Agent', 'MyAgent/1.0'], ['Referer', 'https://ref.example.com']] }],
  ['-I becomes HEAD', 'curl -I https://api.example.com/x', { method: 'HEAD' }],
  ['-m sets the timeout', 'curl -m 2.5 https://api.example.com/x', { settings: { timeoutMs: 2500 } }],
  ['--max-redirs', 'curl -L --max-redirs 3 https://api.example.com/x', { settings: { followRedirects: true, maxRedirects: 3 } }],
  ['--http1.1', 'curl --http1.1 https://api.example.com/x', { settings: { httpVersion: '1.1' } }],
  ['empty header with semicolon', "curl https://api.example.com/x -H 'X-Empty;'", { headers: [['X-Empty', '']] }],
  ['header without colon warns', "curl https://api.example.com/x -H 'NoColon'", { headers: [], warnings: [/has no ":"/] }],
  ['unsupported option with value does not eat the URL', 'curl -o out.json --cacert ca.pem https://api.example.com/x', { url: 'https://api.example.com/x', warnings: [/-o is not supported/, /--cacert is not supported/] }],
  ['-T upload file is rejected', 'curl -T big.bin https://api.example.com/x', { url: 'https://api.example.com/x', bodyMode: 'none', warnings: [/upload-file/] }],
  ['POSIX line continuations', "curl -X POST https://api.example.com/x \\\n  -H 'Accept: application/json' \\\n  -d 'a=1'", { method: 'POST', headers: [['Accept', 'application/json']], urlencoded: [['a', '1']] }],
  ['Windows ^ continuations with double quotes', 'curl -X POST "https://api.example.com/x" ^\r\n  -H "Accept: application/json" ^\r\n  -d "{\\"a\\":1}"', { method: 'POST', headers: [['Accept', 'application/json']], raw: '{"a":1}', rawLanguage: 'json' }],
  ['PowerShell backtick continuations', "curl https://api.example.com/x `\n  -H 'Accept: text/plain'", { headers: [['Accept', 'text/plain']] }],
  ["$'...' ANSI-C quoting", "curl https://api.example.com/x -H $'X-Tab:\\tvalue' -d $'line1\\nline2'", { headers: [['X-Tab', 'value']], bodyMode: 'raw', raw: 'line1\nline2' }],
  ['single quotes with escaped quote inside double quotes', `curl https://api.example.com/x -d "{\\"name\\":\\"O'Hara\\"}"`, { raw: `{"name":"O'Hara"}` }],
  ["single quote with '\\'' idiom", "curl https://api.example.com/x -H 'X-Q: it'\\''s'", { headers: [['X-Q', "it's"]] }],
  ['unterminated quote warns but still parses', "curl https://api.example.com/x -H 'Accept: text/plain", { headers: [['Accept', 'text/plain']], warnings: [/Unterminated single quote/] }],
  ['variables survive in URL and headers', "curl '{{baseUrl}}/users?limit={{limit}}' -H 'X-Api-Key: {{apiKey}}'", { url: '{{baseUrl}}/users', query: [['limit', '{{limit}}']], headers: [['X-Api-Key', '{{apiKey}}']] }],
  ['path variables are detected', 'curl https://api.example.com/users/:id/posts', { url: 'https://api.example.com/users/:id/posts' }],
  ['shell prompt prefix is stripped', '$ curl https://api.example.com/x', { url: 'https://api.example.com/x', noWarnings: true }],
  ['curl.exe is accepted', 'curl.exe https://api.example.com/x', { url: 'https://api.example.com/x', noWarnings: true }],
  ['second URL is ignored with a warning', 'curl https://a.example.com https://b.example.com', { url: 'https://a.example.com', warnings: [/only the first URL/] }],
  ['no URL fails', 'curl -X POST -H "A: b"', { ok: false, warnings: [/No URL found/] }],
  ['text without curl prefix still parses', 'https://api.example.com/x -H "Accept: text/plain"', { url: 'https://api.example.com/x', warnings: [/does not start with "curl"/] }],
  ['end of options marker', 'curl -- https://api.example.com/x', { url: 'https://api.example.com/x', noWarnings: true }],
];

describe('parseCurl table', () => {
  for (const [name, command, want] of TABLE) {
    it(name, () => {
      const { draft, warnings, ok } = parseCurl(command);
      expect(ok).toBe(want.ok ?? true);
      if (want.method) expect(draft.method).toBe(want.method);
      if (want.url !== undefined) expect(draft.url).toBe(want.url);
      if (want.query) expect(draft.queryParams.map((q) => [q.key, q.value])).toEqual(want.query);
      if (want.headers) expect(draft.headers.map((h) => [h.key, h.value])).toEqual(want.headers);
      if (want.bodyMode) expect(draft.body.mode).toBe(want.bodyMode);
      if (want.raw !== undefined) expect(draft.body.raw).toBe(want.raw);
      if (want.rawLanguage) expect(draft.body.rawLanguage).toBe(want.rawLanguage);
      if (want.urlencoded) expect((draft.body.urlencoded ?? []).map((e) => [e.key, e.value])).toEqual(want.urlencoded);
      if (want.formData) expect((draft.body.formData ?? []).map((e) => [e.key, e.value])).toEqual(want.formData);
      if (want.auth) {
        expect(draft.auth.type).toBe(want.auth.type);
        if (want.auth.params) expect(draft.auth.params).toEqual(want.auth.params);
      }
      if (want.settings) expect(draft.settings).toEqual(want.settings);
      if (want.noWarnings) expect(warnings).toEqual([]);
      for (const w of want.warnings ?? []) expect(warnings.some((m) => w.test(m)), `expected a warning matching ${w}, got ${JSON.stringify(warnings)}`).toBe(true);
    });
  }

  it('has at least 30 table rows', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(30);
  });
});

describe('parseCurl safety', () => {
  it('never stores file paths anywhere in the draft', () => {
    const { draft } = parseCurl("curl https://x.test -F 'f=@/home/ada/id_rsa' --data-binary @/etc/shadow -b /tmp/cookies.txt -T /secret.bin --cacert /ca.pem");
    const json = JSON.stringify(draft);
    expect(json).not.toContain('id_rsa');
    expect(json).not.toContain('shadow');
    expect(json).not.toContain('cookies.txt');
    expect(json).not.toContain('secret.bin');
    expect(json).not.toContain('ca.pem');
    expect(draft.body.formData).toEqual([]);
  });
  it('never disables TLS verification', () => {
    const { draft } = parseCurl('curl -k --insecure https://x.test');
    expect(draft.settings.verifyTls).toBeUndefined();
    expect(JSON.stringify(draft)).not.toContain('"verifyTls":false');
  });
  it('rejects oversized input without throwing', () => {
    const { ok, warnings } = parseCurl(`curl ${'a'.repeat(CURL_MAX_INPUT + 1)}`);
    expect(ok).toBe(false);
    expect(warnings[0]).toMatch(/larger than 1 MiB/);
  });
  it('names the request from the method and URL', () => {
    const { draft } = parseCurl('curl -X PUT https://api.example.com/users/7?x=1');
    expect(draft.name).toBe('PUT api.example.com/users/7');
  });
  it('keeps the URL fragment in the url field with a warning', () => {
    const { draft, warnings } = parseCurl('curl https://api.example.com/x?a=1#frag');
    expect(draft.url).toBe('https://api.example.com/x#frag');
    expect(draft.queryParams).toEqual([{ key: 'a', value: '1', enabled: true }]);
    expect(warnings.some((w) => /fragment/.test(w))).toBe(true);
  });
  it('produces a complete RequestDraft', () => {
    const { draft } = parseCurl('curl https://x.test');
    expect(Object.keys(draft).sort()).toEqual(['auth', 'body', 'description', 'examples', 'headers', 'metadata', 'method', 'name', 'pathVariables', 'queryParams', 'scripts', 'settings', 'url']);
    expect(draft.pathVariables).toEqual([]);
  });
  it('fills path variables for :segments', () => {
    const { draft } = parseCurl('curl https://x.test/users/:id');
    expect(draft.pathVariables).toEqual([{ key: 'id', value: '', enabled: true }]);
  });
});

describe('tokenizeShell', () => {
  it('handles mixed quoting and escapes', () => {
    expect(tokenizeShell(`a 'b c' "d \\"e\\" $x" f\\ g $'h\\ti' \\\n j`).tokens).toEqual(['a', 'b c', 'd "e" $x', 'f g', 'h\ti', 'j']);
  });
  it('treats caret as an escape only before cmd.exe specials', () => {
    expect(tokenizeShell('a^"b c^d').tokens).toEqual(['a"b', 'c^d']);
  });
  it('decodes ANSI-C hex, unicode and octal escapes', () => {
    expect(tokenizeShell("$'\\x41\\u00e9\\101\\\\'").tokens).toEqual(['AéA\\']);
  });
});

describe('isCurlCommand', () => {
  it('recognises curl invocations only', () => {
    expect(isCurlCommand('curl https://x.test')).toBe(true);
    expect(isCurlCommand('  CURL -X POST https://x.test')).toBe(true);
    expect(isCurlCommand('$ curl https://x.test')).toBe(true);
    expect(isCurlCommand('sudo curl https://x.test')).toBe(true);
    expect(isCurlCommand('curl.exe https://x.test')).toBe(true);
    expect(isCurlCommand('curl')).toBe(true);
    expect(isCurlCommand('https://x.test/curl ')).toBe(false);
    expect(isCurlCommand('curlish https://x.test')).toBe(false);
    expect(isCurlCommand('')).toBe(false);
  });
});
