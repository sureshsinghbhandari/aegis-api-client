# Changelog

All notable changes are documented here. Format: Added / Changed / Fixed / Security / Documentation.

## [0.2.0] - Unreleased

Everything below is implemented and covered by automated tests (unit, integration, security, E2E), but 0.2.0 has not been
validated in a tagged release yet. Items that are only partially verified or implemented are marked 🟡. See
[docs/postman-gap-analysis.md](docs/postman-gap-analysis.md) for what remains out of scope.

### Added
- Request authoring: GraphQL body mode (query, variables, operation name; sent as `application/json`, exported as a Postman
  `graphql` body, no schema change); `{{variable}}` autocomplete, hover and unresolved underline in URL, params, headers,
  body editors and auth text fields (secrets masked); Bulk Edit for Params, Headers, urlencoded and form-data.
- HTTP runtime: HTTP/2 over TLS via ALPN (no h2c, not through proxies) with the real negotiated `httpVersion`; global and
  per-request HTTP version (auto / 2 / 1.1); Timeline DNS/TCP/TLS/TTFB/download bars, TLS protocol/cipher/ALPN and peer
  certificate details; per-request settings (disable cookie jar, encode URL, follow original method, follow
  `Authorization` header, remove Referer on redirect, max response size, strict SSL where policy allows) mapped to Postman
  `protocolProfileBehavior`; Settings → General → Working directory; Settings → Network → HTTP version and Host overrides;
  PKCS#12 (PFX) client certificates.
- Response tools and shell: Save response as example and an Examples tab (list/edit/delete); JSONPath filter in the Pretty
  view; Visualize tab for `pm.visualizer` output; network log in the Console (sends, `pm.sendRequest`, runner items);
  stacked / side-by-side layout toggle; open tabs restored after restart; Ctrl+Tab / Ctrl+Shift+Tab tab cycling and
  Ctrl+Shift+F find & replace; Markdown preview for request, collection and folder descriptions.
- Collection management: Find & Replace across a collection or workspace (preview, one transaction); folder duplicate
  (deep copy); move requests and folders to another collection (drag & drop or "Move to…"); cookie manager add/edit.
- Scripts UX: Variables side pane in the script editors, `pm.*` autocomplete, 18 additional snippets, Examples help popover.
- Authentication: Digest (MD5/SHA-256/-sess, qop `auth`/`auth-int`, 401 challenge round trip; verified against the RFC
  2617 example and an independent verifier), Hawk (README vectors), Akamai EdgeGrid (🟡 verified only against an
  independent in-test implementation), ASAP, OAuth 1.0 RSA-SHA1/-SHA256/-SHA512 and HMAC-SHA512, JWT ES256/384/512 and
  PS256/384/512, OAuth 2.0 device authorization grant; new `AuthContext.challenge()` hook. Imported Postman
  digest / hawk / edgegrid / asap requests now execute. NTLM remains preserved-only (🔴). See
  [docs/features/authentication.md](docs/features/authentication.md).
- `aegis-cli` command-line runner (`npm run build:cli`; `npm run cli -- run collection.json -e env.json -g globals.json
  -d data.csv --reporters cli,json,junit,html`) with `--policy`, `--insecure` (only if policy allows), `--production` and
  exit codes 0/1/2/3. No interactive OAuth; no `bin`/installer packaging yet (use `node dist/cli/aegis-cli.cjs`). See
  [docs/features/cli.md](docs/features/cli.md).
- Code snippets for 12 languages/tools and cURL import (paste into the URL bar). See
  [docs/features/code-generation.md](docs/features/code-generation.md).
- Script libraries: `require('lodash' | 'moment' | 'crypto-js' | 'uuid' | 'ajv' | 'tv4' | 'xml2js' | 'chai' | 'atob' |
  'btoa' | 'buffer' | 'csv-parse/lib/sync')` and the globals `_`, `CryptoJS`, `moment`, `tv4`, `xml2Json`, `Buffer`. They are
  MIT `devDependencies` bundled at build time (`npm run build:sandbox-libs`; no new runtime dependency), evaluated lazily
  inside the QuickJS sandbox and cannot reach the host. `xml2js` is a facade over fast-xml-parser, and `Buffer` and
  `csv-parse` are subsets (🟡).
- Scripting API: full `pm.response.to.have.jsonSchema` (JSON Schema draft-07 including `$ref` and `format`; draft-04 via
  tv4); `pm.cookies.jar().set/unset/clear` writing to the workspace cookie jar (200 operations per run); `pm.visualizer.set`
  (Handlebars inside the sandbox, 2 MiB cap) shown in the Visualize tab; `pm.environment.name`; `pm.sendRequest` trace
  lines in the Console; `pm.request.auth` read-only redacted view and `pm.sendRequest` `auth` for basic / bearer / API key
  (🟡). Still not available (🔴): `cheerio`, `pm.require`, `setInterval`, `fetch`, `process`.
- Import: File → Import now accepts OpenAPI 3.0/3.1 (JSON + YAML), Swagger 2.0, HAR 1.2, Insomnia v4, Postman Collection
  v1, Postman data dumps and Aegis workspace files, plus **Any Supported File** (auto-detect, Ctrl+Shift+O). Exported
  Aegis workspace files re-import as a new workspace. New importer registry (`importDocument`). GraphQL bodies from
  Postman/Insomnia are imported as raw JSON (🟡); Insomnia v5 is not supported (🔴). See
  [docs/features/import-formats.md](docs/features/import-formats.md).
- Runner: choose and order the requests to run; "Keep responses" (redacted, first 64 KiB, credential headers never
  stored); Export JUnit and Export HTML in the runner panel. Database migration 0001 adds the nullable column
  `collection_run_items.response_json`.
- Backup: the history limit is configurable (default 500, maximum 100000), shown in the Backup dialog and recorded in the
  backup file.

### Changed
- Request tabs renamed: "Tests" is now **Pre-request Script** / **Post-response** (JavaScript with `pm.*` autocomplete).
- The Console now shows a network log next to script output.
- History method filter lists every HTTP method (including TRACE and CONNECT); long custom methods such as `PROPFIND` are no
  longer truncated.
- Postman export writes native `graphql` bodies; import of `graphql` bodies is unchanged (raw JSON with the original kept
  in metadata).
- Folders can now be duplicated and nodes moved across collections; moved items inherit the target collection's auth,
  scripts and variables.
- The backup history cap is no longer a fixed 500 rows per workspace; it is a setting (default 500, maximum 100000).
- New runtime dependency: `yaml` (ISC, pure JavaScript) for OpenAPI/Swagger/Insomnia YAML import.
- The CLI and the desktop app share one policy loader, `loadPolicyFromFiles` (`@aegis/security`).

### Fixed
- `runScripts: false` is now honoured by the request executor (it was accepted and ignored).
- "Get new access token" resolves collection and folder variables and can be cancelled.
- The Timeline and `ResponseView.httpVersion` report the negotiated protocol instead of a constant `HTTP/1.1`.
- Imported relative form-data / binary file paths can be sent again: they resolve inside the configured working directory.
- Per-request `strictSSL` is no longer silently stored and ignored: it is honoured only when policy allows insecure TLS and
  is shown as enforced by policy otherwise.
- Ctrl+W no longer closes a tab with unsaved changes without asking.
- Collection runner: local variables are now reset exactly once per iteration.
- `pm.environment.name` now returns the active environment's name.

### Security
- New policy key `allowHostOverrides` (default `true`). When `false`, host overrides are ignored with a warning. Host
  overrides never bypass `blockedHosts` and never apply through a proxy.
- Per-request `strictSSL=false` requires policy `allowInsecureTls`.
- `followAuthorizationHeader` is opt-in, warned about, and `Cookie` / `Proxy-Authorization` are still never forwarded
  cross-origin.
- Relative file paths in bodies resolve only inside the working directory (`..`, UNC and device paths are rejected).
- PFX bundles and passphrases are stored in the secret vault.
- Tab persistence never writes secrets to `localStorage`.
- Find & Replace never reads or writes secret values or authorization parameters; its audit entry (`FIND_REPLACE`) stores
  counts only. Its regular-expression guard is best-effort (static nested-quantifier rejection plus a time budget).
- Markdown descriptions, the Visualize tab and HTML preview render only inside sandboxed iframes (no scripts, no remote
  images); the JSONPath filter is parsed, not evaluated.
- Importers perform no network or file access: external `$ref`s, `externalValue` examples and external scripts are
  ignored with a warning. YAML uses the core schema only (no custom tags), with an alias-bomb guard and a 64 MiB cap.
- HAR credentials (Authorization, Cookie, API-key style fields, also inside JSON bodies) are never imported literally;
  they become empty secret `{{har_*}}` variables.
- Stored run responses ("Keep responses") are redacted, limited to the first 64 KiB, and never contain credential headers.
- Script libraries are bundled at build time and evaluated lazily inside the sandbox; they cannot reach the host.
  Cookie-jar writes from scripts cannot create, replace or remove `HttpOnly` cookies, are audited as
  `SCRIPT_COOKIE_WRITE` (names only), surfaced as a warning and limited to 200 operations per run. `pm.visualizer`
  output is script-stripped, redacted, capped at 2 MiB and rendered only in the sandboxed iframe.
- The CLI refuses `--insecure` unless the policy allows insecure TLS.

### Documentation
- README: new feature rows, "Postman parity" section, honest 🟡/🔴 status for partial features; corrected claims about
  examples, the Console, folder duplicate and cross-collection move; `ProtocolRegistry` described accurately; the
  OpenAPI/Swagger import row and roadmap entry replaced by the new import formats; backup history limit documented.
- SECURITY: new policy key, new controls and known limitations (importers, script libraries, cookie jar, visualizer, stored
  run responses); ARCHITECTURE: `apps/cli`, `@aegis/codegen`, importer registry and script library bundle;
  CONTRIBUTING: protocol extension point reworded.
- New feature guides under `docs/features/` and `docs/postman-gap-analysis.md`.

## [0.1.0] - 2026-10-04

### Added
- Electron + React + TypeScript desktop application (`apps/desktop`), packaged with electron-builder.
- SQLite storage (`node:sqlite`) with Drizzle ORM schema and migrations; workspaces, collections, nested folders, requests,
  headers, query/path parameters, bodies (raw, urlencoded, form-data, binary), examples.
- HTTP engine (undici): redirects, timeouts, cancellation, size limits with decompression-bomb protection, spill-to-disk for
  large responses, cookie jar, custom CA certificates, client certificates (mutual TLS), HTTP(S) proxy with NO_PROXY.
- Variables: global, environment, collection, folder, local, iteration data; single central resolver with documented
  precedence; dynamic-variable provider system; secret variables.
- Authentication: basic, bearer, API key, OAuth 2.0 (authorization code + PKCE, client credentials, password, refresh),
  OAuth 1.0, JWT (sign/decode), AWS SigV4, inheritance (request → folder → collection).
- Scripting: QuickJS (WASM) sandbox with Postman-compatible `pm.*` API, chai assertions, `pm.sendRequest`, console capture.
- Collection runner with CSV/JSON iteration data, delay, stop-on-failure, `setNextRequest`, run history.
- Postman import (collection v2.0/v2.1, environment, globals) with preview, warnings, transactional commit; Postman v2.1
  and environment export; semantic round-trip tests.
- History with privacy settings, retention, search/filter/pagination, replay.
- Backup / restore (optional passphrase encryption), audit log, enterprise policy file, local-only mode.
- Test suites: unit, integration, security, and Playwright end-to-end.

### Security
- Context isolation, sandboxed renderer, strict CSP, validated IPC, OS-backed secret storage, redaction everywhere,
  exports without secrets by default.

### Documentation
- README, ARCHITECTURE, SECURITY, API, CONTRIBUTING, Postman compatibility matrix, scripting guide.
