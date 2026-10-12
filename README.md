# Aegis API Client

A secure, **local-first** desktop API client (in the spirit of Postman) for organizations that cannot or do not want to
depend on a cloud SaaS. No account, no sync, no telemetry — it sends exactly the requests you tell it to.

> **Postman compatibility:** Postman Collection v2.1 compatible *for supported fields/features*. See the
> [compatibility matrix](docs/postman-compatibility/compatibility.md) for exactly what is supported, preserved or not handled.

Status legend used throughout: ✅ Implemented and tested · 🟡 Partial (implemented, with documented gaps or a
weaker verification) · 🔴 Not implemented. Version 0.2.0 is not yet tagged, so nothing here has been validated in a
tagged release.

## Contents

[Why](#why-this-application-exists) · [Quick start](#installation) · [Features](#features) · [Postman parity](#postman-parity) ·
[Examples](#examples) · [Variables](#variables) · [Authentication](#authentication) ·
[Scripts & tests](#scripts-tests-and-pm-compatibility) · [Runner & CLI](#collection-runner) ·
[Postman](#postman-import-and-export) · [Security](#security-architecture) · [Development](#development) ·
[Troubleshooting](#troubleshooting) · [Limitations](#known-limitations) · [Roadmap](#roadmap)

## Why this application exists

Public SaaS API clients send collections, environments and (often) credentials to a vendor cloud. For regulated or
security-conscious organizations that is a data-governance, privacy, licensing and cost problem. Aegis keeps everything
on the user's machine, protects secrets with the operating system's credential protection, can be locked down by an
administrator policy file, and can round-trip Postman collections so teams are not locked into a proprietary format.

## Installation

Requirements: **Node.js ≥ 22.12** (developed on Node 26) and npm. No C++ build tools are needed.

**Windows – one click:** double-click [`start-aegis.bat`](start-aegis.bat). On first run it installs dependencies, builds
the app and launches it (`start-aegis.bat rebuild` forces a rebuild, `start-aegis.bat dev` starts development mode).

**Any platform:**

```bash
npm install
npm run build
npm start          # launches the built app
```

Installable packages (NSIS/portable on Windows, dmg on macOS, AppImage/deb on Linux): `npm run dist` →
`release/`. `npm run pack` produces an unpacked build for quick checks. Code signing is organization-specific and not
configured.

## Features

| Area | Status | Notes |
| --- | --- | --- |
| HTTP request builder, tabs, save/close/reopen/duplicate/rename, unsaved indicator | ✅ | Ctrl/Cmd+Enter send, +S save, +W close, +T new, +Shift+T reopen, +K search |
| Real HTTP execution, cancel, timeout, redirects (max), response size limit | ✅ | undici; tested against a real local server |
| Methods GET POST PUT PATCH DELETE HEAD OPTIONS TRACE CONNECT + custom | ✅ | Custom methods accepted by model and UI; long custom methods (e.g. `PROPFIND`) are shown in full |
| Query params, path variables (`:id`), headers (enable/disable, descriptions) | ✅ | Stored URL is never overwritten by resolution |
| Bulk Edit (`key:value` per line) for Params, Headers, urlencoded, form-data | ✅ | `//` prefix disables a row |
| `{{variable}}` autocomplete, hover and unresolved underline before sending | ✅ | URL, params, headers, body editors, auth text fields; secrets are always masked |
| Bodies: none, raw (JSON/XML/text/HTML/JS), urlencoded, form-data (text/file/variable), binary | ✅ | Files are streamed from disk, never fully loaded |
| GraphQL body mode (query, variables, operation name) | ✅ | Sent as `application/json`; exported as a Postman `graphql` body. No schema introspection / explorer (🔴) |
| Response viewer: Pretty, Raw, Preview, Headers, Cookies, Tests, Timeline, Visualize | ✅ | Large bodies are chunked/virtualised or saved to file; HTML preview is sandboxed |
| JSONPath filter in Pretty view | ✅ | Safe subset parsed into an AST (no `eval`); see [response tools](docs/features/response-tools.md) |
| Examples: save response as example, list/edit/delete in the Examples tab | ✅ | Exported/imported as Postman `response[]`; documentation only (no mock server) |
| Visualize tab (`pm.visualizer.set` output) | ✅ | Rendered in a sandboxed iframe: no scripts, no network |
| HTTP/2 (ALPN over TLS) with the real negotiated version reported | ✅ | No h2c; not through proxies. Auto / 2 / 1.1 globally and per request. See [HTTP runtime](docs/features/http-runtime.md) |
| Timeline: DNS / TCP / TLS / TTFB / download bars, TLS protocol/cipher/ALPN, peer certificate details | ✅ | Timings are 0 on a reused connection; unavailable through a proxy |
| Per-request settings: disable cookie jar, encode URL, follow original method, follow `Authorization`, remove Referer, max response size | ✅ | Mapped to Postman `protocolProfileBehavior` both ways. Per-request "strict SSL" is honoured **only** when policy `allowInsecureTls` is true |
| Working directory for relative form-data / binary paths | ✅ | Settings → General; relative paths resolve only inside it |
| Host overrides (application-local hosts file) | ✅ | Settings → Network; never bypass `blockedHosts`, never applied through a proxy; policy key `allowHostOverrides` |
| Workspaces (Personal/Team/Enterprise, local), collections, nested folders, drag & drop, search | ✅ | Tree rows are loaded flat and virtualised (tested with 2,000+ requests; designed for 10,000+) |
| Environments, global/collection/folder/local/iteration variables, secret variables, dynamic variables | ✅ | See [Variables](#variables) |
| Production environment banner + policy-controlled confirmation | ✅ | |
| Find & Replace across a collection or workspace | ✅ | Preview first, one transaction, never touches secrets/auth; regex is best-effort bounded (see [Known limitations](#known-limitations)) |
| Duplicate folders; move requests/folders to another collection (drag & drop or "Move to…") | ✅ | Moved items inherit the **target** collection's auth, scripts and variables |
| Authentication: none, basic, bearer, API key, OAuth 2.0 (+PKCE, device code), OAuth 1.0 (HMAC, RSA-SHA*), JWT (HS/RS/ES/PS), AWS SigV4, Digest, Hawk, ASAP, custom provider API, inheritance | ✅ | OAuth 2.0 authorization-code flow needs an interactive window (manual verification only). See [authentication](docs/features/authentication.md) for the verification behind each provider |
| Authentication: Akamai EdgeGrid | 🟡 | Verified only against an independent in-test implementation (no public vector with a real secret exists) |
| Authentication: NTLM | 🔴 | Preserved on Postman import/export only; not executable |
| Cookie jar (Set-Cookie, domain, path, expiry, Secure, HttpOnly, SameSite) + manager UI (list, add, edit, delete) | ✅ | Values stored in OS-protected storage |
| TLS: HTTPS, custom CA, client certificates (PEM and PKCS#12/PFX), policy-controlled "do not verify" | ✅ | Tested with a self-signed certificate; PFX bundle and passphrase go to the vault |
| Proxy: HTTP/HTTPS proxy, proxy auth, NO_PROXY, system proxy | 🟡 | Config + logic tested; not tested against a real proxy server |
| Request history with privacy settings, retention, search/filter/sort, pagination, replay, save to collection | ✅ | Bodies are **not** stored unless enabled |
| Pre-request / post-response scripts, tests, `pm.*`, `pm.sendRequest` | ✅ | QuickJS sandbox; some `pm` features are 🟡/🔴 — see scripting guide. Request tabs: **Pre-request Script** and **Post-response** (formerly "Tests") with `pm.*` autocomplete and snippets |
| Script libraries: `require()` of lodash, moment, crypto-js, uuid, ajv, tv4, chai, atob/btoa; globals `_`, `CryptoJS`, `moment`, `tv4` | ✅ | Bundled at build time, evaluated lazily inside the sandbox. See [Scripts](#scripts-tests-and-pm-compatibility) |
| Script libraries: `xml2js` (`xml2Json`), `buffer` (`Buffer`), `csv-parse/lib/sync` | 🟡 | Facade / subset implementations; differences documented in the scripting guide |
| `pm.response.to.have.jsonSchema` (draft-07 incl. `$ref`/`format`; draft-04 via tv4) | ✅ | Draft 2019-09/2020-12 are not bundled |
| `pm.cookies.jar().set/unset/clear` | ✅ | Writes to the workspace cookie jar; `HttpOnly` cookies are invisible and immutable to scripts; audited (`SCRIPT_COOKIE_WRITE`, names only) and shown as a warning; 200 operations per run |
| `pm.visualizer.set` | ✅ | Handlebars renders inside the sandbox; output is script-stripped, redacted and capped at 2 MiB |
| `pm.request.auth` view; `pm.sendRequest` with `auth` | 🟡 | `pm.request.auth` is a read-only, redacted view of the request's own auth (inherited auth is not resolved); `pm.sendRequest` auth supports basic / bearer / API key only |
| `cheerio`, `pm.require`, `setInterval`, `fetch`, `process` in scripts | 🔴 | Not available |
| Script editor Variables pane (environment/globals/collection/folder; masked secrets with 20 s reveal; insert `pm.*.get/set`; "changed by last run") | ✅ | |
| Console: script output **and** network log (sends, `pm.sendRequest`, runner items) | ✅ | Headers redacted, bodies not logged; scripts/network/both filter |
| Layout toggle (stacked / side by side); open tabs restored after restart | ✅ | Restored drafts never contain secrets; Ctrl+W confirms when dirty; Ctrl+Tab / Ctrl+Shift+Tab cycle tabs; Ctrl+Shift+F find & replace |
| Markdown preview for request/collection/folder descriptions | ✅ | Sandboxed; no remote images |
| Collection runner: iterations, delay, stop on failure, CSV/JSON data, `setNextRequest`, choose and order requests, "Keep responses", Export JUnit / HTML | ✅ | Kept responses are redacted, limited to the first 64 KiB, and credential headers are never stored. See [Collection runner](#collection-runner) |
| CLI runner `aegis-cli` (Newman-style; cli / json / junit / html reporters; exit codes) | ✅ | See [CLI](docs/features/cli.md); no interactive OAuth, no client certs/custom CAs yet, no `bin`/installer packaging yet |
| Code snippets (12 languages/tools) and cURL import (paste into the URL bar) | ✅ | See [code generation](docs/features/code-generation.md); secrets stay as placeholders by default |
| Postman import (v1, v2.0/v2.1, data dump, environment, globals) with preview, warnings, rollback | ✅ | |
| Import: OpenAPI 3.0/3.1 (JSON + YAML), Swagger 2.0, HAR 1.2, Insomnia v4, Aegis workspace file, auto-detect | ✅ | File → Import; "Any Supported File" (Ctrl+Shift+O) detects the format. See [import formats](docs/features/import-formats.md) |
| Import: GraphQL bodies from Postman / Insomnia | 🟡 | Mapped to a raw JSON body (original kept in metadata) |
| Import: Insomnia v5 | 🔴 | Not supported |
| Postman export (v2.1, environment) without secrets by default | ✅ | |
| Backup / restore (optional passphrase encryption) | ✅ | History limit configurable (default 500, max 100000) |
| Audit log, enterprise policy file, local-only mode | ✅ | |
| Dark / light themes, resizable panels, context menus, confirmation dialogs | ✅ | |
| Desktop packaging (electron-builder) | 🟡 | Unpacked build verified on Windows; installers not signed |
| WebSocket, gRPC, SSE/streaming clients; GraphQL schema introspection | 🔴 | Roadmap. A `ProtocolClient` interface and registry class exist, but the executor calls `HttpProtocolClient` directly, so a new protocol also needs an executor dispatch |

### Supported HTTP methods

`GET POST PUT PATCH DELETE HEAD OPTIONS TRACE CONNECT` and any custom token.

### Request builder

Method + URL bar (query string edits sync with the Params table), Params (query + path variables), Headers, Body
(including GraphQL), Authorization, Pre-request Script, Post-response (scripts and tests), Examples, Settings
(timeout, redirects, cookie jar, URL encoding, HTTP version, max response size, strict SSL where policy allows), Docs
(Markdown with live preview). Default headers (`User-Agent`, `Accept`, `Accept-Encoding`, `Content-Type` for raw bodies)
are added only if you did not set them. `{{variable}}` references show completion, hover details and an unresolved
underline in every text field before you send; secret values are always masked. Params, Headers, urlencoded and
form-data have a Bulk Edit toggle.

### Response viewer

Status, status text, duration, size, content type; Pretty (JSON/XML/HTML formatting, folding, search, copy, JSONPath
filter for JSON), Raw, Preview (sandboxed HTML, images), Headers, Cookies, Test Results, Visualize, Timeline (redirect
hops, DNS/TCP/TLS/TTFB/download bars, negotiated HTTP version, TLS protocol/cipher/ALPN and peer certificate
subject/issuer/validity/SAN/fingerprint, resolved request with secrets masked, warnings, unresolved variables, host
overrides in effect). Binary content can be saved to a file. **Save as example** stores the current response as an
example of the request (text bodies only).

### Collections, folders, workspaces

Workspace → Collection → nested Folders → Requests. Create, rename, delete, duplicate (including folders, deep copy with
secrets re-vaulted), move (drag & drop or "Move to…", including to another collection), reorder, search, run, export,
Find & Replace. Collections and folders carry their own authorization, scripts and variables. Workspaces can be created,
renamed, deleted, searched and exported; the whole database can be backed up.

### Find & Replace

Collection context menu → "Find & Replace…" or Ctrl+Shift+F, for one collection or the whole workspace. Scopes: URL,
params, headers, body, scripts, descriptions, variables (non-secret). Options: match case, whole word, bounded regex.
The dialog previews "N matches in M requests" and only writes on confirmation, in a single transaction. Secret values and
authorization parameters are never read or written, and the audit log (`FIND_REPLACE`) stores counts only. Details:
[collection management](docs/features/collection-management.md).

### HTTP runtime details

HTTP/2 is negotiated through ALPN over TLS only (no h2c, and not through a proxy); the response reports the version
actually negotiated. Settings → Network lets you choose HTTP version (auto / 2 / 1.1) and define host overrides;
Settings → General sets the working directory used to resolve relative file paths; Settings → Certificates accepts PEM
or PKCS#12 client certificates. `Authorization` is dropped on cross-origin redirects unless a request opts in to
"follow Authorization header" (a warning is shown). Details: [HTTP runtime](docs/features/http-runtime.md).

## Postman parity

Aegis aims to cover the day-to-day desktop workflow of Postman without any cloud component. It does **not** claim full
Postman compatibility; the [compatibility matrix](docs/postman-compatibility/compatibility.md) and the
[gap analysis](docs/postman-gap-analysis.md) list exactly what is and is not covered.

**Added since 0.1.0** (see [CHANGELOG.md](CHANGELOG.md)): variable autocomplete/hover, Bulk Edit, GraphQL body mode,
HTTP/2 and connection/TLS timeline details, per-request settings (`protocolProfileBehavior` mapped), working directory,
host overrides, PKCS#12 client certificates, examples UI, JSONPath filter, Visualize tab, console network log, layout
toggle and tab restore, Markdown descriptions, Find & Replace, folder duplicate and cross-collection move, cookie add/edit,
script editor variables pane and extra snippets, extra authentication providers (Digest, Hawk, EdgeGrid, ASAP, OAuth 1.0
RSA, JWT ES/PS, OAuth 2.0 device code), `aegis-cli`, code snippets and cURL import, script libraries (`require()` of
lodash, moment, crypto-js, …), cookie-jar writes and full `jsonSchema` in scripts, `pm.visualizer`, import of OpenAPI /
Swagger / HAR / Insomnia v4 / Postman v1 / data dumps / Aegis workspace files, and runner request selection, kept
responses and JUnit/HTML export.

**Intentionally excluded** (they contradict the local-first, no-account, no-telemetry design): cloud sync and
workspaces/teams, monitors, hosted mock servers, Flows, AI features and the Postman Interceptor/browser capture.

**Still missing or partial:** WebSocket/gRPC/SSE clients and GraphQL introspection (🔴), NTLM (🔴), Insomnia v5 import
(🔴), GraphQL bodies imported as raw JSON (🟡), Akamai EdgeGrid verified only against an independent implementation (🟡),
per-request client certificates/proxy (preserved on import, not applied), and script gaps: `cheerio`, `pm.require`,
`setInterval`, `fetch`, `process` (🔴); `xml2js`, `Buffer` and `csv-parse` are subsets (🟡). See the
[scripting guide](docs/features/scripting.md).

## Examples

Simple GET:

```text
GET https://api.example.com/users
```

Bearer authentication (header, with a secret environment variable):

```text
Authorization: Bearer {{token}}
```

Pre-request script:

```javascript
pm.variables.set("timestamp", Date.now());
```

Post-response script:

```javascript
const data = pm.response.json();
pm.environment.set("userId", data.id);
```

Test:

```javascript
pm.test("Status is 200", () => {
    pm.response.to.have.status(200);
});
```

Request chaining — `Login → token → Get User → userId → Get Orders`:

```javascript
// Login, Post-response tab:
pm.environment.set("token", pm.response.json().token);
// Get User, Post-response tab:
pm.environment.set("userId", pm.response.json().id);
// Get Orders:  GET {{baseUrl}}/users/{{userId}}/orders   with   Authorization: Bearer {{token}}
```

This exact chain is exercised by the automated acceptance tests (`tests/integration/acceptance.test.ts`).

## Variables

`{{name}}` placeholders are resolved at send time by a single resolver; unresolved ones are left visible and reported.

**Precedence (highest first):** `request › local › iteration/data › environment › folder (innermost first) › collection › global`.
Every adjacent pair is covered by `tests/unit/variables.test.ts`. A variable's *current value* overrides its *initial
value*. Values may reference other variables (bounded depth, cycle-safe).

**Dynamic variables** come from pluggable providers (`DynamicVariableProvider`): `{{$guid}}`, `{{$randomUUID}}`,
`{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomBoolean}}`, `{{$randomAlphaNumeric}}`,
`{{$randomHexColor}}`, `{{$randomIP}}`, `{{$randomFirstName}}`, `{{$randomLastName}}`, `{{$randomEmail}}`, `{{$randomPassword}}`.

**Secret variables** are masked in the UI, stored encrypted by the OS, never logged, excluded from exports by default and
revealed only by an explicit (audited) action.

**Environments** (e.g. Development / QA / UAT / Production) apply immediately when switched; the active one is always shown,
production in red with a banner.

## Authentication

Providers: ✅ none · basic · bearer · API key (header/query) · OAuth 2.0 (authorization code + PKCE, client credentials,
password, refresh, device authorization grant) · OAuth 1.0 (HMAC-SHA1/-SHA256/-SHA512, RSA-SHA1/-SHA256/-SHA512,
PLAINTEXT) · JWT (HS256/384/512, RS256/384/512, ES256/384/512, PS256/384/512; sign + decode) · AWS Signature V4 · Digest
(MD5/SHA-256/-sess, qop `auth`/`auth-int`, via a 401 challenge round trip) · Hawk · Atlassian ASAP · custom
(`AuthRegistry.register`). Inheritance: request → folder → collection (`inherit` / explicit `none`). Refreshed OAuth
tokens are written back (encrypted) to the auth config that owns them. Verification
([details](docs/features/authentication.md)): OAuth1 reference signature, jwt.io token, AWS SigV4 test suite, the
RFC 2617 Digest example, the Hawk README vectors, RSA/ECDSA/PSS signatures verified with `node:crypto`, and a local
OAuth 2.0 device-code server. Imported Postman digest / hawk / edgegrid / asap requests now execute.

🟡 **Akamai EdgeGrid** is verified only against an independent in-test implementation of Akamai's documented algorithm
(no public test vector with a real secret exists). 🔴 **NTLM** is preserved on Postman import/export but not executable.
"Get new access token" resolves collection and folder variables and can be cancelled.

## Cookies

Per-workspace jar following RFC 6265 (domain/path matching, expiry incl. `Max-Age=0` deletion, Secure, HttpOnly,
SameSite). Cookies are applied on every redirect hop (unless "disable cookie jar" is set on the request). Scripts never see
`HttpOnly` cookies and cannot create, replace or remove them; `pm.cookies.jar().set/unset/clear` write to this jar for
all other cookies (audited, names only). Manage them in Settings → Cookies: list, add, edit and delete (values hidden until revealed).

## TLS / certificates

Certificate validation is **on** and cannot be turned off unless the organization policy sets `allowInsecureTls: true`
*and* the user disables it in Settings (a warning is shown on every such request). Add custom CA certificates and
client certificates (PEM certificate + key + optional passphrase, or a PKCS#12/PFX bundle + passphrase; host pattern like
`*.corp.example`) in Settings → Certificates. Keys, PFX bundles and passphrases are stored in OS-protected storage.
A per-request "strict SSL" switch (Postman `strictSSL`) is honoured **only** when the policy also allows insecure TLS;
otherwise the request tab shows it as enforced by policy.

## Proxy

Settings → Network: none / system / manual (HTTP, HTTPS, NO_PROXY, username + password). System proxy uses the OS
resolver, falling back to `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`. Through a proxy, host overrides do not apply and
DNS/TCP/TLS timings are not available.

## History

Every send is recorded (unless disabled) with timestamp, method, redacted URL, status, duration, sizes, environment and a
replayable *unresolved* request snapshot. Request/response **bodies are not stored by default**; sensitive literals are
masked. Retention: 7 / 30 / 90 / 365 days or unlimited. Search by URL/name, method (all methods are listed), status class, date; sort; paginated
(never loads unbounded rows). Replay re-runs the saved request (or the snapshot if it was deleted).

## Scripts, tests and `pm.*` compatibility

Pre-request and post-response scripts run in an isolated QuickJS (WebAssembly) sandbox: no `process`, `fs`, `fetch`,
host network access (except `pm.sendRequest`), `setInterval`, or host objects; default timeout **5 s** (policy-capped),
memory and stack limits, console capture with secret redaction. Implemented: `pm.request`, `pm.response`,
`pm.environment` (including `pm.environment.name`), `pm.collectionVariables`, `pm.variables`, `pm.globals`,
`pm.cookies` (read, plus `pm.cookies.jar().set/unset/clear`), `pm.iterationData`, `pm.info`, `pm.execution`
(`setNextRequest`, `skipRequest`), `pm.test` (sync/async/skip), `pm.expect` (full chai), `pm.response.to.have.jsonSchema`
(draft-07 including `$ref` and `format`; draft-04 through tv4), `pm.visualizer.set`, and `pm.sendRequest` (callback and
promise style, same security policy; each call writes trace lines to the Console).

**Script libraries.** `require('lodash' | 'moment' | 'crypto-js' | 'uuid' | 'ajv' | 'tv4' | 'xml2js' | 'chai' | 'atob' |
'btoa' | 'buffer' | 'csv-parse/lib/sync')` and the globals `_`, `CryptoJS`, `moment`, `tv4`, `xml2Json`, `Buffer` work as in
Postman scripts. The libraries are MIT-licensed `devDependencies` bundled at build time (no new runtime dependency),
evaluated lazily inside the sandbox on first use, and cannot reach the host. `xml2js` is a facade over fast-xml-parser,
and `Buffer` and `csv-parse` are subsets (🟡). Not available (🔴): `cheerio`, `pm.require`, `setInterval`, `fetch`,
`process`. `pm.request.auth` is a read-only, redacted view of the request's own auth (🟡), and `pm.sendRequest` auth is
limited to basic / bearer / API key (🟡).

**Cookie jar writes** go to the workspace jar (limit 200 jar operations per run), are audited as `SCRIPT_COOKIE_WRITE`
(names only) and surfaced as a warning on the response. **`pm.visualizer.set`** renders Handlebars inside the sandbox;
the HTML is script-stripped, redacted and capped at 2 MiB. Full status of every item:
[docs/features/scripting.md](docs/features/scripting.md).

Editor aids: the **Pre-request Script** and **Post-response** tabs offer `pm.*` autocomplete, snippets, and a Variables
side pane (environment, globals, collection and folder variables; secrets masked, 20 s reveal; one-click insert of
`pm.*.get/set`, copy `{{key}}`, create variables inline, "changed by last run" marker). `pm.visualizer.set` output is
shown in the response's **Visualize** tab (sandboxed iframe). Script and `pm.sendRequest` activity appears in the Console
together with the network log.

## Collection runner

Choose collection (or folder), environment, iterations, delay, stop-on-failure and an optional CSV/JSON data file
(exposed as `pm.iterationData`). You can also choose which requests run and put them in the order you want. Results
stream live: `✓ Login 200 182ms`. Results are persisted and can be exported from the runner panel (JSON, CSV, **Export
JUnit**, **Export HTML**).

* **Keep responses** (opt-in) stores each response with the run: redacted, only the first 64 KiB, and credential headers
  are never stored (nullable column `collection_run_items.response_json`, added by migration 0001).
* Local variables are reset exactly once per iteration (this was a bug in earlier builds).

### Command-line runner

```bash
npm run build:cli
npm run cli -- run collection.json -e env.json -g globals.json -d data.csv --reporters cli,json,junit,html
node dist/cli/aegis-cli.cjs run collection.json -e env.json   # same program, without npm
```

`aegis-cli` runs a Postman collection with the same engine as the desktop app (variables, auth, sandboxed scripts,
cookies, enterprise policy) and exits `0` / `1` / `2` / `3` for success / failures / usage error / unparsable input.
Reporters: `cli`, `json`, `junit`, `html`. `--policy <file>` loads an enterprise policy (default: `AEGIS_POLICY_FILE`,
then the OS-wide locations); `--insecure` is refused unless the policy sets `allowInsecureTls`; `--production` is the
explicit confirmation for production environments. Limitations: no interactive OAuth 2.0, no client certificates or
custom CAs yet, no `bin` entry or installer packaging yet (use `node dist/cli/aegis-cli.cjs`), secrets live only in
memory for the run. Full reference: [docs/features/cli.md](docs/features/cli.md).

## Importing other formats

File → Import accepts, besides Postman Collection v2.0/v2.1 and Postman environments/globals: OpenAPI 3.0 / 3.1 (JSON and
YAML), Swagger 2.0, HAR 1.2, Insomnia v4 exports, Postman Collection v1, Postman data dumps and Aegis workspace files.
**Any Supported File** (Ctrl+Shift+O) detects the format from the content. Exported Aegis workspace files re-import as a
**new** workspace; existing workspaces are never modified. All importers share the Postman import pipeline (preview,
warnings, single transaction, rollback).

* **Importers never fetch anything.** External `$ref`s, `externalValue` examples and external scripts are ignored with a
  warning, and importers do not read other files from disk.
* YAML is parsed with the YAML 1.2 core schema only (no custom tags), with an alias-bomb guard and a 64 MiB cap; this adds
  one runtime dependency, `yaml` (ISC, pure JavaScript).
* **HAR credentials are never imported literally.** Authorization / Cookie / API-key style fields (also inside JSON
  bodies) are replaced by empty secret variables named `{{har_*}}`.
* Imports are imports only: collections are exported as Postman v2.1, not back to OpenAPI/HAR/Insomnia. Not supported or
  partial: Insomnia v5 (🔴), GraphQL bodies from Postman/Insomnia (🟡, imported as raw JSON), no GraphQL introspection (🔴).

Details and row-by-row mapping: [docs/features/import-formats.md](docs/features/import-formats.md).

## Postman import and export

Import: File → Import → Postman Collection / Environment (also drag & drop). Pipeline: parse → detect schema → validate →
normalise → convert → preview → **single database transaction** → report. The preview shows folders, requests, variables,
scripts, examples and warnings; Cancel changes nothing, and a failure rolls everything back (including secrets).
Postman `protocolProfileBehavior` keys `disableCookies`, `disableUrlEncoding`, `followOriginalHttpMethod`,
`followAuthorizationHeader` and `removeRefererHeaderOnRedirect` are mapped to request settings and back on export.
Unknown fields are preserved in metadata and re-emitted on export, with warnings. Progress
(Parsing / Validating / Importing / Saving / Finalizing, "1,250 / 5,000 requests") is streamed. Export: File → Export →
Postman Collection v2.1 / Environment; deterministic output; secrets excluded unless you explicitly include them.

### Environment import/export

Postman environment and globals JSON (`name`, `values[key,value,type,enabled]`). Export **without secrets** is the
default; including secrets needs an explicit confirmation and may be forbidden by policy.

### Compatibility matrix (summary)

| Feature | Import | Export | Runtime |
| --- | --- | --- | --- |
| Collection v1 | ✅ | v2.1 (converted) | ✅ |
| Collection v2.0 | ✅ | v2.1 (converted) | ✅ |
| Collection v2.1 | ✅ | ✅ | ✅ |
| Postman data dump | ✅ | – | ✅ |
| OpenAPI 3.x / Swagger 2.0 / HAR 1.2 / Insomnia v4 / Aegis workspace file | ✅ | exported as Postman v2.1 | ✅ |
| Environment / globals | ✅ | ✅ | ✅ |
| Variables (incl. secret) | ✅ | ✅ | ✅ |
| Scripts / tests | ✅ | ✅ | ✅ (QuickJS; script libraries bundled; gaps documented) |
| Examples | ✅ | ✅ | viewable/editable in the Examples tab; documentation only (no mock server) |
| Basic / Bearer / API key auth | ✅ | ✅ | ✅ |
| OAuth 2.0 / OAuth 1.0 / JWT / AWS | ✅ | ✅ | ✅ |
| Digest / Hawk / ASAP | ✅ | ✅ | ✅ |
| Akamai EdgeGrid | ✅ | ✅ | 🟡 verified only against an independent implementation |
| NTLM | preserved | preserved | 🔴 |
| Form-data / urlencoded / binary | ✅ | ✅ | ✅ (relative paths resolve inside the working directory) |
| GraphQL body | 🟡 (imported as raw JSON, original kept in metadata) | ✅ (native `graphql` body) | ✅ (sent as JSON) |
| `protocolProfileBehavior` cookie/URL-encoding/redirect keys | ✅ | ✅ | ✅ |

Full matrix with limitations: [docs/postman-compatibility/compatibility.md](docs/postman-compatibility/compatibility.md).
Honest caveat: exports are checked by our own structural validator and semantic round-trip tests; they have not been
imported into the Postman application itself.

## Security architecture

See [SECURITY.md](SECURITY.md) and [ARCHITECTURE.md](ARCHITECTURE.md). Highlights: sandboxed renderer without Node access;
a narrow typed preload API; every IPC call checked (sender + schema); strict CSP; sandboxed HTML/Markdown/Visualize
previews (iframe `sandbox`, no scripts, no remote images); script sandbox with resource limits; parameterised SQL only;
path validation for uploads and imports (relative paths only inside the working directory); importers that never fetch
URLs or read other files; redacted logs/audit/history and redacted stored run responses; restored tabs never contain
secrets; Find & Replace never reads or writes secret values; script libraries evaluated only inside the sandbox.

### Secret storage

Windows DPAPI, macOS Keychain, Linux Secret Service via Electron `safeStorage` behind a `SecretStorageProvider`
abstraction. The database stores only `secretref:` references and ciphertext. If the OS keyring is unavailable the app
refuses to store secrets instead of storing them weakly.

### Local-only mode

The application contains no telemetry, analytics, crash reporting, sync, ads or auto-update code. The only network traffic
is user-initiated API traffic and explicitly configured OAuth/proxy endpoints. Shown in the status bar; enforceable by policy.

### Backup / restore

Settings/File → Backup: workspaces, collections, folders, requests, variables, environments, preferences and (optionally)
history. Secrets are **excluded** unless a passphrase is set (then the file is AES-256-GCM encrypted). Restore creates new
workspaces and never overwrites existing data or changes security/network settings. When history is included, only the
most recent rows per workspace are written; the limit is configurable in the Backup dialog (default 500, maximum
100000) and is recorded in the backup file.

### Enterprise policy

Admin-controlled `policy.json` (see [SECURITY.md](SECURITY.md#enterprise-policy)): disallow insecure TLS, require/block
production sends, force local-only, cap script timeout and response size, forbid secret export, block hosts, and
(`allowHostOverrides`, default `true`) allow or ignore application-level host overrides. Host overrides never bypass
`blockedHosts`.

## Development

```bash
npm install
npm run dev          # Vite dev server + Electron (hot reload for the renderer)
npm run build        # renderer (Vite) + main/preload (esbuild) -> dist/
npm start            # run the built app
npm run lint
npm run typecheck
npm test             # all Vitest suites
npm run test:unit | test:integration | test:security
npm run test:e2e     # builds, then drives the real Electron app with Playwright
npm run verify       # lint + typecheck + tests
npm run db:generate  # after editing packages/storage/src/schema.ts
npm run build:cli    # dist/cli/aegis-cli.cjs ; run with: npm run cli -- run collection.json
npm run build:sandbox-libs  # regenerate the bundled script libraries (after upgrading lodash, moment, crypto-js, ...)
npm run pack         # unpacked app in release/ ; npm run dist for installers
npm run audit        # npm audit for production dependencies
```

Layout: `apps/desktop/{main,preload,renderer}`, `apps/cli`, `packages/*` (see ARCHITECTURE.md), `database/migrations`,
`tests/{unit,integration,security,e2e,fixtures/postman}`, `docs/`.

## Testing

* **Unit / integration / security** (Vitest, Node): variable precedence, URL building, auth (published vectors and
  independent implementations), HTTP engine against real local HTTP/HTTPS servers, storage and secret handling, Postman
  and other import-format fixtures and round-trips, script sandbox escapes/timeouts and script libraries, code
  snippets and cURL import, the CLI, IPC schemas, redaction, SQL injection, XSS payloads, policy enforcement, the full
  acceptance workflow at the service level.
* **E2E** (Playwright + Electron): launches the built app and drives the UI.

## Build

`npm run build` then `npm run pack` / `npm run dist` (electron-builder, config in `electron-builder.yml`). SQL migrations
are shipped as an extra resource. Sign installers in your CI (`win.certificateFile`, `mac.identity`).

## Troubleshooting

* **Electron binary missing** (`Electron failed to install correctly`): run `node node_modules/electron/install.js`.
* **"Secure storage unavailable"** (Linux): install/unlock a Secret Service keyring (GNOME Keyring, KWallet). Secrets are
  refused rather than stored insecurely.
* **TLS error on an internal server:** add the issuing CA under Settings → Certificates (preferred). Disabling validation
  is blocked unless policy allows it.
* **`CONFIRMATION_REQUIRED`:** a production environment is active and policy requires confirmation — confirm in the dialog.
* **Request hangs:** check the timeout in Settings → Network; use Cancel.
* **Logs:** `<userData>/logs/app.log` (redacted JSON lines). Data directory is shown in Help → About.

## Known limitations

* SQLite and the script sandbox run on the main-process thread: a very large import or a CPU-heavy script can make the
  window unresponsive until it finishes (timeouts apply to scripts).
* Postman exports have not been opened in the Postman application; compatibility is limited to the documented fields.
* Scripts: `xml2js` is a facade, `Buffer` and `csv-parse` are subsets, `pm.request.auth` is a redacted read-only view and
  `pm.sendRequest` auth supports only basic/bearer/API key; `cheerio`, `pm.require`, `setInterval`, `fetch` and `process`
  are not available. See the [scripting guide](docs/features/scripting.md).
* Akamai EdgeGrid is verified only against an independent implementation; NTLM is not executable.
* GraphQL bodies from Postman/Insomnia imports become raw JSON; there is no GraphQL introspection; Insomnia v5 is not
  supported. Importers are import-only (no export to OpenAPI/HAR/Insomnia).
* `aegis-cli` has no interactive OAuth, no client certificates or custom CAs, and no `bin`/installer packaging yet.
* Proxy support has not been tested against a live proxy; OAuth 2.0 interactive login requires manual verification.
* HTTP/2 is negotiated over TLS only (no h2c) and not through proxies; connection/TLS timings are unavailable through a proxy.
* Find & Replace regular expressions are bounded on a best-effort basis (pattern length limit, static rejection of nested
  quantifiers, a 2 s time budget) — a defence against catastrophic backtracking, not a proof. Preview before applying.
* Backups with history include only the most recent rows per workspace (configurable, default 500, maximum 100000).
* Literal credentials typed into headers/bodies are not detected by the "export without secrets" option — use variables.
* Installers are unsigned and there is no auto-update (by design).

## Roadmap

GraphQL schema introspection · native GraphQL body mapping on import · Insomnia v5 import · WebSocket, gRPC and
SSE/streaming protocol clients (needs an executor dispatch on top of `ProtocolClient`) · CLI: client certificates, custom
CAs, more reporters, `bin`/installer packaging · `cheerio`, `pm.require` and fuller `Buffer`/`xml2js`/`csv-parse` in
scripts · an official EdgeGrid test vector check ·
utility-process isolation for persistence and scripts · request-level certificate/proxy overrides · NTLM · Postman
Collection export validation against the official schema once network access is available.

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). License: [MIT](LICENSE).
