# Changelog

All notable changes are documented here. Format: Added / Changed / Fixed / Security / Documentation.

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
