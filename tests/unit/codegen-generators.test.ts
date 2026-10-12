import { describe, expect, it } from 'vitest';
import {
  base64Utf8,
  csharpQuote,
  generateSnippet,
  goQuote,
  javaQuote,
  jsQuote,
  phpQuote,
  prepareSnippetRequest,
  psQuote,
  pyQuote,
  rubyQuote,
  shellQuote,
  snippetRequestFromSent,
  SNIPPET_LANGUAGES,
  tokenizeShell,
  type SnippetLanguage,
  type SnippetRequest,
} from '@aegis/codegen';
import { emptyRequestDraft, type RequestDraft } from '@aegis/core';

const LANGUAGES = SNIPPET_LANGUAGES.map((l) => l.id);

function fixture(overrides: Partial<RequestDraft> = {}): RequestDraft {
  return emptyRequestDraft({
    method: 'POST',
    url: '{{baseUrl}}/users',
    queryParams: [
      { key: 'limit', value: '10', enabled: true },
      { key: 'off', value: 'x', enabled: false },
    ],
    headers: [
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Off', value: 'no', enabled: false },
    ],
    body: { mode: 'raw', rawLanguage: 'json', raw: '{"name":"Ada"}' },
    auth: { type: 'bearer', params: { token: 'secret-token' } },
    ...overrides,
  });
}

const VARIABLES = { baseUrl: { value: 'https://api.example.com', secret: false }, apiKey: { value: 'secretref:k1', secret: true } };

describe('prepareSnippetRequest', () => {
  it('resolves non-secret variables, keeps only enabled rows and masks the bearer token', () => {
    const r = prepareSnippetRequest(fixture(), { variables: VARIABLES });
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://api.example.com/users?limit=10');
    expect(r.headers).toEqual([
      { name: 'Accept', value: 'application/json' },
      { name: 'Authorization', value: 'Bearer {{token}}' },
      { name: 'Content-Type', value: 'application/json' },
    ]);
    expect(r.body).toEqual({ kind: 'text', text: '{"name":"Ada"}', contentType: 'application/json' });
    expect(r.notes.join('\n')).toMatch(/Bearer token is a placeholder/);
    expect(JSON.stringify(r)).not.toContain('secret-token');
  });
  it('keeps secret variables as placeholders and lists them in the notes', () => {
    const r = prepareSnippetRequest(fixture({ headers: [{ key: 'X-Api-Key', value: '{{apiKey}}', enabled: true }] }), { variables: VARIABLES });
    expect(r.headers[0]).toEqual({ name: 'X-Api-Key', value: '{{apiKey}}' });
    expect(r.notes).toContain('Secret variables are placeholders: {{apiKey}}.');
    expect(JSON.stringify(r)).not.toContain('secretref:');
  });
  it('reveals secrets only when asked and only through the revealed map', () => {
    const draft = fixture({ headers: [{ key: 'X-Api-Key', value: '{{apiKey}}', enabled: true }], auth: { type: 'bearer', params: { token: 'secretref:t1' } } });
    const masked = prepareSnippetRequest(draft, { variables: VARIABLES, revealSecrets: true });
    expect(masked.headers.map((h) => h.value)).toEqual(['{{apiKey}}', 'Bearer {{token}}', 'application/json']);
    const revealed = prepareSnippetRequest(draft, { variables: VARIABLES, revealSecrets: true, revealed: { 'secretref:k1': 'KEY', 'secretref:t1': 'TOKEN' } });
    expect(revealed.headers.map((h) => h.value)).toEqual(['KEY', 'Bearer TOKEN', 'application/json']);
    expect(revealed.notes.some((n) => /placeholder/.test(n))).toBe(false);
  });
  it('reports unresolved variables', () => {
    const r = prepareSnippetRequest(fixture({ url: '{{nope}}/x' }));
    expect(r.url).toBe('http://{{nope}}/x?limit=10');
    expect(r.notes).toContain('Unresolved variables: {{nope}}.');
  });
  it('renders basic auth as a base64 header when nothing is secret-masked', () => {
    const r = prepareSnippetRequest(fixture({ auth: { type: 'basic', params: { username: 'ada', password: 'pw' } } }), { revealSecrets: true });
    expect(r.headers.find((h) => h.name === 'Authorization')?.value).toBe(`Basic ${base64Utf8('ada:pw')}`);
    const masked = prepareSnippetRequest(fixture({ auth: { type: 'basic', params: { username: 'ada', password: 'pw' } } }));
    expect(masked.headers.find((h) => h.name === 'Authorization')?.value).toBe('Basic {{base64(ada:{{password}})}}');
  });
  it('renders API keys in header or query', () => {
    const header = prepareSnippetRequest(fixture({ auth: { type: 'apikey', params: { key: 'X-Key', value: 'v', in: 'header' } } }), { revealSecrets: true });
    expect(header.headers).toContainEqual({ name: 'X-Key', value: 'v' });
    const query = prepareSnippetRequest(fixture({ auth: { type: 'apikey', params: { key: 'api_key', value: 'v', in: 'query' } } }), { variables: VARIABLES });
    expect(query.url).toBe('https://api.example.com/users?limit=10&api_key=%7B%7Bvalue%7D%7D'.replace('%7B%7Bvalue%7D%7D', '{{value}}'));
  });
  it('never computes AWS / JWT / OAuth1 signatures, even when secrets are revealed', () => {
    for (const type of ['awsv4', 'jwt', 'oauth1'] as const) {
      const r = prepareSnippetRequest(fixture({ auth: { type, params: { secretKey: 'S', secret: 'S', consumerSecret: 'S', privateKey: 'S' } } }), { revealSecrets: true });
      const authz = r.headers.find((h) => h.name === 'Authorization')!.value;
      expect(authz).toMatch(/\{\{/);
      expect(r.notes.join(' ')).toMatch(/send time/);
      expect(JSON.stringify(r)).not.toContain('"S"');
    }
  });
  it('shows the OAuth2 access token as a placeholder unless revealed (never the client secret)', () => {
    const auth = { type: 'oauth2' as const, params: { accessToken: 'secretref:a', clientSecret: 'secretref:c', headerPrefix: 'Bearer' } };
    const masked = prepareSnippetRequest(fixture({ auth }));
    expect(masked.headers.find((h) => h.name === 'Authorization')?.value).toBe('Bearer {{accessToken}}');
    expect(masked.notes.join(' ')).toMatch(/obtained by the client at send time/);
    const revealed = prepareSnippetRequest(fixture({ auth }), { revealSecrets: true, revealed: { 'secretref:a': 'TOK', 'secretref:c': 'CLIENT' } });
    expect(revealed.headers.find((h) => h.name === 'Authorization')?.value).toBe('Bearer TOK');
    expect(JSON.stringify(revealed)).not.toContain('CLIENT');
  });
  it('uses the effective auth for inherited requests and notes the source', () => {
    const r = prepareSnippetRequest(fixture({ auth: { type: 'inherit', params: {} } }), { effectiveAuth: { type: 'bearer', params: { token: 'secretref:x' } }, inheritedFrom: 'Collection "Pets"' });
    expect(r.headers.find((h) => h.name === 'Authorization')?.value).toBe('Bearer {{token}}');
    expect(r.notes.join(' ')).toContain('inherited from Collection "Pets"');
    const plain = prepareSnippetRequest(fixture({ auth: { type: 'inherit', params: {} } }));
    expect(plain.headers.some((h) => h.name === 'Authorization')).toBe(false);
    expect(plain.notes.join(' ')).toMatch(/inherited from the collection\/folder/);
  });
  it('does not render auth over an explicit Authorization header', () => {
    const r = prepareSnippetRequest(fixture({ headers: [{ key: 'Authorization', value: 'Bearer mine', enabled: true }] }));
    expect(r.headers.filter((h) => h.name === 'Authorization')).toEqual([{ name: 'Authorization', value: 'Bearer mine' }]);
  });
  it('builds urlencoded, form-data (file names only), binary and GraphQL bodies', () => {
    const urlencoded = prepareSnippetRequest(fixture({ body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1', enabled: true }, { key: 'b', value: '2', enabled: false }] } }));
    expect(urlencoded.body).toEqual({ kind: 'urlencoded', entries: [{ name: 'a', value: '1' }] });
    expect(urlencoded.headers).toContainEqual({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });

    const form = prepareSnippetRequest(fixture({ body: { mode: 'formdata', formData: [{ key: 'f', type: 'file', value: '', filePath: 'C:\\Users\\ada\\secret\\report.pdf', enabled: true }, { key: 't', type: 'text', value: 'x', enabled: true }, { key: 'v', type: 'variable', value: 'baseUrl', enabled: true }] } }), { variables: VARIABLES });
    expect(form.body).toEqual({ kind: 'multipart', parts: [{ name: 'f', value: 'report.pdf', file: true }, { name: 't', value: 'x', file: false }, { name: 'v', value: 'https://api.example.com', file: false }] });
    expect(JSON.stringify(form)).not.toContain('Users');

    const binary = prepareSnippetRequest(fixture({ body: { mode: 'binary', filePath: '/home/ada/private/photo.png' } }));
    expect(binary.body).toEqual({ kind: 'file', fileName: 'photo.png', contentType: 'application/octet-stream' });
    expect(JSON.stringify(binary)).not.toContain('/home/ada');

    const gql = prepareSnippetRequest(fixture({ body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}', operationName: 'Me' } } }));
    expect(gql.body.kind).toBe('text');
    expect(JSON.parse((gql.body as { text: string }).text)).toEqual({ query: '{ me { id } }', variables: { a: 1 }, operationName: 'Me' });
    expect(gql.headers).toContainEqual({ name: 'Content-Type', value: 'application/json' });
  });
  it('flattens header values with line breaks (no request splitting)', () => {
    const r = prepareSnippetRequest(fixture({ headers: [{ key: 'X-Evil', value: 'a\r\nInjected: yes', enabled: true }] }));
    expect(r.headers[0]).toEqual({ name: 'X-Evil', value: 'a Injected: yes' });
    expect(r.notes.join(' ')).toMatch(/flattened/);
  });
  it('builds the "as sent" input from the redacted request view', () => {
    const r = snippetRequestFromSent({ method: 'post', url: 'https://x.test/a?b=1', headers: [{ name: 'Authorization', value: '***' }], bodyPreview: '{"a":1}' });
    expect(r.method).toBe('POST');
    expect(r.body).toEqual({ kind: 'text', text: '{"a":1}', contentType: 'text/plain' });
    expect(r.notes[0]).toMatch(/redacted/);
  });
});

describe('golden snippets', () => {
  const request = prepareSnippetRequest(fixture(), { variables: VARIABLES });

  it('cURL', () => {
    expect(generateSnippet('curl', request)).toBe(
      [
        '# Bearer token is a placeholder; use "Reveal secrets" or paste the token.',
        "curl 'https://api.example.com/users?limit=10' \\",
        "  -H 'Accept: application/json' \\",
        "  -H 'Authorization: Bearer {{token}}' \\",
        "  -H 'Content-Type: application/json' \\",
        `  --data-raw '{"name":"Ada"}'`,
        '',
      ].join('\n'),
    );
  });
  it('HTTP/1.1', () => {
    expect(generateSnippet('http', request)).toBe(
      [
        '# Bearer token is a placeholder; use "Reveal secrets" or paste the token.',
        'POST /users?limit=10 HTTP/1.1',
        'Host: api.example.com',
        'Accept: application/json',
        'Authorization: Bearer {{token}}',
        'Content-Type: application/json',
        'Content-Length: 14',
        '',
        '{"name":"Ada"}',
        '',
      ].join('\r\n'),
    );
  });
  it('JavaScript fetch', () => {
    expect(generateSnippet('javascript-fetch', request)).toBe(
      [
        '// Bearer token is a placeholder; use "Reveal secrets" or paste the token.',
        'const body = "{\\"name\\":\\"Ada\\"}";',
        'const response = await fetch("https://api.example.com/users?limit=10", {',
        '  method: "POST",',
        '  headers: {',
        '    "Accept": "application/json",',
        '    "Authorization": "Bearer {{token}}",',
        '    "Content-Type": "application/json",',
        '  },',
        '  body: body,',
        '});',
        'console.log(response.status, await response.text());',
        '',
      ].join('\n'),
    );
  });
  it('Node fetch', () => {
    const code = generateSnippet('node-fetch', request);
    expect(code).toContain('// Node.js 18+ (global fetch, powered by undici)');
    expect(code).toContain('const response = await fetch("https://api.example.com/users?limit=10", {');
    expect(code).not.toContain('readFile');
  });
  it('Python requests', () => {
    expect(generateSnippet('python-requests', request)).toBe(
      [
        '# Bearer token is a placeholder; use "Reveal secrets" or paste the token.',
        'import requests',
        '',
        'url = "https://api.example.com/users?limit=10"',
        'headers = {',
        '    "Accept": "application/json",',
        '    "Authorization": "Bearer {{token}}",',
        '    "Content-Type": "application/json",',
        '}',
        'payload = "{\\"name\\":\\"Ada\\"}"',
        '',
        'response = requests.request("POST", url, headers=headers, data=payload.encode("utf-8"))',
        'print(response.status_code)',
        'print(response.text)',
        '',
      ].join('\n'),
    );
  });
  it('PowerShell', () => {
    expect(generateSnippet('powershell', request)).toBe(
      [
        '# Bearer token is a placeholder; use "Reveal secrets" or paste the token.',
        `$body = '{"name":"Ada"}'`,
        '$headers = @{',
        "  'Accept' = 'application/json'",
        "  'Authorization' = 'Bearer {{token}}'",
        '}',
        "$response = Invoke-RestMethod -Method 'POST' -Uri 'https://api.example.com/users?limit=10' -Headers $headers -ContentType 'application/json' -Body $body",
        '$response',
        '',
      ].join('\n'),
    );
  });
  it('HTTPie', () => {
    expect(generateSnippet('httpie', request)).toBe(
      [
        '# Bearer token is a placeholder; use "Reveal secrets" or paste the token.',
        "http POST 'https://api.example.com/users?limit=10' \\",
        "  'Accept:application/json' \\",
        "  'Authorization:Bearer {{token}}' \\",
        "  'Content-Type:application/json' \\",
        `  --raw '{"name":"Ada"}'`,
        '',
      ].join('\n'),
    );
  });
  it('Go', () => {
    const code = generateSnippet('go', request);
    expect(code).toContain('payload := strings.NewReader("{\\"name\\":\\"Ada\\"}")');
    expect(code).toContain('req, err := http.NewRequest("POST", "https://api.example.com/users?limit=10", payload)');
    expect(code).toContain('req.Header.Set("Authorization", "Bearer {{token}}")');
    expect(code).toContain('"net/http"');
  });
  it('Java', () => {
    const code = generateSnippet('java', request);
    expect(code).toContain('.uri(URI.create("https://api.example.com/users?limit=10"))');
    expect(code).toContain('.header("Authorization", "Bearer {{token}}")');
    expect(code).toContain('.method("POST", HttpRequest.BodyPublishers.ofString("{\\"name\\":\\"Ada\\"}"))');
  });
  it('C#', () => {
    const code = generateSnippet('csharp', request);
    expect(code).toContain('new HttpRequestMessage(new HttpMethod("POST"), "https://api.example.com/users?limit=10")');
    expect(code).toContain('request.Headers.TryAddWithoutValidation("Authorization", "Bearer {{token}}");');
    expect(code).toContain('request.Content = new StringContent("{\\"name\\":\\"Ada\\"}", Encoding.UTF8);');
    expect(code).toContain('MediaTypeHeaderValue.Parse("application/json")');
  });
  it('PHP', () => {
    const code = generateSnippet('php-curl', request);
    expect(code.startsWith('<?php')).toBe(true);
    expect(code).toContain("CURLOPT_URL => 'https://api.example.com/users?limit=10',");
    expect(code).toContain("CURLOPT_CUSTOMREQUEST => 'POST',");
    expect(code).toContain(`CURLOPT_POSTFIELDS => '{"name":"Ada"}',`);
    expect(code).toContain("'Authorization: Bearer {{token}}',");
  });
  it('Ruby', () => {
    const code = generateSnippet('ruby', request);
    expect(code).toContain('uri = URI("https://api.example.com/users?limit=10")');
    expect(code).toContain('request = Net::HTTP::GenericRequest.new("POST", true, true, uri)');
    expect(code).toContain('request.body = "{\\"name\\":\\"Ada\\"}"');
    expect(code).toContain('request["Authorization"] = "Bearer {{token}}"');
  });
});

describe('body kinds across every language', () => {
  const kinds: Array<[string, RequestDraft['body']]> = [
    ['none', { mode: 'none' }],
    ['urlencoded', { mode: 'urlencoded', urlencoded: [{ key: 'a b', value: 'c&d', enabled: true }] }],
    ['formdata', { mode: 'formdata', formData: [{ key: 'f', type: 'file', value: '', filePath: '/x/report.pdf', enabled: true }, { key: 't', type: 'text', value: 'v', enabled: true }] }],
    ['binary', { mode: 'binary', filePath: '/x/photo.png' }],
  ];
  for (const [name, body] of kinds) {
    for (const language of LANGUAGES) {
      it(`${language} renders a ${name} body`, () => {
        const code = generateSnippet(language, prepareSnippetRequest(fixture({ method: name === 'none' ? 'GET' : 'POST', body }), { variables: VARIABLES }));
        expect(code.length).toBeGreaterThan(20);
        if (language === 'http') {
          expect(code).toContain(`${name === 'none' ? 'GET' : 'POST'} /users?limit=10 HTTP/1.1\r\nHost: api.example.com`);
        } else expect(code).toContain('https://api.example.com/users?limit=10');
        if (name === 'formdata') {
          expect(code).toContain('report.pdf');
          expect(code).not.toContain('/x/report.pdf');
        }
        if (name === 'binary') expect(code).not.toContain('/x/photo.png');
        if (name === 'urlencoded') expect(code).toMatch(/a b|a\+b|a%20b/);
      });
    }
  }
  it('GET without a body omits -X in cURL and uses --head for HEAD', () => {
    expect(generateSnippet('curl', prepareSnippetRequest(fixture({ method: 'GET', body: { mode: 'none' }, auth: { type: 'none', params: {} }, headers: [] }), { variables: VARIABLES }))).toBe("curl 'https://api.example.com/users?limit=10'\n");
    expect(generateSnippet('curl', prepareSnippetRequest(fixture({ method: 'HEAD', body: { mode: 'none' }, auth: { type: 'none', params: {} }, headers: [] }), { variables: VARIABLES }))).toBe("curl -X HEAD --head 'https://api.example.com/users?limit=10'\n");
  });
});

// ----------------------------------------------------------------------------- quoting safety

/**
 * Scan a literal: between the delimiters no raw line break and no unescaped delimiter may appear.
 * `separators`: whether raw U+2028/2029 are acceptable (they are not line terminators in PowerShell/PHP single quotes).
 */
function assertSafeLiteral(literal: string, delim: string, escape: 'backslash' | 'double' | 'backtick', separators: 'forbid' | 'allow' = 'forbid'): void {
  expect(literal.startsWith(delim) && literal.endsWith(delim) && literal.length >= 2, `delimited: ${literal}`).toBe(true);
  const inner = literal.slice(1, -1);
  expect(inner, `raw line break in ${literal}`).not.toMatch(separators === 'forbid' ? /[\r\n\u2028\u2029]/ : /[\r\n]/);
  const esc = escape === 'backslash' ? '\\' : escape === 'backtick' ? '`' : null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (esc && ch === esc) {
      i++;
      continue;
    }
    if (ch === delim) {
      if (escape === 'double' && inner[i + 1] === delim) {
        i++;
        continue;
      }
      throw new Error(`unescaped delimiter in ${literal}`);
    }
  }
}

/** A shell literal is safe when the package's own POSIX tokenizer reads it back as exactly one word equal to the value. */
function assertShellRoundTrip(value: string): void {
  const quoted = shellQuote(value);
  expect(tokenizeShell(`${quoted} next`).tokens, `shell round-trip of ${quoted}`).toEqual([value, 'next']);
  // Nothing outside quotes: the literal is either '...' or $'...' and the only unquoted characters are the idiom's backslash-quote.
  expect(quoted.replace(/^\$?'|'$/g, '').replace(/'\\''/g, '')).not.toMatch(/'/);
}

const NASTY = [
  `it's "quoted" \\ backslash`,
  'line1\nline2\r\nline3',
  'tab\there',
  '`backticks` $dollar ${expr} %env% #{ruby} ' + "'single'",
  '"); process.exit(1); //',
  "'; rm -rf / #",
  '\u0000\u0001\u001f\u007f control',
  'unicode ✓ é 漢字 😀',
  'ps: \'\' $(Get-Date) `n',
  'php: $var {$obj->x} "\\n"',
  'ruby: #{`id`} \\#',
  'end-of-line\u2028sep\u2029',
];

describe('string literal escaping', () => {
  for (const value of NASTY) {
    it(`escapes ${JSON.stringify(value).slice(0, 40)}`, () => {
      assertShellRoundTrip(value);
      expect(JSON.parse(jsQuote(value))).toBe(value);
      assertSafeLiteral(jsQuote(value), '"', 'backslash');
      assertSafeLiteral(pyQuote(value), '"', 'backslash');
      assertSafeLiteral(goQuote(value), '"', 'backslash');
      assertSafeLiteral(javaQuote(value), '"', 'backslash');
      expect(javaQuote(value)).not.toMatch(/\\u000[ad]/i);
      assertSafeLiteral(csharpQuote(value), '"', 'backslash');
      assertSafeLiteral(rubyQuote(value), '"', 'backslash');
      expect(rubyQuote(value)).not.toMatch(/[^\\]#\{/);
      const ps = psQuote(value);
      if (ps.startsWith("'")) assertSafeLiteral(ps, "'", 'double', 'allow');
      else {
        assertSafeLiteral(ps, '"', 'backtick', 'allow');
        // the only `$` allowed is the `$([char]N)` sub-expression the escaper itself emits
        expect(ps.replace(/\$\(\[char\]\d+\)/g, '')).not.toMatch(/[^`]\$/);
      }
      const php = phpQuote(value);
      if (php.startsWith("'")) assertSafeLiteral(php, "'", 'backslash', 'allow');
      else {
        assertSafeLiteral(php, '"', 'backslash');
        expect(php).not.toMatch(/[^\\]\$/);
      }
    });
  }
  it('shell quoting uses the single-quote idiom and ANSI-C for control characters', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('a\nb')).toBe("$'a\\nb'");
    expect(shellQuote('')).toBe("''");
  });
  it('PowerShell quoting escapes interpolation in the double-quoted form', () => {
    expect(psQuote("it's")).toBe("'it''s'");
    expect(psQuote('a\n$x "q" `b')).toBe('"a`n`$x `"q`" ``b"');
    expect(psQuote('\u0001')).toBe('"$([char]1)"');
    expect(csharpQuote(`a${String.fromCharCode(0x2028)}b`)).toBe('"a\\u2028b"');
  });
  it('jsQuote escapes line separators', () => {
    expect(jsQuote('a\u2028b')).toBe('"a\\u2028b"');
  });
});

describe('generators are injection-safe for every language', () => {
  const nastyHeaders = NASTY.map((v, i) => ({ key: `X-N${i}`, value: v, enabled: true }));
  const draft = fixture({
    url: 'https://api.example.com/p?q=' + encodeURIComponent(NASTY[0]!),
    headers: nastyHeaders,
    body: { mode: 'raw', rawLanguage: 'text', raw: NASTY.join('|') },
    auth: { type: 'bearer', params: { token: NASTY[4]! } },
  });
  const request = prepareSnippetRequest(draft, { revealSecrets: true });

  for (const language of LANGUAGES) {
    it(`${language}: no raw newline from a value ends up unescaped inside a literal`, () => {
      const code = generateSnippet(language, request);
      const lines = code.split(/\r?\n/);
      if (language === 'http') {
        // The raw message carries the body verbatim; the safety property is that header values were flattened:
        // exactly one request line + one line per header before the blank line, nothing injected.
        const head = lines.filter((l) => !l.startsWith('# '));
        const blank = head.indexOf('');
        expect(blank).toBe(1 + request.headers.length + 1 + 1); // request line, Host, headers, Content-Length
        expect(head.slice(0, blank).every((l) => /^[A-Z]+ \/|^[A-Za-z0-9-]+: /.test(l))).toBe(true);
        return;
      }
      // Every literal in the output must have been produced by the escaping helpers: values that contain
      // line breaks are escaped, so the raw `line2` text from NASTY[1] must never start a line of its own.
      expect(lines.some((l) => l.startsWith('line2') || l.startsWith('line3'))).toBe(false);
      expect(lines.filter((l) => /^(rm -rf|process\.exit)/.test(l))).toEqual([]);
      expect(code).toContain('X-N0');
    });
  }

  it('the raw HTTP generator computes the UTF-8 content length and never emits CRLF from values', () => {
    const r: SnippetRequest = { method: 'POST', url: 'https://x.test/a', headers: [{ name: 'X', value: 'a\r\nb' }], body: { kind: 'text', text: 'é', contentType: 'text/plain' }, notes: [] };
    const code = generateSnippet('http', r);
    expect(code).toContain('X: a b\r\n');
    expect(code).toContain('Content-Length: 2\r\n');
  });

  it('rejects unknown languages', () => {
    expect(() => generateSnippet('brainfuck' as SnippetLanguage, request)).toThrow(/Unknown snippet language/);
  });
});
