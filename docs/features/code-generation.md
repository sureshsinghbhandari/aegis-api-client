# Code generation and cURL import

Aegis can turn a request into a code snippet for a dozen languages and tools, and can turn a pasted
`curl` command into a request. Both live in the pure TypeScript package `@aegis/codegen`
(`packages/codegen`), which has no Node.js dependencies so the renderer and the CLI share it.

```ts
import { parseCurl, prepareSnippetRequest, generateSnippet, SNIPPET_LANGUAGES } from '@aegis/codegen';

const { draft, warnings, ok } = parseCurl("curl -X POST https://api.example.com/users -d '{\"name\":\"Ada\"}'");
const snippet = generateSnippet('python-requests', prepareSnippetRequest(draft, { variables }));
```

## Code snippets

Open a request and press **Code** (next to **Save**). The modal offers:

| Language id | Output |
| --- | --- |
| `curl` | cURL (POSIX quoting, `--data-raw`, `--data-urlencode`, `-F`) |
| `http` | Raw HTTP/1.1 message with `Host` and `Content-Length` |
| `javascript-fetch` | Browser `fetch` |
| `node-fetch` | Node.js 18+ global `fetch` (undici) |
| `python-requests` | Python `requests` |
| `powershell` | PowerShell `Invoke-RestMethod` |
| `go` | Go `net/http` |
| `java` | Java 11+ `java.net.http.HttpClient` |
| `csharp` | C# `HttpClient` |
| `php-curl` | PHP `curl_*` |
| `ruby` | Ruby `Net::HTTP` |
| `httpie` | HTTPie |

The snippet is generated from the request **resolved for display**:

- enabled query parameters, headers, form fields and path variables only;
- `{{variables}}` replaced with their current value from globals, the collection, the folder chain and the
  active environment (same precedence as sending);
- the body rendered according to its mode (raw, GraphQL as JSON, urlencoded, form-data, binary);
- authorization rendered as headers: Basic (base64), Bearer, API key (header or query).

The language choice is remembered. **Copy** puts the snippet on the clipboard. When the request has been
sent at least once, **Copy as sent** generates the snippet from the request exactly as it went out
(`ExecutionResult.request`, which the main process has already redacted); the **Source** picker shows the
same thing in the modal.

### Secrets

Code generation never reveals secrets by default:

- variables flagged secret, or whose value is a `secretref:`, stay as `{{name}}` placeholders and are listed
  in a note at the top of the snippet;
- secret auth parameters (passwords, tokens, API keys, client secrets, private keys) become `{{token}}`-style
  placeholders;
- OAuth 2.0, AWS Signature v4, JWT, OAuth 1.0 and the executable custom providers (digest, hawk, ...) are
  **never computed** by the generator. The snippet shows the header with a placeholder and a note that the
  value is produced at send time;
- file names of form-data files and binary bodies are shown as the base name only, never as a local path.

**Reveal secrets** substitutes the real values. Every reference is fetched through `variables.revealSecret`,
which is audited, and the toggle is disabled when the enterprise policy sets `allowSecretExport: false`.

### Quoting safety

Every value goes through a per-language literal escaper (`packages/codegen/src/escape.ts`): quotes,
backslashes, line breaks, control characters, `$`/`#{}` interpolation sigils and U+2028/2029 are escaped so
that no header or body value can break out of a string literal or inject code. Header values containing line
breaks are flattened (the request engine would reject them anyway). The test
`tests/unit/codegen-generators.test.ts` runs a corpus of hostile values through every generator.

## cURL import

Paste a `curl ...` command into the URL bar and the **Import cURL** dialog opens instead of the command
landing in the URL field. The dialog shows the parsed method, URL, query, headers, auth, body and settings
plus warnings; **Create request** opens it as a new tab, **Replace in this tab** overwrites the current tab.
The same dialog can be fed any text (the `curl` prefix, a `$ ` prompt and `curl.exe` are tolerated).

Supported options:

| Option | Mapping |
| --- | --- |
| `-X`, `--request` | method (also `-XPOST`, `--request=POST`) |
| `-H`, `--header` | header; `Name;` yields an empty header |
| `-d`, `--data`, `--data-ascii`, `--data-raw`, `--data-binary`, `--data-urlencode`, `--json` | body; several values are joined with `&`; urlencoded when it parses as `k=v&k=v`, otherwise raw with JSON/XML sniffing; `--json` adds `Content-Type`/`Accept` |
| `-F`, `--form`, `--form-string` | form-data text parts (`;type=` honoured) |
| `-u`, `--user` | Basic auth (`user:password`) |
| `--oauth2-bearer` | Bearer auth |
| `--url` / positional | URL; the query string becomes params; `:name` segments become path variables |
| `-L`, `--location`, `--max-redirs` | follow redirects / limit |
| `-m`, `--max-time` | timeout |
| `--http1.1`, `--http2` | per-request HTTP version |
| `--compressed` | `Accept-Encoding` header |
| `-b`, `--cookie` | `Cookie` header (cookie strings only) |
| `-A`, `-e`, `-I`, `-G` | `User-Agent`, `Referer`, `HEAD`, move data to the query |
| `-k`, `--insecure` | **warning only** - TLS verification is never disabled by an import (policy controlled) |

Quoting: single quotes, double quotes (with `\"`, `\\`, `\$`), `$'...'` ANSI-C escapes, backslash-newline
(POSIX), caret-newline (cmd.exe) and backtick-newline (PowerShell) continuations, combined short flags
(`-sSL`) and `--opt=value`.

Rejected for security (a warning is shown and nothing is stored): `-d @file`, `--data-binary @file`,
`--data-urlencode name@file`, `-F name=@file`, `-F name=<file`, `-T file`, cookie files. Every other option
becomes a warning and is ignored; options that take a value consume it so the URL is still found. Input is
capped at 1 MiB.

## Files

- `packages/codegen/src/curl-parse.ts` - tokenizer and option parser
- `packages/codegen/src/prepare.ts` - display resolution, auth rendering, secret masking
- `packages/codegen/src/generators/*.ts` - one generator per language
- `apps/desktop/renderer/src/modals/CodeSnippetModal.tsx`, `modals/CurlImportModal.tsx`, `lib/curl-paste.ts`
- Tests: `tests/unit/codegen-curl.test.ts`, `tests/unit/codegen-generators.test.ts`, `tests/unit/ui-curl-paste.test.ts`
