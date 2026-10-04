# Development guide

* `npm run dev` - Vite dev server + Electron. `npm run build && npm start` - production build.
* `npm run verify` - lint + typecheck + all Vitest suites (unit, integration, security).
* `npm run test:e2e` - builds, then drives the built Electron app with Playwright (screenshots in `test-results/e2e-screenshots`).
* `npm run pack` then `npm run smoke:packaged` - builds the unpacked desktop app and verifies it boots and executes a scripted request.
* Database: edit `packages/storage/src/schema.ts`, run `npm run db:generate`, commit the new SQL in `database/migrations`.
* The services layer (`@aegis/app`) has no Electron imports: use `tests/helpers/app.ts` (`createTestApp`) to test features against real
  SQLite and a local HTTP server without launching the UI.
* After upgrading `chai`, regenerate the sandbox bundle: `npm run build:sandbox-libs`.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for conventions.
