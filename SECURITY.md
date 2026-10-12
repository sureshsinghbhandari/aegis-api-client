# Security

This document describes the security model of Aegis API Client as **implemented and tested**. Anything not listed
here is not claimed.

## Reporting a vulnerability

Report suspected vulnerabilities privately to your organization's security contact (or the repository owner) rather
than opening a public issue. Include the version, steps to reproduce and impact.

## Threat model (summary)

| Threat | Mitigation | Tests |
| --- | --- | --- |
| Malicious API response (HTML/JS) running in the app | Responses are text; HTML preview only in `<iframe sandbox="">` + `default-src 'none'` CSP + sanitiser; renderer CSP forbids inline/remote scripts | `tests/security/security.test.ts` (XSS payloads) |
| Compromised/buggy renderer calling the backend | Sender-URL check, per-channel zod schemas, narrow preload API, no Node in renderer | IPC argument tests |
| Malicious user/collection script | QuickJS WASM sandbox, CPU/memory/stack limits, no host globals | `tests/security/script-sandbox.test.ts` (40 tests) |
| Malicious imported collection | Size/depth/item limits, prototype-pollution-safe copying, file-reference validation (no traversal/absolute/UNC), transactional import | `tests/unit/postman-security.test.ts` |
| Secret leakage (disk, logs, exports, history) | Secrets in OS-protected storage, redacted logs/audit/history, exports exclude secrets by default | acceptance + security tests |
| TLS downgrade | Verification on by default; disabling requires the user setting **and** enterprise policy; always surfaced as a warning | policy + TLS tests (self-signed cert) |
| Decompression bombs / huge responses | Size limit applies to the *decompressed* stream; large bodies spill to disk, never into the DOM | `tests/integration/http-client.test.ts` |
| SQL injection | Drizzle parameterised queries; LIKE wildcards escaped; no string-built SQL | SQL injection tests |
| Header/CRLF injection | Header names/values validated before sending | `assertValidHeader` |
| Credential leak on redirect | Authorization/Cookie dropped on cross-origin redirects; forwarding `Authorization` is an explicit per-request opt-in with a warning, and `Cookie`/`Proxy-Authorization` are never forwarded | HTTP tests |
| Active content in Markdown / Visualize / HTML preview | Markdown is rendered by an in-app safe subset (raw HTML shown literally, no remote images); Visualize output and Markdown go through the preview sanitiser into `<iframe sandbox="">` (no scripts, no network) | `tests/unit/ui-markdown.test.ts`, `tests/security/security.test.ts` |
| Path traversal via relative file paths in bodies | Relative paths resolve only inside the configured working directory; `..`, UNC and device paths are rejected | `tests/unit/http-runtime.test.ts` |
| Host override used to reach a blocked host | Overrides never bypass `blockedHosts`; never applied through a proxy; can be disabled by policy (`allowHostOverrides`) | `tests/security/security.test.ts` |
| Secret leakage through restored tabs | Tab persistence strips every secret auth parameter before writing to `localStorage` | `tests/unit/ui-tab-persistence.test.ts` |
| Malicious or oversized imported API description (OpenAPI/Swagger/HAR/Insomnia/YAML) | Importers perform no network or file access (external `$ref`, `externalValue` and external scripts are ignored with a warning); YAML uses the core schema only (no custom tags) with an alias-bomb guard and a 64 MiB cap; size/depth/item limits; prototype-pollution keys dropped; file references validated | `tests/unit/postman-openapi-security.test.ts`, `tests/unit/postman-security.test.ts` |
| Credentials recorded in an imported HAR file | Authorization/Cookie/API-key style values (also in JSON bodies) are replaced by empty secret `{{har_*}}` variables and never stored literally | `tests/unit/import-har.test.ts` |
| Script libraries or script cookie/visualizer APIs used to escape the sandbox or leak data | Libraries are build-time bundles evaluated inside QuickJS (no host access); cookie-jar writes cannot touch `HttpOnly` cookies and are audited; visualizer HTML is script-stripped, redacted, size-capped and shown only in a sandboxed iframe | `tests/security/script-sandbox.test.ts`, `tests/unit/scripting-libs.test.ts` |
| Secrets persisted with run results | "Keep responses" stores only a redacted first 64 KiB and never credential headers | `tests/integration/runner-options.test.ts` |
| Secret exposure or ReDoS through Find & Replace | Secret values and authorization parameters are never searched or written; regex is length-limited, nested quantifiers are rejected, a time budget applies (best effort, see limitations); audit stores counts only | `tests/security/find-replace.test.ts` |

## Secret storage

* Provider abstraction: `SecretStorageProvider` / `SyncSecretStorage` (`packages/security/src/secrets.ts`).
* Desktop implementation: Electron `safeStorage` → Windows DPAPI, macOS Keychain, Linux Secret Service (libsecret).
  If the OS keyring is unavailable (e.g. Linux `basic_text` backend) the app **refuses to store secrets** instead of
  silently storing them weakly, and the status bar says so.
* Stored encrypted: secret environment/collection/folder/global variable values, secret auth parameters (passwords,
  tokens, client secrets, API-key values, JWT secrets/private keys, OAuth tokens), cookie values, client-certificate
  keys and passphrases, PKCS#12 (PFX) bundles and their passphrases, the proxy password.
* Restored-tab drafts (`localStorage`, key `aegis.tabs`) never contain secrets; secret auth parameters are re-attached
  from the saved request on restore. Code snippets keep secrets as `{{placeholders}}` unless the user explicitly reveals
  them (audited, blocked when `allowSecretExport` is `false`).
* The UI only ever receives `secretref:` references. Revealing a value is an explicit action
  (`variables.revealSecret`), is restricted to `var:`/`auth:` references and is written to the audit log.
* Values that are only `{{variable}}` references are not secrets and are stored as-is.

## Exports and backups

* Postman collection/environment exports **exclude secrets by default**. Including them requires an explicit
  confirmation in the UI, is refused when policy sets `allowSecretExport: false`, and is audited (`EXPORT_SECRETS`).
* Limitation: without `includeSecrets`, only variables, auth parameters and auth inside saved examples are blanked.
  A literal `Authorization` header or token typed into a header/body is exported as written. Use variables.
* Backups never contain secrets unless a **passphrase** is supplied (and policy allows); then the whole file is
  AES-256-GCM encrypted (scrypt KDF). Restores never modify security/network settings.

## Logging, audit, telemetry

* Structured logs (`DEBUG/INFO/WARN/ERROR`) pass through redaction before any sink sees them
  (`Authorization`, `Cookie`, `Set-Cookie`, `password`, `client_secret`, `access_token`, `refresh_token`, `api_key`,
  `private_key`, plus user-defined patterns).
* Audit log (optional, default on) records: `IMPORT_COLLECTION`, `EXPORT_COLLECTION`, `CREATE_COLLECTION`,
  `DELETE_COLLECTION`, `EXECUTE_REQUEST`, `EXECUTE_SCRIPT`, `CHANGE_ENVIRONMENT`, `CHANGE_SECURITY_SETTING`,
  `DELETE_HISTORY`, `EXPORT_SECRETS`, `FIND_REPLACE` (target, scopes, flags, text lengths and counts only),
  `SCRIPT_COOKIE_WRITE` (cookies written by a script: cookie names only, never values), and backup/restore events —
  never secret values or the searched/replacement text.
* Stored run responses ("Keep responses" in the collection runner) are redacted, limited to the first 64 KiB, and never
  contain credential headers (`collection_run_items.response_json`). The option is off by default.
* The Console network log redacts `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key` and any
  header whose name contains `token`, `secret`, `password`, `credential` or `api-key`; bodies are not logged.
* **Local-only mode.** The application contains no analytics, telemetry, crash reporting, sync or auto-update code.
  The only network traffic is what the user sends (plus explicitly configured OAuth/proxy endpoints). The setting is
  displayed in the UI and can be enforced by policy (`enforceLocalOnly`).

## Enterprise policy

An administrator-controlled JSON file, loaded by one shared loader (`loadPolicyFromFiles` in `@aegis/security`, used by
the desktop app and by `aegis-cli`), searched in order: `AEGIS_POLICY_FILE`, then
`%ProgramData%\Aegis\policy.json` (Windows), `/Library/Application Support/Aegis/policy.json` (macOS),
`/etc/aegis/policy.json` (Linux), then `resources/policy.json` in the installed app. Unknown or wrongly typed keys are
ignored; missing keys take the restrictive defaults.

| Key | Default | Effect |
| --- | --- | --- |
| `allowInsecureTls` | `false` | Whether users may disable certificate validation |
| `requireProductionConfirmation` | `true` | Confirm before sending while a production environment is active |
| `blockProductionRequests` | `false` | Block such requests entirely |
| `enforceLocalOnly` | `false` | Force local-only mode on |
| `maxScriptTimeoutMs` | `60000` | Upper bound for the script timeout setting |
| `allowSecretExport` | `true` | Allow exports/backups that contain secrets |
| `maxResponseBytes` | 1 GiB | Upper bound for the response-size setting |
| `blockedHosts` | `[]` | Hosts (`exact` or `*.suffix`) requests may never target |
| `allowHostOverrides` | `true` | Allow Settings → Network host overrides. When `false` the entries are kept but ignored and each send shows a warning. Overrides never bypass `blockedHosts` |

Related notes: a per-request "strict SSL" switch (`strictSSL=false`) is honoured **only** when `allowInsecureTls` is
`true`; otherwise it is ignored and the request carries a policy warning. Host overrides keep the original host name for
the `Host` header, SNI and certificate validation, are listed in the Timeline, and are not applied through a proxy.

## Electron hardening checklist

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`; custom `app://` protocol with
traversal guard and CSP/`nosniff` headers; `will-navigate`/window-open/webview denied; permission requests denied;
single-instance lock; IPC sender and argument validation; no remote code loaded; OAuth sign-in uses an isolated,
non-persistent window and intercepts the redirect.

## Dependency hygiene

Minimal runtime dependencies (`drizzle-orm`, `quickjs-emscripten`, `undici`, `zod`, `tough-cookie`, and `yaml` for YAML
import: ISC, pure JavaScript). The script libraries (lodash, moment, crypto-js, uuid, ajv, tv4, chai, fast-xml-parser,
handlebars) are MIT `devDependencies` bundled at build time (`npm run build:sandbox-libs`) into committed generated
files and evaluated only inside the QuickJS sandbox; they add no runtime dependency. `npm run audit`
checks production dependencies. `drizzle-kit` (dev only) pulls an `esbuild` version flagged by `npm audit`
(dev-server request exposure); it is never run as a server or shipped.

## Known limitations

* The script sandbox shares the main process: a pathological script can stall the app until its timeout and cannot be
  hard-cancelled while CPU-bound (see `docs/features/scripting.md`).
* Cookie `httpOnly` values are hidden from scripts, but are visible to the user in the Cookies manager (after reveal).
* No code signing or auto-update is configured; both are organization-specific.
* Find & Replace regular expressions are bounded on a best-effort basis (500-character pattern limit, static rejection of
  nested unbounded quantifiers and empty matches, 2 s time budget checked between fields and every 1,024 matches). This is
  not a proof against catastrophic backtracking; a single pathological match inside one field is not interruptible.
* Backups with history contain only the most recent rows per workspace; the limit is configurable (default 500, maximum
  100000) and recorded in the backup file.
* Script libraries: `xml2js` is a facade over fast-xml-parser and `Buffer`/`csv-parse` are subsets, so edge-case behaviour
  can differ from the originals; `cheerio`, `pm.require`, `setInterval`, `fetch` and `process` are not available.
  `pm.request.auth` is a redacted, read-only view of the request's own auth (inherited auth is not resolved).
* Imported scripts are kept as text and run in the same sandbox as any other script; review the import preview warnings
  before relying on an imported collection. Insomnia v5 exports are not supported.
* HTTP/2 is available over TLS only; through a proxy the proxy owns the connection, so DNS/TCP/TLS timings and peer
  certificate details are not reported.
* Version 0.2.0 has not been validated in a tagged release yet. The CLI keeps secrets only in memory for the process
  lifetime and refuses `--insecure` unless policy allows insecure TLS (see `docs/features/cli.md`). Akamai EdgeGrid is
  verified only against an independent in-test implementation because no official test vector with a real secret exists,
  and NTLM is not executable (`docs/features/authentication.md`).
