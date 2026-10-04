# Aegis API Client

A secure, **local-first** desktop API client (in the spirit of Postman) for organizations that cannot or do not want to
depend on a cloud SaaS. No account, no sync, no telemetry — it sends exactly the requests you tell it to.

> **Postman compatibility:** Postman Collection v2.1 compatible *for supported fields/features*. See the
> [compatibility matrix](docs/postman-compatibility/compatibility.md) for exactly what is supported, preserved or not handled.

Status legend used throughout: ✅ Implemented and tested · 🟡 Partial · 🔴 Not implemented.

## Contents

[Why](#why-this-application-exists) · [Quick start](#installation) · [Features](#features) · [Examples](#examples) ·
[Variables](#variables) · [Authentication](#authentication) · [Scripts & tests](#scripts-tests-and-pm-compatibility) ·
[Runner](#collection-runner) · [Postman](#postman-import-and-export) · [Security](#security-architecture) ·
[Development](#development) · [Troubleshooting](#troubleshooting) · [Limitations](#known-limitations) · [Roadmap](#roadmap)

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
| Methods GET POST PUT PATCH DELETE HEAD OPTIONS TRACE CONNECT + custom | ✅ | Custom methods accepted by model and UI |
| Query params, path variables (`:id`), headers (enable/disable, descriptions) | ✅ | Stored URL is never overwritten by resolution |
| Bodies: none, raw (JSON/XML/text/HTML/JS), urlencoded, form-data (text/file/variable), binary | ✅ | Files are streamed from disk, never fully loaded |
| Response viewer: Pretty, Raw, Preview, Headers, Cookies, Tests, Timeline | ✅ | Large bodies are chunked/virtualised or saved to file; HTML preview is sandboxed |
| Workspaces (Personal/Team/Enterprise, local), collections, nested folders, drag & drop, search | ✅ | Tree rows are loaded flat and virtualised (tested with 2,000+ requests; designed for 10,000+) |
| Environments, global/collection/folder/local/iteration variables, secret variables, dynamic variables | ✅ | See [Variables](#variables) |
| Production environment banner + policy-controlled confirmation | ✅ | |
| Authentication: none, basic, bearer, API key, OAuth 2.0 (+PKCE), OAuth 1.0, JWT, AWS SigV4, custom provider API, inheritance | ✅ | OAuth 2.0 authorization-code flow needs an interactive window (manual verification only) |
| Cookie jar (Set-Cookie, domain, path, expiry, Secure, HttpOnly, SameSite) + manager UI | ✅ | Values stored in OS-protected storage |
| TLS: HTTPS, custom CA, client certificates, policy-controlled "do not verify" | ✅ | Tested with a self-signed certificate |
| Proxy: HTTP/HTTPS proxy, proxy auth, NO_PROXY, system proxy | 🟡 | Config + logic tested; not tested against a real proxy server |
| Request history with privacy settings, retention, search/filter/sort, pagination, replay, save to collection | ✅ | Bodies are **not** stored unless enabled |
| Pre-request / post-response scripts, tests, `pm.*`, `pm.sendRequest`, console | ✅ | QuickJS sandbox; some `pm` features are 🟡/🔴 — see scripting guide |
| Collection runner: iterations, delay, stop on failure, CSV/JSON data, `setNextRequest` | ✅ | |
| Postman import (v2.0/v2.1, environment, globals) with preview, warnings, rollback | ✅ | |
| Postman export (v2.1, environment) without secrets by default | ✅ | |
| Backup / restore (optional passphrase encryption) | ✅ | |
| Audit log, enterprise policy file, local-only mode | ✅ | |
| Dark / light themes, resizable panels, context menus, confirmation dialogs | ✅ | |
| Desktop packaging (electron-builder) | 🟡 | Unpacked build verified on Windows; installers not signed |
| OpenAPI / Swagger import | 🔴 | Roadmap. The menu entry explains this. |
| GraphQL, WebSocket, gRPC clients | 🔴 | Roadmap. Architecture: `ProtocolClient` adapters |
| CLI runner | 🔴 | Roadmap. All logic is Electron-free (`@aegis/app`) |

### Supported HTTP methods

`GET POST PUT PATCH DELETE HEAD OPTIONS TRACE CONNECT` and any custom token.

### Request builder

Method + URL bar (query string edits sync with the Params table), Params (query + path variables), Headers, Body,
Authorization, Pre-request Script, Tests, Settings (timeout / redirects overrides), Docs. Default headers
(`User-Agent`, `Accept`, `Accept-Encoding`, `Content-Type` for raw bodies) are added only if you did not set them.

### Response viewer

Status, status text, duration, size, content type; Pretty (JSON/XML/HTML formatting, folding, search, copy), Raw,
Preview (sandboxed HTML, images), Headers, Cookies, Test Results, Timeline (redirect hops, waiting/download time,
resolved request with secrets masked, warnings, unresolved variables). Binary content can be saved to a file.

### Collections, folders, workspaces

Workspace → Collection → nested Folders → Requests. Create, rename, delete, duplicate, move (drag & drop), reorder,
search, run, export. Collections and folders carry their own authorization, scripts and variables. Workspaces can be
created, renamed, deleted, searched and exported; the whole database can be backed up.

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
// Login, Tests tab:
pm.environment.set("token", pm.response.json().token);
// Get User, Tests tab:
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
password, refresh) · OAuth 1.0 (HMAC-SHA1/-SHA256/PLAINTEXT) · JWT (HS256/384/512, RS256/384/512; sign + decode) · AWS
Signature V4 · custom (`AuthRegistry.register`). Inheritance: request → folder → collection (`inherit` / explicit `none`).
Refreshed OAuth tokens are written back (encrypted) to the auth config that owns them. Digest/Hawk/NTLM/EdgeGrid are
preserved on Postman import/export but 🔴 not executable. Signing algorithms are verified against published vectors
(OAuth1 reference signature, jwt.io token, AWS SigV4 test suite).

## Cookies

Per-workspace jar following RFC 6265 (domain/path matching, expiry incl. `Max-Age=0` deletion, Secure, HttpOnly,
SameSite). Cookies are applied on every redirect hop. Scripts never see `HttpOnly` cookies. Manage them in
Settings → Cookies (values hidden until revealed).

## TLS / certificates

Certificate validation is **on** and cannot be turned off unless the organization policy sets `allowInsecureTls: true`
*and* the user disables it in Settings (a warning is shown on every such request). Add custom CA certificates and
client certificates (PEM certificate + key + optional passphrase, host pattern like `*.corp.example`) in Settings →
Certificates. Keys are stored in OS-protected storage.

## Proxy

Settings → Network: none / system / manual (HTTP, HTTPS, NO_PROXY, username + password). System proxy uses the OS
resolver, falling back to `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`.

## History

Every send is recorded (unless disabled) with timestamp, method, redacted URL, status, duration, sizes, environment and a
replayable *unresolved* request snapshot. Request/response **bodies are not stored by default**; sensitive literals are
masked. Retention: 7 / 30 / 90 / 365 days or unlimited. Search by URL/name, method, status class, date; sort; paginated
(never loads unbounded rows). Replay re-runs the saved request (or the snapshot if it was deleted).

## Scripts, tests and `pm.*` compatibility

Pre-request and post-response scripts run in an isolated QuickJS (WebAssembly) sandbox: no `require`, `process`, `fs`,
network (except `pm.sendRequest`), timers beyond the run, or host objects; default timeout **5 s** (policy-capped),
memory and stack limits, console capture with secret redaction. Implemented: `pm.request`, `pm.response`,
`pm.environment`, `pm.collectionVariables`, `pm.variables`, `pm.globals`, `pm.cookies` (read), `pm.iterationData`,
`pm.info`, `pm.execution` (`setNextRequest`, `skipRequest`), `pm.test` (sync/async/skip), `pm.expect` (full chai),
`pm.sendRequest` (callback and promise style, same security policy). 🟡/🔴 items (cookie jar writes, `jsonSchema`
subset, `require`, `CryptoJS`, lodash `_`, `pm.visualizer`, …) are listed in
[docs/features/scripting.md](docs/features/scripting.md).

## Collection runner

Choose collection (or folder), environment, iterations, delay, stop-on-failure and an optional CSV/JSON data file
(exposed as `pm.iterationData`). Results stream live: `✓ Login 200 182ms`. Results are persisted and can be exported
(JSON/CSV in the UI; `formatRunReport` / JUnit XML in `@aegis/testing`).

## Postman import and export

Import: File → Import → Postman Collection / Environment (also drag & drop). Pipeline: parse → detect schema → validate →
normalise → convert → preview → **single database transaction** → report. The preview shows folders, requests, variables,
scripts, examples and warnings; Cancel changes nothing, and a failure rolls everything back (including secrets).
Unknown fields are preserved in metadata and re-emitted on export, with warnings. Progress
(Parsing / Validating / Importing / Saving / Finalizing, "1,250 / 5,000 requests") is streamed. Export: File → Export →
Postman Collection v2.1 / Environment; deterministic output; secrets excluded unless you explicitly include them.

### Environment import/export

Postman environment and globals JSON (`name`, `values[key,value,type,enabled]`). Export **without secrets** is the
default; including secrets needs an explicit confirmation and may be forbidden by policy.

### Compatibility matrix (summary)

| Feature | Import | Export | Runtime |
| --- | --- | --- | --- |
| Collection v2.0 | ✅ | v2.1 (converted) | ✅ |
| Collection v2.1 | ✅ | ✅ | ✅ |
| Environment / globals | ✅ | ✅ | ✅ |
| Variables (incl. secret) | ✅ | ✅ | ✅ |
| Scripts / tests | ✅ | ✅ | ✅ (QuickJS; gaps documented) |
| Examples | ✅ | ✅ | documentation only |
| Basic / Bearer / API key auth | ✅ | ✅ | ✅ |
| OAuth 2.0 / OAuth 1.0 / JWT / AWS | ✅ | ✅ | ✅ |
| Digest / Hawk / NTLM / EdgeGrid | preserved | preserved | 🔴 |
| Form-data / urlencoded / binary | ✅ | ✅ | ✅ |
| GraphQL body | 🟡 (as raw JSON) | 🟡 (restored) | 🟡 |

Full matrix with limitations: [docs/postman-compatibility/compatibility.md](docs/postman-compatibility/compatibility.md).
Honest caveat: exports are checked by our own structural validator and semantic round-trip tests; they have not been
imported into the Postman application itself.

## Security architecture

See [SECURITY.md](SECURITY.md) and [ARCHITECTURE.md](ARCHITECTURE.md). Highlights: sandboxed renderer without Node access;
a narrow typed preload API; every IPC call checked (sender + schema); strict CSP; sandboxed HTML preview; script sandbox
with resource limits; parameterised SQL only; path validation for uploads and imports; redacted logs/audit/history.

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
workspaces and never overwrites existing data or changes security/network settings.

### Enterprise policy

Admin-controlled `policy.json` (see [SECURITY.md](SECURITY.md#enterprise-policy)): disallow insecure TLS, require/block
production sends, force local-only, cap script timeout and response size, forbid secret export, block hosts.

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
npm run pack         # unpacked app in release/ ; npm run dist for installers
npm run audit        # npm audit for production dependencies
```

Layout: `apps/desktop/{main,preload,renderer}`, `packages/*` (see ARCHITECTURE.md), `database/migrations`,
`tests/{unit,integration,security,e2e,fixtures/postman}`, `docs/`.

## Testing

* **Unit / integration / security** (Vitest, Node): variable precedence, URL building, auth (published vectors), HTTP
  engine against real local HTTP/HTTPS servers, storage and secret handling, Postman fixtures and round-trips, script
  sandbox escapes/timeouts, IPC schemas, redaction, SQL injection, XSS payloads, policy enforcement, the full acceptance
  workflow at the service level.
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
* Cookie-jar mutation from scripts, `require()` and libraries such as `CryptoJS`/lodash are unavailable in scripts.
* Proxy support has not been tested against a live proxy; OAuth 2.0 interactive login requires manual verification.
* Literal credentials typed into headers/bodies are not detected by the "export without secrets" option — use variables.
* Installers are unsigned and there is no auto-update (by design).

## Roadmap

OpenAPI/Swagger import (JSON + YAML) · GraphQL, WebSocket and gRPC protocol clients · CLI runner (`@aegis/app` is
Electron-free) · utility-process isolation for persistence and scripts · richer reports · request-level certificate/proxy
overrides · Postman Collection export validation against the official schema once network access is available.

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). License: [MIT](LICENSE).
