# Postman feature-gap analysis and implementation backlog

Scope: what a Postman **desktop** user relies on day to day, compared with Aegis API Client as it exists in this
repository (read on 2026-10-12, commit `2353234`). Source of the Postman feature list: the Postman Learning Center and
the Postman v11 desktop app (no network was used while writing this document; the list is from product knowledge).

Everything in the "Aegis today" column was verified by reading the code, not the README. Where the documentation
overclaims, the row says so and the item is repeated in [Findings](#findings-bugs-inconsistencies-and-doc-overclaims).

Legend

| Column | Values |
| --- | --- |
| Decision | **HAVE** (implemented, cite), **PARTIAL** (what is missing), **MISSING**, **EXCLUDED** (cloud/SaaS/telemetry/AI items that contradict local-first; reason given), **DEFER** (feasible but not in this backlog) |
| Value | H / M / L for an enterprise team replacing Postman |
| Effort | S (<= 1 engineer-day), M (2-4 days), L (1-2 weeks), XL (> 2 weeks) |
| Sec | security / policy implications for a local-only, secrets-safe, policy-aware product |

Constraints every backlog item respects: no network at build or test time, no native modules, no C++ toolchain
(Node 26 / Electron 44, QuickJS-WASM sandbox, undici, `node:sqlite`). New npm dependencies are flagged explicitly.

---

## 1. Feature comparison

### 1.1 Request building

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Method + URL bar, custom methods | Yes | `workspace/UrlBar.tsx`, `HTTP_METHODS` + custom token | - | - | - | HAVE |
| URL <-> Params sync, path variables `:id` | Yes | `lib/urlSync.ts`, `core/url.ts`, Params tab | - | - | - | HAVE |
| Variable autocomplete (`{{` popup) and hover showing scope/value/"unresolved" | Yes (URL, params, headers, body, auth) | None. URL bar is a plain `<input>`; Monaco body editor has no `{{` completion; unresolved variables only reported **after** a send (`result.unresolvedVariables`) | Autocomplete + hover + inline unresolved highlighting before sending | H | M | MISSING -> **WP-A** |
| Bulk edit (text mode `key:value` per line) for params/headers/urlencoded/form-data | Yes | `components/ui.tsx` `KeyValueTable` has no text mode | Bulk edit toggle | H | S | MISSING -> **WP-A** |
| Header name autocomplete | Yes | `<datalist>` with `COMMON_HEADERS` (`ParamsHeadersTabs.tsx`) | Fine for v1 | - | - | HAVE |
| Auto-generated headers shown in table (greyed) | Yes | Explained in a collapsible hint; final headers visible in Timeline after send | Cosmetic | L | S | PARTIAL (defer) |
| Paste cURL into URL bar / "Import raw text" | Yes | Not parsed; cURL text lands in the URL field | cURL parser + paste detection + import dialog | H | S | MISSING -> **WP-A** |
| Body: none / form-data / urlencoded / raw (JSON, XML, text, HTML, JS) / binary | Yes | `core/model.ts` `BodyMode`, `BodyTab.tsx`, files streamed (`http-client/body.ts`) | - | - | - | HAVE |
| Multiple files per form-data field | Yes | One file per entry; Postman import keeps only the first (`compatibility.md`) | Allow array of files per key | L | S | PARTIAL (defer) |
| Beautify body, Content-Type override | Yes | `BodyTab.tsx` | - | - | - | HAVE |
| GraphQL body mode (query + variables editor) | Yes | No `graphql` body mode; Postman `graphql` bodies are imported as raw JSON (`postman/import-parts.ts`) | Native mode with query/variables editors | H | M | PARTIAL -> **WP-A** (mode); introspection/schema explorer DEFER |
| GraphQL schema introspection & explorer | Yes | None | Introspection POST (user-initiated, same policy as a request) + Monaco completion from schema | M | L | DEFER (after WP-A) |
| WebSocket client (raw + Socket.IO) | Yes | None (`ProtocolClient` abstraction exists in `core/protocol.ts` but is never instantiated) | New protocol client (Node 22+/undici `WebSocket`, zero dep), streaming IPC events, message log UI | H | L | DEFER (phase 2; design note in section 4) |
| Server-Sent Events / streaming response view | Yes | Response is read to completion (`http-client/client.ts` `readBody`); no live streaming | Streaming body events | M | L | DEFER |
| gRPC (proto import, reflection, streaming) | Yes | None | Needs protobuf parser (dependency) + HTTP/2 | M | XL | DEFER |
| MQTT | Yes | None | Needs MQTT client dependency | L | L | DEFER |
| SOAP / WSDL | Yes (WSDL import, SOAP body helpers) | Raw XML POST works; no WSDL import | WSDL -> requests (needs an XML parser in the main process; none in Node without a dep) | L | L | PARTIAL (defer) |
| Request description / docs (Markdown rendered) | Yes | Plain `<textarea>` (`MiscTabs.tsx` `DocsTab`), not rendered | Markdown render (sanitised, sandboxed) | M | M | PARTIAL -> **WP-E** (view-only renderer) |
| Save/duplicate/rename/close/reopen tabs, unsaved dot | Yes | `store/app.ts`, `TabsBar.tsx` | Ctrl+W bypasses the unsaved-changes confirm (`lib/shortcuts.ts` calls `closeTab`, the X button calls `requestCloseTab`) | - | S | HAVE (bug) -> **WP-E** |
| Tabs restored after restart | Yes | Tabs live in memory only; `closedTabs` lost on quit | Persist open tab ids + non-secret draft state | M | S | MISSING -> **WP-E** |

### 1.2 Request settings (Postman "Settings" tab + global)

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Timeout, follow redirects, max redirects (per request) | Yes | `RequestSettings` + `SettingsTab` in `MiscTabs.tsx` | - | - | - | HAVE |
| Max response size (per request) | Global only in Postman | `settings.maxResponseBytes` honoured by `prepare.ts` but **not exposed in the UI** | UI field (policy-clamped) | L | S | PARTIAL -> **WP-B** |
| Enable SSL certificate verification (per request) | Yes | `settings.verifyTls` is stored and round-tripped (`strictSSL`) but **never applied** (`prepare.ts` only uses the global `options.tls`); UI says "cannot be turned off per request" | Honour per request only when policy `allowInsecureTls` is true and the global switch is off; otherwise show as enforced | M | S | PARTIAL -> **WP-B** |
| Disable cookie jar for this request | Yes | No switch; jar hook always applied (`executor.ts` `cookieHook`) | `settings.disableCookies` | M | S | MISSING -> **WP-B** |
| Encode URL automatically (on/off) | Yes | Always encodes query via `encodeQueryComponent`; no raw mode | `settings.encodeUrl: false` sends the URL as typed | M | S | MISSING -> **WP-B** |
| Redirect options: follow original method, follow Authorization header, remove Referer | Yes | Fixed behaviour: 303/301/302-POST become GET; Authorization/Cookie always dropped cross-origin (`client.ts`) | Three booleans (secure defaults kept) | M | S | MISSING -> **WP-B** |
| Disable body pruning (GET with body) | Yes | Body is sent for any method already; `disableBodyPruning` preserved only | Map the key, no behaviour change needed | L | S | PARTIAL (doc only) -> **WP-B** |
| HTTP version (auto / 1.1 / 2) | Yes (HTTP/2 since v10) | Always HTTP/1.1; `httpVersion` is **hard-coded** `'HTTP/1.1'` in `client.ts:188` | undici `Agent({ allowH2: true })` (zero dep) + per-request preference + report negotiated ALPN | M | M | MISSING -> **WP-B** |
| DNS / host override | Not a Postman request setting (Postman relies on OS hosts file) | None | Optional global `hosts` map via undici `connect.lookup` (useful for staging without editing `/etc/hosts`) | L | S | MISSING -> **WP-B** (optional, policy-gated) |
| Working directory for relative file paths | Yes (Settings -> General -> Working directory) | Imported form-data/binary `src` paths are kept relative (`checkImportedFilePath`) but `assertSafeFilePath` rejects relative paths at send time, so every imported file upload fails until re-picked | `files.workingDirectory` setting, used as `allowedRoots` | M | S | MISSING -> **WP-B** |
| Custom User-Agent / no-cache / Postman-Token header toggles | Yes | `User-Agent: AegisApiClient/0.1` added if absent; no toggles | Low | L | S | PARTIAL (defer) |
| Request-level certificate / proxy | Postman has per-request cert via file, proxy global | Preserved from Postman import, not applied (`compatibility.md`) | Per-host client certs already cover the common case | L | M | PARTIAL (defer) |

### 1.3 Authentication

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| No auth, inherit, Basic, Bearer, API key (header/query) | Yes | `authentication/simple.ts`, inheritance `inheritance.ts` | - | - | - | HAVE |
| OAuth 2.0: auth code (+PKCE), client credentials, password, refresh, token to header/query | Yes | `oauth2.ts`, interactive window `oauth-window.ts`, refreshed tokens persisted (`executor.persistAuthParams`) | Implicit grant (deprecated) and device-code grant missing; "Get new access token" (`tools.oauth2GetToken`) resolves only environment + globals, **ignores collection/folder variables** although the API accepts `collectionId/folderId` | M | S | PARTIAL -> **WP-B** (scope fix + device code) |
| OAuth 2.0 token manager (multiple named tokens, auto-refresh toggle) | Yes | One token set per auth config | Low | L | M | DEFER |
| OAuth 1.0 (HMAC-SHA1/256, PLAINTEXT) | Yes (+RSA-SHA1) | `oauth1.ts` | RSA-SHA1 missing (node:crypto, trivial) | L | S | PARTIAL -> **WP-B** |
| JWT bearer (HS*/RS*) | Yes (+ES*, PS*) | `jwt.ts` HS256/384/512, RS256/384/512 | ES256/384/512, PS256 via node:crypto | L | S | PARTIAL -> **WP-B** |
| AWS Signature v4 | Yes | `sigv4.ts` (verified against AWS vectors) | - | - | - | HAVE |
| Digest | Yes | Preserved as `custom`, not executable | Needs a 401 challenge round-trip inside the executor (MD5/SHA-256, qop auth) | M | M | MISSING -> **WP-B** |
| Hawk | Yes | Preserved only | HMAC-SHA256 header, pure node:crypto | L | S | MISSING -> **WP-B** |
| Akamai EdgeGrid | Yes | Preserved only | HMAC-SHA256 signing, pure node:crypto | L | S | MISSING -> **WP-B** |
| ASAP (Atlassian) | Yes | Preserved only | RS256 JWT with `kid`/`iss`/`aud`; reuse `jwt.ts` | L | S | MISSING -> **WP-B** |
| NTLM | Yes | Preserved only | Needs MD4 (not in OpenSSL 3 default provider -> pure-JS MD4) + multi-leg handshake on one connection | M | L | DEFER |
| Custom auth providers (`AuthRegistry.register`) | No | Yes | - | - | - | HAVE (extra) |

### 1.4 Response handling

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Pretty / Raw / Preview (sandboxed HTML, images) / Headers / Cookies / Tests | Yes | `response/*`, sandboxed `<iframe sandbox="">` | - | - | - | HAVE |
| Search in body (Ctrl+F), fold, wrap, copy, save to file | Yes | Monaco read-only editor, `LargeBodyViewer` for big bodies, `responses.saveAs` | - | - | - | HAVE |
| JSONPath / filter box above Pretty view | Yes (`$.data[*].id`) | None | Zero-dep JSONPath subset (`$`, `.`, `[n]`, `[*]`, `..`, filters `[?(@.x==1)]`) applied to the parsed body | M | S | MISSING -> **WP-E** |
| Visualize tab (`pm.visualizer`) | Yes | `pm.visualizer.set` throws (`guest/pm.ts`) | Template rendered inside the sandbox, shown in a sandboxed iframe; **no script execution** (renderer CSP `script-src 'self'` is inherited by `srcdoc`) | M | M | MISSING -> **WP-C** (engine) + **WP-E** (tab) |
| Save response as example; examples tab on the request | Yes | Examples are stored (`request_examples`, `RequestExample`, import/export round-trip) but there is **no UI at all** to view, add or edit them; README says "documentation only" | Examples tab + "Save as example" button | H | M | PARTIAL -> **WP-E** |
| Size breakdown (headers vs body) and timing breakdown (DNS, TCP, TLS, TTFB, download) | Yes | `timings`: waiting + download only; `requestSize` includes headers, response size is body only (`Timeline.tsx`) | Custom undici `connect` wrapper to time DNS/TCP/TLS and read ALPN/cipher/peer cert | M | M | PARTIAL -> **WP-B** |
| Network details (local/remote IP, TLS cipher, certificate chain) | Yes | None | Same connector hook | M | S (with the above) | MISSING -> **WP-B** |
| Cookies tab | Yes | `ResponseTables.tsx`, `parseSetCookie` | - | - | - | HAVE |
| Response status description tooltip | Yes | `statusText` only | Static table | L | S | DEFER |
| Compare two responses / diff | No (3rd party) | None | - | L | M | DEFER |

### 1.5 Code generation

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| "Code" snippet panel (cURL, HTTP, JS fetch/axios, Node, Python requests, Go, Java, C#, PHP, PowerShell, Ruby, Swift, Kotlin, Dart, R, Objective-C, Shell/HTTPie, wget) | Yes (postman-code-generators) | None | New pure-TS generator package. Generate from the draft with non-secret variables substituted and secrets left as `{{name}}`; "copy as sent" from the last execution's redacted request (`result.request`). Revealing secrets in a snippet is an explicit, audited action gated by `allowSecretExport` | H | M | MISSING -> **WP-A** |

### 1.6 Import / export

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Postman Collection v2.0 / v2.1 import, v2.1 export | Yes | `packages/postman`, transactional import with preview/warnings/rollback | - | - | - | HAVE |
| Environment / globals import & export | Yes | `import-environment.ts`, `export-environment.ts` | - | - | - | HAVE |
| Postman Collection v1 (`order`/`requests`) | Import yes | Rejected `IMPORT_INVALID` | v1 -> bundle converter (JSON only) | M | M | MISSING -> **WP-D** |
| Postman data dump / workspace export (JSON with `collections[]`, `environments[]`, `globals`) | Import yes | Not handled | Detect + split into the existing importers | M | S | MISSING -> **WP-D** |
| Aegis workspace file (`*.aegis-workspace.json`) | n/a | Exported by `workspaces.export` (`core-services.ts:74`) but **cannot be imported**: `import-export.ts` `preview()` accepts only `postman-collection|postman-environment|backup`, and `validateBackup` rejects `format: 'aegis-workspace'`. `ImportPreview.kind` and `ImportModal.tsx:140` contain dead branches for it | Add the import path (reuse backup restore) | M | S | PARTIAL (bug) -> **WP-D** |
| OpenAPI 3.0 / 3.1 (JSON + YAML) | Yes | Menu entry shows "not available" (`main.ts` `unsupported`) | Converter: paths -> folders by tag, operations -> requests, servers -> `{{baseUrl}}`, parameters/requestBody examples -> bodies, securitySchemes -> auth. YAML needs a parser (**new dependency** `yaml`, ISC, pure JS) or JSON-only first | H | L | MISSING -> **WP-D** |
| Swagger 2.0 | Yes | None | Same converter with a 2.0 front-end | M | M | MISSING -> **WP-D** |
| HAR 1.2 | Yes | None | Entries -> requests (headers, query, postData), JSON only | M | S | MISSING -> **WP-D** |
| cURL (single command) | Yes | None | Parser shared with the paste feature | H | S | MISSING -> **WP-A** (parser) |
| Insomnia v4 export (`_type: export`) | Yes | None | JSON mapping (workspace/folder/request/environment) | M | M | MISSING -> **WP-D** |
| Bruno (`.bru` folders) | No (Bruno imports Postman) | None | Text format parser | L | M | DEFER |
| RAML 0.8 / 1.0 | Yes | None | YAML + RAML semantics | L | L | DEFER |
| WSDL 1.1 / 2.0 | Yes | None | XML parser needed | L | L | DEFER |
| GraphQL schema (SDL/introspection JSON) -> collection | Yes | None | Depends on GraphQL work | L | M | DEFER |
| Git repository / folder import | Yes (cloud-linked) | None | Local folder of collection JSON files is feasible | L | S | DEFER |
| Export collection as v2.0 | Yes | v2.1 only | Low | L | S | DEFER |
| Export without secrets (default), audited secret export, policy `allowSecretExport` | Partial in Postman | Yes | - | - | - | HAVE (better) |

### 1.7 Collections

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Workspace > collection > nested folders > requests; drag & drop; rename; delete; search | Yes | `sidebar/CollectionsTree.tsx` (virtualised), `collections.search` | - | - | - | HAVE |
| Duplicate collection / request | Yes | `collections.duplicate`, `requests.duplicate` | **Folders cannot be duplicated** (`duplicateEntity` accepts `'collection' \| 'request'` only; no `folders.duplicate` channel) | M | S | PARTIAL -> **WP-E** |
| Move request/folder to another collection | Yes | `planNodeMove` returns `null` across collections (`lib/collectionTree.ts:161`); `requests.move` has no target collection | Cross-collection move (DB: update `collectionId` recursively) | M | S | MISSING -> **WP-E** |
| Collection / folder docs (Markdown) | Yes | Description textarea in `CollectionEditModal.tsx` | Render view | M | S | PARTIAL -> **WP-E** (with request docs) |
| Collection/folder auth, scripts, variables | Yes | `CollectionEditModal.tsx`, `FolderUpdate`, `VariablesEditor` | - | - | - | HAVE |
| Examples per request | Yes | See 1.4 | UI | H | M | PARTIAL -> **WP-E** |
| Find & replace across a collection (URL, headers, body, scripts, variables) | Yes | None | Main-process, transactional, audited (`FIND_REPLACE`), preview count first, never touches `secretref:` values | M | M | MISSING -> **WP-E** |
| Collection-level `protocolProfileBehavior` applied | Yes | Preserved, not applied | Inherit request settings from folder/collection | L | M | DEFER |
| Tags, favourites, pinned collections | Tags are cloud/Enterprise | None | Local-only favourites are easy but low value | L | S | DEFER |
| Trash / restore deleted collections | Cloud trash | Hard delete | Local soft-delete (30 days) | L | M | DEFER |
| Fork / merge / pull requests / changelog / comments / watch | Cloud | - | - | - | - | EXCLUDED (needs Postman cloud; a local collection diff tool is a possible DEFER item) |
| Collection run order / select subset in Runner | Yes | Runner runs all requests of a collection or folder in tree order (`history-runner.ts` `collectRequests`) | Checkbox list + drag order in `RunnerModal` | M | M | PARTIAL -> **WP-D** |

### 1.8 Scripting (`pm.*`)

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Sandbox, pre-request + post-response at collection/folder/request level, console capture, timeouts | Yes (Node vm) | QuickJS-WASM, stronger isolation (`packages/scripting`) | - | - | - | HAVE (better) |
| `pm.variables/environment/collectionVariables/globals/iterationData` | Yes | `guest/core.ts` | `pm.environment.name` returns the literal string `'environment'` (`guest/pm.ts:230`); Postman returns the active environment's name | L | S | PARTIAL -> **WP-C** |
| `pm.request` (url/method/headers/body mutation) | Yes | `guest/request.ts` | `pm.request.auth` (read) missing; `pm.request.certificate/proxy` missing | L | S | PARTIAL -> **WP-C** |
| `pm.response` incl. `.to.have.*`, `jsonBody`, `jsonSchema` | Yes (ajv/tv4) | `guest/response.ts`; `jsonSchema` is a subset, `$ref`/`format` unsupported | Full draft-07 via bundled ajv | M | M | PARTIAL -> **WP-C** |
| `pm.cookies` read, `pm.cookies.jar().get/getAll` | Yes | Yes (httpOnly hidden) | - | - | - | HAVE |
| `pm.cookies.jar().set/unset/clear` | Yes | No-ops with a warning | Host bridge `cookieJar(op)` -> `CookieJarService` (workspace jar), audited | M | M | MISSING -> **WP-C** |
| `pm.sendRequest` (callback + promise) | Yes | Yes, same policy/TLS/proxy as normal requests | `auth` option, file bodies not supported; calls are not shown in the console | M | S | PARTIAL -> **WP-C** |
| `pm.test`, `pm.test.skip`, `pm.expect` (chai), async tests | Yes | Yes | - | - | - | HAVE |
| `pm.execution.setNextRequest / skipRequest / location` | Yes | Yes | - | - | - | HAVE |
| Legacy `postman.*`, `tests[]`, `responseBody` etc. | Yes | Yes | - | - | - | HAVE |
| `require('lodash' \| 'moment' \| 'crypto-js' \| 'uuid' \| 'ajv' \| 'tv4' \| 'xml2js' \| 'cheerio' \| 'chai' \| 'atob' \| 'btoa' \| 'csv-parse/lib/sync')` and the globals `_`, `CryptoJS`, `moment`, `xml2Json`, `Buffer` | Yes | All throw "not available" (`guest/pm.ts:322`); `require` is a `ReferenceError` | Bundle MIT libraries at build time into guest string constants (like chai via `scripts/build-sandbox-libs.mjs`), implement `CryptoJS`/`uuid`/`Buffer` facades over a new `host.crypto` bridge (node:crypto, zero dep). cheerio deferred (very large) | H | L | MISSING -> **WP-C** |
| `pm.require()` (Postman Package Library) | Yes (cloud packages) | Throws | - | - | - | EXCLUDED (packages are fetched from the Postman cloud); `require` of bundled libs covers the local need |
| `pm.vault.get/set/unset` | Yes (local vault, cloud-synced optional) | None; secret variables are the equivalent | `pm.vault` alias over secret environment variables (read-only) | L | S | PARTIAL -> **WP-C** |
| `pm.visualizer.set(template, data)` | Yes (Handlebars) | Throws | See 1.4 | M | M | MISSING -> **WP-C** |
| Script editor: `pm` typings, snippets | Yes | `workspace/scriptSupport.ts` (minimal typings, 14 snippets) | Extend typings to match the real surface, Postman's full snippet list | M | S | PARTIAL -> **WP-C** |
| Postbot script generation | Cloud AI | - | - | - | - | EXCLUDED |

### 1.9 Console

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Script `console.*` output with level/text filter, copy, clear | Yes | `bottom/ConsolePanel.tsx` | - | - | - | HAVE |
| Network log per request (method, URL, status, time; expandable request/response headers and bodies; redirects; `pm.sendRequest` calls; OAuth token calls) | Yes | **Missing**: the console only shows script logs; the per-request Timeline tab shows the final request/response but is not a chronological log | Push a redacted network entry per execution (renderer side, from `ExecutionResult`), plus `pm.sendRequest` entries from the guest, plus runner items | M | S | PARTIAL -> **WP-E** (UI) + **WP-C** (sendRequest entries) |
| Show timestamps, raw log, errors | Yes | Timestamps yes | - | - | - | HAVE |

### 1.10 Runner and CLI

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Collection/folder runner: iterations, delay, data file (CSV/JSON), stop on failure, `setNextRequest`, live results, run history, re-run | Yes | `packages/testing/runner.ts`, `history-runner.ts`, `RunnerModal/RunnerPanel` | Local-variable reset heuristic in `history-runner.ts:150` resets locals whenever request #0 executes, including a `setNextRequest` jump back to it | - | S | HAVE (minor bug) -> **WP-D** |
| Select / reorder requests for a run | Yes | No | See 1.7 | M | M | PARTIAL -> **WP-D** |
| Keep responses in run results | Yes | Status/tests/error only | Opt-in capture of redacted response head (size-capped) | M | S | MISSING -> **WP-D** |
| Export run results: JSON/CSV (UI), JUnit (library only) | Yes (JSON) | JSON/CSV in `RunnerPanel`; `toJUnitXml` exists in `@aegis/testing` but is not reachable from the UI; no HTML report | Expose JUnit + simple HTML | M | S | PARTIAL -> **WP-D** |
| Newman / Postman CLI (`run collection.json -e env.json -d data.csv --reporters cli,junit,json`) | Yes | None (README roadmap). `@aegis/app` is Electron-free, which makes this feasible | New `apps/cli` using `@aegis/app` + `@aegis/postman` on an in-memory SQLite DB and an in-memory secret cipher (inputs are plaintext files anyway); honours `AEGIS_POLICY_FILE`; exit code = failed tests | H | M | MISSING -> **WP-D** |
| Scheduled runs | Cloud | None | Local scheduling only works while the app runs; CI via the CLI is the enterprise answer | L | - | EXCLUDED (cloud); CLI covers it |
| Performance / load test (virtual users) | Yes (local, v10.21+) | None | Parallel executor loop, metrics | M | L | DEFER |

### 1.11 Mock servers, documentation, monitors, flows, AI

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Mock servers (cloud) | Yes | None | - | - | - | EXCLUDED as cloud. A **local** mock server (loopback `node:http`, serves saved examples, zero dep) is a feasible DEFER item once examples have a UI |
| Published API documentation (cloud) | Yes | None | - | - | - | EXCLUDED as cloud. Local docs view + static HTML export is DEFER (needs Markdown renderer) |
| Monitors | Cloud | - | - | - | - | EXCLUDED; use the CLI in CI |
| Flows | Cloud | - | - | - | - | EXCLUDED |
| Postbot / AI assistant | Cloud AI | - | - | - | - | EXCLUDED (sends collection data to a vendor model; contradicts local-only) |
| In-app notifications, Postman Academy, "What's new" | Cloud | - | - | - | - | EXCLUDED |

### 1.12 Workspaces, team, versioning

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Personal / team / partner / public workspaces with sync | Cloud | Local workspaces (`workspaces.*`), export/backup for sharing | - | - | - | EXCLUDED (cloud sync); local sharing via files is the design |
| Version control (fork, merge, diff, PR, tags) | Cloud | None | A local "compare collection with file" diff is feasible (`compareCollectionBundles` already exists in `postman/semantic.ts`) | L | M | DEFER |
| Roles / SSO / SCIM | Cloud | Enterprise policy file (`SECURITY.md`) | - | - | - | EXCLUDED |
| Postman Vault (local encrypted secrets, `vault:` prefix) | Yes | Secret variables in OS keyring (`SecretVault`), masked UI, audited reveal | Equivalent | - | - | HAVE |

### 1.13 Certificates, proxy, capture

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| CA certificates, client certificates per host (PEM) | Yes | `CertificatesSection.tsx`, `certificates.add` (PEM only) | **PFX/PKCS#12 not accepted by the API** although `schema.ts` has `pfxRef` and `TlsOptions.clientCertificate.pfxBase64` is implemented in `client.ts` | M | S | PARTIAL -> **WP-B** |
| Proxy: system, manual HTTP/HTTPS, auth, bypass list | Yes | `network.ts`, `proxy.ts` | SOCKS not supported (would need a dependency); not tested against a real proxy (README) | L | - | HAVE (🟡) |
| Postman Interceptor (browser extension) | Yes | None | Requires a local WebSocket listener for the extension; HTTPS capture needs a browser extension anyway | L | L | DEFER |
| Built-in capture proxy (HTTP + HTTPS MITM) | Yes | None | HTTP-only capture is zero-dep; HTTPS MITM needs certificate minting (Node cannot create X.509 certs without a dependency such as `node-forge`) | L | L | DEFER |

### 1.14 Shell: themes, shortcuts, layout, search

| Feature | Postman | Aegis today | Gap | Value | Effort | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Dark / light / system theme | Yes | `GeneralSection.tsx` | - | - | - | HAVE |
| Two-pane (side-by-side) vs single-pane (stacked) request/response layout | Yes | Stacked only (`RequestWorkbench.tsx` vertical splitter) | Layout toggle persisted in `appearance.layout` | M | S | MISSING -> **WP-E** |
| Keyboard shortcuts (send, save, new tab, close, search, console, next/prev tab, find & replace) | Yes | `lib/shortcuts.ts` (7 shortcuts) | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+Shift+F; the Ctrl+W bug | M | S | PARTIAL -> **WP-E** |
| Global search / command palette | Yes | `SearchModal.tsx` (Ctrl+K) | - | - | - | HAVE |
| Editor font size / zoom | Yes | Menu zoom | Fine | - | - | HAVE |
| Sidebar collapse, resizable panes | Yes | `useSplitter` | - | - | - | HAVE |
| Cookie manager: list, reveal, delete, clear | Yes + **add/edit** | `CookiesSection.tsx`; API has no `cookies.add/update` | Add/edit dialog (value goes to secret storage) | M | S | PARTIAL -> **WP-E** |
| Settings sync across devices | Cloud | - | - | - | - | EXCLUDED |
| Auto-update / telemetry | Yes | None by design | - | - | - | EXCLUDED (design principle) |

---

## 2. Recommended backlog (top 20, ordered by value/effort)

| # | Item | Value | Effort | WP | New dependency |
| --- | --- | --- | --- | --- | --- |
| 1 | Code snippet generation ("Code" panel) for cURL, HTTP/1.1 raw, JS fetch, Node (fetch/undici), Python requests, PowerShell, Go, Java HttpClient, C# HttpClient, PHP curl, Ruby, HTTPie | H | M | A | none |
| 2 | cURL paste into the URL bar + "Import cURL" dialog | H | S | A | none |
| 3 | Bulk edit for Params / Headers / urlencoded / form-data text fields | H | S | A | none |
| 4 | Variable autocomplete + hover (scope, masked value, unresolved highlight) in URL, key/value tables, body editor, auth fields | H | M | A | none |
| 5 | Examples: "Save response as example", Examples tab (view/edit/delete), example count badge | H | M | E | none |
| 6 | Script libraries: `require()` + globals for lodash, moment, CryptoJS-compatible facade, uuid, ajv (full `jsonSchema`), tv4, xml2Json, `Buffer`, `csv-parse/lib/sync` | H | L | C | devDependencies only (bundled): `lodash` MIT, `moment` MIT, `ajv` MIT, `tv4` MIT, `fast-xml-parser` MIT (or in-house XML->JSON) |
| 7 | OpenAPI 3.x / Swagger 2.0 import (JSON first, YAML second) | H | L | D | `yaml` (ISC, pure JS) for YAML files |
| 8 | CLI runner `aegis-cli run` with cli/json/junit reporters, data files, env/globals, policy file | H | M | D | none (`node:util.parseArgs`) |
| 9 | HTTP/2 (`allowH2`), real `httpVersion`, DNS/TCP/TLS timings, TLS cipher/peer certificate in Timeline | M | M | B | none |
| 10 | Request settings parity: disable cookie jar, encode URL off, redirect options, per-request strict SSL (policy-gated), HTTP version, max response size field, working directory for relative file paths | M | M | B | none |
| 11 | `pm.cookies.jar()` writes (set/unset/clear) + Cookie manager add/edit | M | M | C (+E UI) | none |
| 12 | Find & replace across a collection (preview, transactional, audited) | M | M | E | none |
| 13 | Console network log (one entry per send, `pm.sendRequest`, runner items; expandable redacted headers) | M | S | E (+C) | none |
| 14 | Shell: two-pane layout toggle, tab restore after restart, Ctrl+W confirm fix, Ctrl+Tab, Ctrl+Shift+F | M | S | E | none |
| 15 | More importers: HAR 1.2, Insomnia v4, Postman v1, Postman data dump, Aegis workspace file (bug fix) | M | M | D | none |
| 16 | JSONPath filter box in the Pretty view | M | S | E | none |
| 17 | `pm.visualizer` (Handlebars rendered in the sandbox; static HTML in a sandboxed iframe) + Visualize tab | M | M | C (+E tab) | devDependency `handlebars` MIT (bundled) |
| 18 | Auth: Digest, Hawk, EdgeGrid, ASAP, OAuth1 RSA-SHA1, JWT ES*/PS*, OAuth2 device code; fix token-flow variable scope | M | M | B | none |
| 19 | GraphQL body mode (query + variables editors, `Content-Type: application/json`) | H | M | A | none |
| 20 | Runner: select/reorder requests, keep (redacted) responses, JUnit/HTML export in the UI, local-variable reset fix | M | M | D | none |

Deferred (after this backlog, roughly in order): WebSocket + SSE clients (L, design: new `ProtocolClient`, `protocol:message` events, a "Messages" pane); local mock server from examples (L); Markdown docs view + static HTML docs export (M); NTLM (L); GraphQL introspection/explorer (L); collection diff (M); performance runs (L); HTTP capture proxy (L); gRPC/MQTT/RAML/WSDL (XL/L, need dependencies).

---

## 3. Work packages (build in parallel, disjoint file ownership)

### Shared files: append-only protocol

These files are touched by more than one package. Rules: **additive edits only** (new union members, new optional
fields, new object keys, new channels appended to `API_CHANNELS`), one small commit per edit, rebase daily. The existing
guards catch mistakes: `assertSchemasComplete()` (every channel needs a zod schema) and `tests/unit/docs.test.ts`
(every channel must appear in `API.md`).

| Shared file | Who adds what |
| --- | --- |
| `packages/core/src/api.ts` | A: `execution.resolvePreview` (optional), B: `ResponseView.tls/timings` fields, C: `ExecutionResult.visualizer`, D: `ImportPreview.kind` members, `RunnerOptions.requestIds/keepResponses`, E: `cookies.add/update`, `collections.findReplace`, `folders.duplicate`, `requests.move.collectionId` |
| `apps/desktop/main/ipc-schemas.ts` | one schema per new channel, owned by the same WP as the channel |
| `API.md` | one table row per new channel |
| `packages/core/src/model.ts` | A: `BodyMode 'graphql'` + `RequestBody.graphql`; B: new `RequestSettings` keys |
| `packages/core/src/settings.ts` | B: `network.*`, `files.workingDirectory`, `hosts`; E: `appearance.layout` |
| `packages/core/src/scripting.ts` | C only (`ScriptHost.cookieJar`, `ScriptHost.crypto`, `ScriptInfo.environmentName`, `ScriptRunResult.visualizer`, console entries) |
| `packages/app/src/executor.ts` | **owned by B**; C may add two lines to the `host` object (`cookieJar`, `crypto`) and `info.environmentName`; A may add nothing (GraphQL is handled in `prepare.ts`) |
| `packages/app/src/app.ts` | nobody (handlers are derived from the `api` object); only if a new namespace is added |
| `apps/desktop/renderer/src/store/ui.ts`, `modals/ModalHost.tsx` | A: `'code'`, `'curl-import'`; E: `'find-replace'`, `'cookie-edit'` |
| `apps/desktop/renderer/src/store/app.ts` | **owned by E**; A/C/D add nothing (use local component state or `useUi`) |
| `tsconfig.json` paths, `vitest.config.ts`, `package.json` scripts/devDependencies | A: `@aegis/codegen`; C: sandbox lib devDependencies; D: `apps/cli` build script, `yaml` |

### WP-A: Request authoring and code generation (items 1, 2, 3, 4, 19)

Owns
- New package `packages/codegen/` (`src/curl-parse.ts`, `src/generators/*.ts`, `src/index.ts`, `package.json`): pure TS, no Node APIs, usable by the renderer and a future CLI.
- Renderer: `workspace/UrlBar.tsx`, `workspace/ParamsHeadersTabs.tsx`, `workspace/BodyTab.tsx`, `workspace/FormDataTable.tsx`, new `workspace/GraphQLBody.tsx`, new `components/BulkEditor.tsx`, new `components/VariableInput.tsx`, new `lib/bulk-edit.ts`, new `lib/variable-hints.ts`, new `lib/curl-paste.ts`, new `modals/CodeSnippetModal.tsx`, new `modals/CurlImportModal.tsx`, `styles/workbench.css` (new classes only).
- Small additive edits: `packages/http-client/src/prepare.ts` `toBodySpec` gets `case 'graphql'` (coordinate with B), `packages/app/src/executor-support.ts` `draftToSnapshot` maps `graphql` to a raw JSON snapshot for scripts, `ipc-schemas.ts` body schema.
- Tests: `tests/unit/codegen-curl.test.ts`, `tests/unit/codegen-generators.test.ts`, `tests/unit/ui-bulk-edit.test.ts`, `tests/unit/ui-variable-hints.test.ts`.

Design notes
- Variable hints: the renderer fetches `api.variables.get` for globals, the active environment, the tab's collection and folder chain (all existing channels) and caches them per workspace; secrets are `secretref:` values and are shown as masked. Precedence display reuses `VARIABLE_PRECEDENCE` from `@aegis/variables` (browser-safe import of the constant only).
- Code generation never reveals secrets by default: variables with `isSecret` or `secretref:` values stay as `{{name}}`; auth is rendered from the draft (Basic/Bearer/API key) with placeholders. A "Reveal secrets in snippet" toggle calls `variables.revealSecret` (already audited) and is disabled when `policy.allowSecretExport` is false. OAuth2/AWS/JWT signatures are not generated (snippet shows the header with a placeholder and a note); "Copy as sent" uses the last `ExecutionResult.request` (already redacted).
- cURL parser handles `-X`, `-H`, `-d/--data/--data-raw/--data-urlencoded/--data-binary @file` (file refs are rejected like imported paths), `-F`, `-u`, `--url`, `-k` (maps to a warning, never disables TLS), `-L`, `--compressed`, `-b`, quotes and line continuations; everything else becomes a warning.
- GraphQL: `body.mode = 'graphql'`, `body.graphql = { query, variables, operationName? }`; sent as `application/json` `{query, variables, operationName}`; Postman import can later map `graphql` bodies natively (WP-D).

Acceptance
- Typing `{{` in the URL bar, any key/value cell, the body editor or an auth field offers matching variables with scope badges; hovering a `{{name}}` shows scope and value (masked for secrets); unresolved names are underlined before sending.
- "Bulk Edit" on Params/Headers/urlencoded/form-data switches to a text area (`key:value`, `//` prefix = disabled) and back without losing descriptions of unchanged rows.
- Pasting a `curl ...` command into the URL bar offers "Import cURL" and fills method, URL, params, headers, auth and body; File -> Import -> cURL does the same from a dialog.
- "Code" button on the request opens a modal with language picker, generated snippet, copy button; secrets are placeholders unless revealed (audited, policy-gated).
- Body mode "GraphQL" with query and variables editors sends a JSON POST; round-trips through save/load.

Tests
- Unit: cURL parser table test (30+ commands incl. Windows `^` continuations and `$'...'` quoting), each generator against golden snippets, bulk-edit parse/serialise round-trip, variable-hint resolution/precedence, GraphQL `toBodySpec`.
- Integration: send a GraphQL request against the test HTTP server (`tests/helpers/http-server.ts`) and assert the JSON body.
- E2E (Playwright): paste cURL -> request populated; open Code modal -> snippet contains the URL.

### WP-B: HTTP runtime, request settings and authentication (items 9, 10, 18 + PFX, OAuth scope fix)

Owns
- `packages/http-client/**` (connector wrapper with timings/ALPN/TLS info, `allowH2`, redirect options, encode-URL toggle, hosts override via `connect.lookup`), `packages/app/src/executor.ts`, `packages/app/src/executor-support.ts`, `packages/app/src/network.ts`, `packages/app/src/services/core-services.ts` **`tools.oauth2GetToken` and `certificates.add` handlers only**.
- `packages/authentication/**` (digest with 401 round-trip hook in `AuthContext`, hawk, edgegrid, asap, OAuth1 RSA-SHA1, JWT ES*/PS*, OAuth2 device code).
- `packages/core/src/http.ts` (additive: `ResponseTimings.dnsMs/connectMs/tlsMs`, `HttpResponse.tls`, `HttpRequestSpec.httpVersion/encodeUrl/redirect options/disableCookies/hosts`), `packages/core/src/model.ts` `RequestSettings` additions, `packages/core/src/settings.ts` `network.httpVersion`, `files.workingDirectory`, `network.hosts`.
- Renderer: `workspace/MiscTabs.tsx` (SettingsTab), `modals/settings/NetworkSection.tsx`, `modals/settings/CertificatesSection.tsx` (PFX picker), `response/Timeline.tsx`, `components/AuthEditor.tsx`, `components/auth/*`.
- Postman mapping, two small additive edits: `packages/postman/src/import-parts.ts` (`protocolProfileBehavior` keys `disableCookies`, `followOriginalHttpMethod`, `followAuthorizationHeader`, `removeRefererHeaderOnRedirect`, `disableUrlEncoding`, `disableBodyPruning`) and `packages/postman/src/export-collection.ts`; plus the matching rows in `docs/postman-compatibility/compatibility.md` (coordinate with D who owns the file: send the rows to D).
- Tests: `tests/integration/http-client.test.ts`, `tests/unit/authentication.test.ts`, `tests/security/security.test.ts` (policy rows).

Security / policy
- Per-request `verifyTls=false` is honoured only when `policy.allowInsecureTls` is true; the UI shows "enforced" otherwise; every such send keeps the existing warning note. `followAuthorizationHeader` defaults to false and shows a warning note in the Timeline when on. Hosts overrides are listed in the Timeline ("resolved via hosts override") and can be disabled by a new policy key `allowHostOverrides` (default true; document in SECURITY.md). Working directory is the only root allowed for relative paths (`assertSafeFilePath({ allowedRoots })`). PFX passphrases go to the vault like PEM keys. Digest/Hawk secrets join `secretValues` for redaction.

Acceptance
- A request against an HTTP/2 server shows `HTTP/2` in the Timeline; HTTP/1.1 servers still work; per-request "HTTP version" can force 1.1.
- Timeline shows DNS / connect / TLS / TTFB / download bars and TLS protocol, cipher and peer certificate subject/issuer/expiry.
- Request Settings tab exposes: disable cookie jar, encode URL, follow original method, follow Authorization header, remove Referer, max response size, strict SSL (enforced badge when policy forbids), HTTP version; values survive save/export/import as `protocolProfileBehavior`.
- Settings -> General has a Working directory; imported form-data files under it upload without re-picking.
- Client certificates can be added as PFX + passphrase.
- Digest/Hawk/EdgeGrid/ASAP requests authenticate against the test server; the Postman kitchen-sink fixture's digest request executes instead of "unsupported".
- "Get new access token" resolves `{{clientId}}` defined as a collection variable.

Tests
- Integration against `tests/helpers/http-server.ts` extended with an HTTP/2 (`node:http2`, self-signed) listener, a digest-challenge route, a redirect route asserting Authorization/Referer behaviour, cookie-jar-disabled route, hosts override to `127.0.0.1`.
- Unit vectors: Hawk (RFC examples), EdgeGrid (Akamai docs vector), ASAP token shape, JWT ES256 round-trip verify with `node:crypto`.
- Security: policy forbids per-request insecure TLS; hosts override disabled by policy; relative path outside the working directory rejected.

### WP-C: Scripting parity (items 6, 11-engine, 17-engine + small pm fixes)

Owns
- `packages/scripting/**` (guest sources, `bridge.ts`, `sandbox.ts`, `prelude.ts`, `generated/*`), `scripts/build-sandbox-libs.mjs`, `packages/core/src/scripting.ts`, `apps/desktop/renderer/src/workspace/scriptSupport.ts`, `docs/features/scripting.md`.
- Small additive edits in `packages/app/src/executor.ts`: `host.cookieJar`, `host.crypto`, `info.environmentName`, and `ExecutionResult.visualizer` passthrough (coordinate with B).
- Tests: `tests/unit/scripting-pm.test.ts`, `tests/unit/scripting-libs.test.ts` (new), `tests/unit/scripting-sendrequest.test.ts`, `tests/security/script-sandbox.test.ts`.

Design notes
- Libraries are bundled with esbuild into string constants exactly like chai (`generated/libs-bundle.ts`), evaluated lazily on first `require()` to keep script start-up fast; they are devDependencies only, so the runtime dependency list in `SECURITY.md` does not grow. `require()` accepts only the allow-list and throws a clear error otherwise; `pm.require()` stays unsupported (cloud packages).
- `CryptoJS` facade: `MD5/SHA1/SHA224/SHA256/SHA384/SHA512/SHA3/HmacSHA*`, `AES.encrypt/decrypt` (CBC/PKCS7, passphrase KDF `EVP_BytesToKey` as CryptoJS does), `enc.Base64/Hex/Utf8/Latin1`, `lib.WordArray.random`, implemented over a new host function `host.crypto(opJson)` backed by `node:crypto`. Inputs are size-capped (1 MiB) and the call counter is bounded like `pm.sendRequest`. `uuid` (v1/v4/v5) and `Buffer` (subset: from/toString/concat/byteLength/base64/hex) use the same bridge.
- `pm.cookies.jar()`: `set(url, cookie)`, `unset(url, name)`, `clear(url)` go through `host.cookieJar` -> `ScriptHost.cookieJar` -> `CookieJarService` (workspace jar); `httpOnly` cookies cannot be read or overwritten by scripts; every write is audited (`SCRIPT_COOKIE_WRITE`) and reported in `ExecutionResult.warnings` as "cookies changed by script".
- `pm.visualizer.set(template, data)`: Handlebars (bundled) renders inside QuickJS; the HTML string (size-capped 2 MiB) is sanitised with `buildPreviewDocument` and returned in `ScriptRunResult.visualizer`. No scripts execute (documented); CSS inline is allowed.
- `pm.environment.name` returns the real name; `pm.request.auth` exposes `{type, params}` with secret params masked; `pm.sendRequest` logs `-> METHOD url` / `<- status time` console entries and accepts `auth: {type:'basic'|'bearer'|'apikey', ...}`.

Acceptance
- Postman scripts using `_ .get`, `moment().format()`, `CryptoJS.HmacSHA256(...).toString()`, `require('uuid').v4()`, `xml2Json(pm.response.text())`, `pm.response.to.have.jsonSchema(schemaWithRef)` run unchanged.
- `pm.cookies.jar().set(...)` persists a cookie visible in Settings -> Cookies and sent on the next request; `httpOnly` cookies stay invisible.
- `pm.visualizer.set` output appears in the Visualize tab (rendered by WP-E) for the next response.
- The console shows `pm.sendRequest` calls with status and duration.
- Typings in the script editor cover the whole supported surface; snippet list matches Postman's.

Tests
- Unit: each library through the sandbox (hash vectors from RFCs, lodash/moment smoke, ajv `$ref`), `require` allow-list, size caps, call limits, redaction of secrets passing through `CryptoJS` results (a secret hashed is fine, a secret logged is redacted).
- Security: `require('fs')`/`require('child_process')` throw; libraries cannot reach `host` (global allow-list test updated); visualizer output of `<script>` is stripped; cookie writes cannot set `httpOnly`; memory/time limits still hold with libraries loaded.

### WP-D: Import/export formats, CLI and runner (items 7, 8, 15, 20)

Owns
- `packages/postman/src/` new files `import-openapi.ts`, `import-swagger2.ts`, `import-har.ts`, `import-insomnia.ts`, `import-v1.ts`, `import-dump.ts`; `detect.ts`, `index.ts`, `packages/app/src/services/import-export.ts`, `apps/desktop/main/main.ts` (menu rows), renderer `modals/ImportModal.tsx`, `lib/import-helpers.ts`, `modals/RunnerModal.tsx`, `panels/RunnerPanel.tsx`, `lib/runner-helpers.ts`, `store/runner.ts`, `packages/app/src/services/history-runner.ts`, `packages/testing/**` (new `reporters.ts`: cli/json/junit/html), new `apps/cli/**` + `scripts/build-cli.mjs`, `docs/postman-compatibility/compatibility.md`, `tests/fixtures/{openapi,har,insomnia,postman-v1,dump}/**`.
- Tests: `tests/unit/postman-*.test.ts` (new per format), `tests/integration/postman-roundtrip.test.ts`, new `tests/integration/cli.test.ts`, `tests/unit/testing-runner.test.ts`.

Design notes
- All importers produce the existing `CollectionBundle`/`EnvironmentBundle` so storage, preview, warnings and rollback are reused unchanged; `previewContent` grows a `kind: 'auto'` that uses `detect.ts`.
- OpenAPI: one folder per tag (or path prefix), request per operation, `servers[0]` -> collection variable `baseUrl`, path params -> `:param` + path variables, query/header params -> disabled rows with descriptions, `requestBody` example/schema -> generated JSON example (depth-limited), responses -> examples, `securitySchemes` -> collection auth (http basic/bearer, apiKey, oauth2 flows). `$ref` resolution is local-document only (no network fetch; external refs become warnings).
- YAML: JSON ships first; YAML requires the `yaml` package (ISC, pure JS, no native code). If the dependency is refused, the importer rejects `.yaml` with a clear message instead of a half-implemented parser.
- CLI (`apps/cli`, bundled with esbuild to `dist/cli/aegis-cli.cjs`): `aegis-cli run <collection.json> [-e env.json] [-g globals.json] [-d data.csv|json] [--folder name] [-n iterations] [--delay ms] [--bail] [--timeout ms] [--insecure (only if policy allows)] [--reporters cli,json,junit,html] [--reporter-json-export f] [--policy file]`. It builds `createApp()` with `Storage({ dbPath: ':memory:' })`, an in-memory `SecretCipher`, a `PlatformBridge` without dialogs, loads the files through the importers, runs `runCollection`, prints the report, exits non-zero on failures. No network other than the collection's own requests; OAuth interactive flows are reported as unsupported in CLI mode.
- Runner UX: request checklist with drag order in `RunnerModal` -> `RunnerOptions.requestIds` (ordered); `keepResponses` stores the redacted first 64 KiB of each response in `collection_run_items.response_json` (new nullable column + migration under `database/migrations`); JUnit/HTML download buttons.

Acceptance
- File -> Import accepts OpenAPI 3.x (JSON/YAML), Swagger 2.0, HAR, Insomnia v4, Postman v1, Postman data dump and `*.aegis-workspace.json`, each with preview + warnings + rollback; the "OpenAPI… not available" menu stub is gone.
- `npx aegis-cli run tests/fixtures/postman/kitchen-sink.json -e env.json --reporters cli,junit` prints `✓/✗` lines and writes JUnit; exit code 1 when a test fails; respects `AEGIS_POLICY_FILE` (blocked hosts, production block).
- Runner lets the user pick and order requests, keeps responses when asked, exports JUnit/HTML.

Tests
- Unit: fixture-driven mapping tests per format (at least the Petstore OpenAPI 3.0 + 3.1, a Swagger 2.0 file, a browser HAR, an Insomnia export, a v1 collection, a dump), security tests reuse `postman-security.test.ts` patterns (size, depth, prototype pollution, file refs).
- Integration: CLI spawned as a child process against the local test server; runner with `requestIds` ordering and `keepResponses` redaction (`Authorization` never stored).

### WP-E: Response tools, examples, collection and shell UX (items 5, 12, 13, 14, 16 + cookie manager, folder duplicate, cross-collection move, docs render, Visualize tab)

Owns
- Renderer: `response/**` except `Timeline.tsx` (new `response/VisualizeView.tsx`, `response/ExamplesTab.tsx`, JSONPath filter in `BodyViews.tsx`/`ResponseViewer.tsx`), `workspace/RequestPane.tsx`, `workspace/RequestWorkbench.tsx`, `workspace/TabsBar.tsx`, `bottom/ConsolePanel.tsx`, `store/app.ts`, `lib/shortcuts.ts`, new `lib/jsonpath.ts`, new `lib/tab-persistence.ts`, new `lib/network-log.ts`, new `lib/markdown.ts` (small safe subset renderer, output passed through `buildPreviewDocument`), `sidebar/**`, `lib/collectionTree.ts`, `modals/settings/CookiesSection.tsx`, `modals/settings/GeneralSection.tsx`, new `modals/FindReplaceModal.tsx`, new `modals/CookieEditModal.tsx`, `modals/CollectionEditModal.tsx` (docs preview).
- Main/app: `packages/app/src/services/core-services.ts` **`cookies`, `collections`, `folders`, `requests` handlers only**, new `packages/app/src/services/find-replace.ts`, `packages/storage/src/repositories/collections.ts` (`duplicateFolder`, `moveToCollection`, `findReplace`), `packages/storage/src/repositories/misc.ts` cookies add/update.
- Tests: `tests/unit/ui-*.test.ts` (new `ui-jsonpath`, `ui-network-log`, `ui-tab-persistence`, `ui-markdown`), `tests/integration/storage-repositories.test.ts`, `tests/security/security.test.ts` (find & replace never touches `secretref:`; markdown XSS payloads).

Security / policy
- Tab persistence stores request ids and non-secret draft fields only; `auth.params` secret keys are stripped before writing to `localStorage` (secrets in memory only). Find & replace runs in one SQLite transaction, skips `secretref:` values and secret variables, is audited (`FIND_REPLACE` with counts, never values), and shows a preview count first. Cookie add/edit stores values via the vault; `httpOnly` cookies are editable only in the manager (not by scripts). Markdown rendering is sanitised and shown in the existing sandboxed iframe; no remote images (`img-src data:` only).

Acceptance
- "Save as example" on a response creates a named example; the request's Examples tab lists, edits (name/status/headers/body) and deletes examples; export contains them (already supported by `@aegis/postman`).
- Pretty view has a filter box: `$.items[*].id` narrows the display; invalid expressions show inline errors.
- Visualize tab renders `result.visualizer` HTML (from WP-C) in a sandboxed iframe; absent -> hint.
- Console shows network entries (method, URL, status, duration, size) for every send, with expandable redacted request/response headers; filters still work; runner items appear too.
- Layout toggle (stacked / side-by-side) persisted; tabs restored after restart; Ctrl+W asks when dirty; Ctrl+Tab cycles tabs; Ctrl+Shift+F opens Find & Replace.
- Find & replace across a collection with scope checkboxes (URL, params, headers, body, scripts, descriptions, variables) and a "N matches in M requests" preview.
- Folders can be duplicated; requests/folders can be dragged to another collection (tree) and moved via context menu "Move to…".
- Cookies manager can add and edit cookies.
- Request/collection descriptions render as Markdown in a read-only preview beside the editor.

Tests
- Unit: JSONPath subset (table of expressions), markdown subset + sanitiser (XSS corpus from `security.test.ts`), tab persistence strips secrets, network-log entry builder redacts `Authorization`, `planNodeMove` across collections.
- Integration: repository `duplicateFolder` (deep copy incl. scripts/auth refs re-vaulted), `moveToCollection` (cascade of `collectionId`), `findReplace` (transaction, counts, secret skip).
- E2E: save example -> Examples tab shows it; layout toggle persists across reload.

### Suggested sequencing inside the parallel plan

1. Day 1: each WP lands its additive type edits to the shared files (api/ipc-schemas/model/settings/scripting) so interfaces are frozen early; `npm run typecheck` + `assertSchemasComplete` + `docs.test.ts` green.
2. WP-C publishes `ScriptRunResult.visualizer` before WP-E builds the tab; WP-A publishes `BodyMode 'graphql'` before WP-B touches `prepare.ts` again (or B adds the `case` on A's behalf, both are one-liners).
3. WP-B's `compatibility.md` rows are handed to WP-D (file owner) as a patch.

---

## 4. Findings: bugs, inconsistencies and doc overclaims

Found while reading the code for this analysis (none were fixed; all are READ-ONLY observations).

1. **Workspace export cannot be imported.** `workspaces.export` writes `{ format: 'aegis-workspace', ... }` (`packages/app/src/services/core-services.ts:74`), but `import-export.ts` `preview()` accepts only `postman-collection | postman-environment | backup` and `validateBackup()` rejects any format other than `aegis-backup`. `ImportPreview.kind: 'aegis-workspace'` (`core/api.ts:166`) and the branch in `ImportModal.tsx:140` / `lib/import-helpers.ts:45` are dead code. README ("Workspaces can be … exported") implies a round trip that does not exist.
2. **`runScripts` is accepted and ignored.** `ExecuteRequestInput.runScripts` is documented in `core/api.ts` and validated in `ipc-schemas.ts` but `RequestExecutor.execute` never reads it.
3. **`tools.oauth2GetToken` ignores `requestId/collectionId/folderId`** (`core-services.ts:266`): the interactive token flow resolves `{{vars}}` from the environment and globals only, so collection/folder variables such as `{{clientId}}` work at send time (executor uses all scopes) but not when clicking "Get new access token". The `AbortController` created there is never wired to a cancel either.
4. **`httpVersion` is hard-coded** to `'HTTP/1.1'` (`packages/http-client/src/client.ts:188`) and shown in the Timeline as if measured.
5. **Per-request `verifyTls` is stored but never applied.** `RequestSettings.verifyTls` (imported from Postman `strictSSL`) is not read by `buildHttpRequestSpec` (`prepare.ts`); `compatibility.md` lists `strictSSL` as "Supported" with runtime "n/a (verified in app tests)", which overstates it. The request Settings tab correctly says it cannot be changed per request; the doc row should say "stored, not applied".
6. **Examples have no UI.** README's compatibility summary says "Examples ✅ ✅ documentation only", but examples are visible nowhere except the import statistics; there is no viewer, editor or "save as example".
7. **Ctrl+W bypasses the unsaved-changes dialog.** `lib/shortcuts.ts` calls `closeTab` directly while `TabsBar.tsx` uses `requestCloseTab` (confirm when dirty). README lists "confirmation dialogs ✅".
8. **Imported relative file paths can never be sent.** `checkImportedFilePath` keeps only relative `src` values, but `assertSafeFilePath` (used by `http-client/body.ts`) rejects relative paths unless `allowedRoots` is given, and nothing passes roots. Postman solves this with a working-directory setting.
9. **Folders cannot be duplicated and nodes cannot move across collections** although README says "Create, rename, delete, duplicate, move (drag & drop)". `duplicateEntity` only handles collections/requests; `planNodeMove` returns `null` for a different `collectionId`.
10. **Runner local-variable reset heuristic** (`history-runner.ts:150`): locals are cleared whenever `requests[0]` executes after the first request, including when `pm.execution.setNextRequest` jumps back to the first request inside the same iteration.
11. **Backups include at most 500 history rows per workspace** (`import-export.ts:279`, `limit: 500`), which README/SECURITY do not mention.
12. **`pm.environment.name` is the literal `'environment'`** (`guest/pm.ts:230`) and is marked ✅ in `docs/features/scripting.md`; Postman returns the environment's name. Scripts that branch on it behave differently.
13. **`ProtocolRegistry` is dead code.** ARCHITECTURE.md and CONTRIBUTING.md present it as the extension point ("register it in the ProtocolRegistry"), but nothing instantiates it; `RequestExecutor` holds an `HttpProtocolClient` directly. Adding WebSocket/GraphQL clients will need an executor dispatch that does not exist yet.
14. **Console is script-only.** README's "console ✅" row is true for `console.log`, but the Postman console's defining feature, the network log, is absent.
15. **PFX client certificates are implemented in the engine but unreachable**: `TlsOptions.clientCertificate.pfxBase64` and `schema.certificates.pfxRef` exist; `certificates.add` only accepts PEM.
16. Minor: `MethodLabel` truncates custom methods longer than 5 characters to 4 (`ui.tsx:289`), e.g. `PROPFIND` -> `PROP`; `HistoryPanel` method filter lists 7 methods although TRACE/CONNECT/custom are supported.
