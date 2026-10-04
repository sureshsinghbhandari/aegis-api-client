# Architecture

Aegis API Client is a local-first, desktop-first API client. Everything runs on the user's machine; there is no
account, no cloud service and no application telemetry.

```
┌─────────────────────────── Electron ────────────────────────────┐
│  Renderer (React, sandboxed, no Node)                           │
│     │  window.api  (narrow, allow-listed, typed bridge)         │
│  Preload (contextBridge) ── validates channel names only        │
│     │  ipcRenderer.invoke("namespace.method", args)             │
│  Main process                                                   │
│     ├─ ipc.ts            sender check + zod schema per channel  │
│     ├─ main.ts           window, app:// protocol, CSP, menu     │
│     └─ @aegis/app        application services (no Electron)     │
└─────────────────────────────────────────────────────────────────┘
```

## Layers and packages

Dependencies point downwards only. Every package below the renderer is plain TypeScript with **no Electron
imports**, so it is testable in Node and reusable by a future CLI.

| Package | Responsibility |
| --- | --- |
| `@aegis/core` | Domain model (requests, collections, variables, auth config), typed errors, HTTP/script wire types, URL helpers, settings and policy types, **the IPC contract** (`api.ts`), HTML preview sanitiser. Pure, browser-safe. |
| `@aegis/security` | Redaction, path safety, secret-storage abstraction, passphrase encryption (AES-256-GCM + scrypt), structured logger, audit logger, enterprise policy. |
| `@aegis/storage` | SQLite via Node's built-in `node:sqlite`, Drizzle ORM schema, repositories, secret vault (credentials ↔ `secretref:` references), transactions. |
| `@aegis/variables` | The single `VariableResolver`, precedence, dynamic-variable providers. |
| `@aegis/authentication` | Auth providers (basic, bearer, API key, OAuth 2.0 + PKCE, OAuth 1.0, JWT, AWS SigV4, custom), inheritance. |
| `@aegis/http-client` | `HttpProtocolClient` (undici): TLS, client certificates, proxy, redirects, cookies hook, cancellation, size limits, spill-to-disk. Request preparation. |
| `@aegis/scripting` | QuickJS (WASM) sandbox, `pm.*` compatibility layer, chai assertions, `pm.sendRequest`. |
| `@aegis/postman` | Postman Collection v2.0/v2.1 + environment/globals importer, v2.1 exporter, validator, semantic comparison. DB-independent. |
| `@aegis/testing` | Collection-runner loop, CSV/JSON iteration data, reports (text, JUnit). |
| `@aegis/app` | Composition root: request executor, services behind the IPC API, response store, cookie jar, import/export/backup. |

The spec suggested separate `collections` and `history` packages. Collection and history persistence are
repositories inside `@aegis/storage` and their orchestration lives in `@aegis/app`; separate packages would have been
empty indirection, so they were not created.

### Why `node:sqlite` instead of `better-sqlite3`

Native modules must be rebuilt per Electron ABI and need a C++ toolchain on every developer and CI machine.
`node:sqlite` ships with Node ≥ 22.5 and with Electron, so the *same code* runs under Vitest and in the app with no
rebuild step. Drizzle's `better-sqlite3` session is reused through a small facade (`packages/storage/src/node-sqlite.ts`)
that implements the handful of methods Drizzle calls (`prepare`, `run/get/all/raw`, `transaction`). The facade is
covered by tests, including transactions and `ON DELETE CASCADE`.

### Why QuickJS for scripts

User scripts must never run with Node access. QuickJS compiled to WebAssembly gives a fresh realm with *no* host
globals (`process`, `require`, `fs`, `fetch`… do not exist), a CPU deadline (interrupt handler), a memory limit and
a stack limit. The host exposes a small explicit bridge. See `docs/features/scripting.md` for the limits and
known residual risks (e.g. no hard cancellation of a CPU-bound script from an `AbortSignal`).

## Request execution pipeline

`RequestExecutor.execute()` (`packages/app/src/executor.ts`):

1. Load the saved request (or the unsaved editor draft), collection, folder chain, environment and all variable scopes.
2. Production safety gate (`PolicyService.productionGate`): allow / require confirmation / block.
3. Run collection → folder → request **pre-request** scripts in the sandbox; apply `pm.request` changes and variable changes.
4. Resolve `{{variables}}` with the central resolver (never mutates the stored request).
5. Build the wire request (`buildHttpRequestSpec`), resolve inherited auth, run the auth provider (signing, OAuth refresh…).
6. Policy host check, cookie jar, TLS/proxy configuration, send via `HttpProtocolClient`.
7. Store the body (memory, or a temp file when large), build the `ResponseView` for the UI.
8. Run **post-response** scripts / tests; persist variable changes (environment, collection, globals).
9. Record redacted history, test results and audit entries.

`pm.sendRequest` and OAuth token calls go through the same client with the same policy, TLS and proxy settings.

## Variable precedence

One definition (`VARIABLE_PRECEDENCE` in `packages/variables/src/resolver.ts`), highest first:

`request` › `local` › `iteration/data` › `environment` › `folder` (innermost first) › `collection` › `global`

Folder variables are folded into the collection scope for scripts (they behave like narrower collection variables).

## Data model

Drizzle schema: `packages/storage/src/schema.ts`; generated migrations: `database/migrations/` (`npm run db:generate`).
Beyond the tables required by the brief the schema adds: `secrets` (ciphertext only), `auth_json`/`scripts_json`/
`metadata_json` columns on collections and folders (collection/folder-level auth and scripts), `settings_json` on
requests, and `is_production` on environments.

Credentials never live in ordinary columns. Secret auth parameters and secret variable values are stored through
`SecretVault` into the `secrets` table **encrypted with the OS** (`safeStorage`: DPAPI / Keychain / libsecret); the
owning row stores an opaque `secretref:` reference. Secrets are written in the same SQLite transaction as the rows
that reference them, so a failed import rolls both back.

## Process model and trust boundaries

* Renderer: `contextIsolation`, `sandbox`, `nodeIntegration: false`, strict CSP, served from a custom `app://` protocol
  with path-traversal protection; navigation and window creation are denied; permissions are denied.
* Preload exposes only the channels listed in `API_CHANNELS` and the events in `EVENT_CHANNELS`.
* Main validates the **sender URL** and every argument (zod, closed enums, length limits; unknown keys stripped).
* Responses are rendered as text; HTML preview only in `<iframe sandbox="">` with an additional CSP and sanitisation.

## Protocol adapters

`ProtocolClient` (`@aegis/core`) is the extension point: `send`, `cancel`, a `protocol` id and a `ProtocolRegistry`.
HTTP is the only implementation. GraphQL, WebSocket and gRPC are **not implemented**; they can be added as new
`ProtocolClient`s without touching `HttpProtocolClient`.

## Known architectural limits

* SQLite work runs synchronously on the main-process thread. Importing a very large collection (thousands of requests)
  blocks the main thread for the duration of the transaction (≈1–2 s per 5,000 requests in tests); progress events are
  emitted but the UI repaints when the transaction completes. Moving persistence to a utility process is a roadmap item.
* The script sandbox runs in the main process (see scripting docs for the consequences).
