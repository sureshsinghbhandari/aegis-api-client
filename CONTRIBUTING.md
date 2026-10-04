# Contributing

## Setup

```bash
npm install
npm run dev        # Vite dev server + Electron
```

Requirements: Node ≥ 22.12 (developed on Node 26), npm ≥ 10. No C++ toolchain is needed (no native modules).
npm may ask you to approve install scripts; `electron` and `esbuild` are pre-approved in `package.json`
(`allowScripts`). If Electron's binary is missing run `node node_modules/electron/install.js`.

## Checks (run before every commit)

```bash
npm run verify     # lint + typecheck + all Vitest suites
npm run test:e2e   # builds, then drives the real Electron app with Playwright
```

## Conventions

* Strict TypeScript, no `any` in source, `import type` for types.
* The renderer may import **only** `@aegis/core` (types/pure helpers) and talks to the backend through `window.api`.
  ESLint enforces this.
* Every IPC channel needs: a type in `packages/core/src/api.ts`, a name in `API_CHANNELS`, a zod schema in
  `apps/desktop/main/ipc-schemas.ts`, a handler in `@aegis/app`. A test fails if one is missing.
* Variable precedence lives only in `VariableResolver`. Postman field mapping lives only in `packages/postman`.
* Never log or persist secrets: use `SecretVault`, `redactText/redactObject/redactUrl`.
* Database changes: edit `packages/storage/src/schema.ts`, run `npm run db:generate`, commit the migration.
* Docs describe **implemented** behaviour only. Use ✅ / 🟡 / 🔴 in README status tables; never claim "100% Postman
  compatible" — extend `docs/postman-compatibility/compatibility.md` only with features covered by tests.
* Update `CHANGELOG.md` (Added / Changed / Fixed / Security / Documentation) for meaningful changes.

## Adding a protocol

Implement `ProtocolClient` from `@aegis/core`, register it in the `ProtocolRegistry`, add an executor path and UI.
Do not add protocol-specific fields to the HTTP request model.

## Never commit

`.env`, API keys, passwords, tokens, private keys, certificates with keys, SQLite files, personal test credentials
(see `.gitignore`).
