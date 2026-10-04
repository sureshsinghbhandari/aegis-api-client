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
| Credential leak on redirect | Authorization/Cookie dropped on cross-origin redirects | HTTP tests |

## Secret storage

* Provider abstraction: `SecretStorageProvider` / `SyncSecretStorage` (`packages/security/src/secrets.ts`).
* Desktop implementation: Electron `safeStorage` → Windows DPAPI, macOS Keychain, Linux Secret Service (libsecret).
  If the OS keyring is unavailable (e.g. Linux `basic_text` backend) the app **refuses to store secrets** instead of
  silently storing them weakly, and the status bar says so.
* Stored encrypted: secret environment/collection/folder/global variable values, secret auth parameters (passwords,
  tokens, client secrets, API-key values, JWT secrets/private keys, OAuth tokens), cookie values, client-certificate
  keys and passphrases, the proxy password.
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
  `DELETE_HISTORY`, `EXPORT_SECRETS`, and backup/restore events — never secret values.
* **Local-only mode.** The application contains no analytics, telemetry, crash reporting, sync or auto-update code.
  The only network traffic is what the user sends (plus explicitly configured OAuth/proxy endpoints). The setting is
  displayed in the UI and can be enforced by policy (`enforceLocalOnly`).

## Enterprise policy

An administrator-controlled JSON file, searched in order: `AEGIS_POLICY_FILE`, then
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

## Electron hardening checklist

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`; custom `app://` protocol with
traversal guard and CSP/`nosniff` headers; `will-navigate`/window-open/webview denied; permission requests denied;
single-instance lock; IPC sender and argument validation; no remote code loaded; OAuth sign-in uses an isolated,
non-persistent window and intercepts the redirect.

## Dependency hygiene

Minimal runtime dependencies (`drizzle-orm`, `quickjs-emscripten`, `undici`, `zod`, `tough-cookie`). `npm run audit`
checks production dependencies. `drizzle-kit` (dev only) pulls an `esbuild` version flagged by `npm audit`
(dev-server request exposure); it is never run as a server or shipped.

## Known limitations

* The script sandbox shares the main process: a pathological script can stall the app until its timeout and cannot be
  hard-cancelled while CPU-bound (see `docs/features/scripting.md`).
* Cookie `httpOnly` values are hidden from scripts, but are visible to the user in the Cookies manager (after reveal).
* No code signing or auto-update is configured; both are organization-specific.
