# IPC API reference

The renderer talks to the main process **only** through `window.api`. The typed contract is
`packages/core/src/api.ts` (`AegisApi`); argument schemas are in `apps/desktop/main/ipc-schemas.ts`; the
implementation is in `packages/app/src/`. Every call takes one object argument and returns a promise. Errors reject
with `{ code, message, details }` (see error codes in `packages/core/src/errors.ts`); stack traces never cross the
boundary.

Every call is validated in the main process: the sender must be the app's own renderer, arguments must match the
channel's zod schema (closed enums, length limits, unknown keys stripped).

Events (main → renderer, via `window.api.events.on`): `runner:item`, `runner:done`, `import:progress`, `menu:action`.

> This file is checked by `tests/unit/docs.test.ts`: every channel in `API_CHANNELS` must be listed here.

## `app`

Application info (version, data directory, secret-storage status, effective settings and policy).

| Channel | Window API |
| --- | --- |
| `app.info` | `window.api.app.info(args)` |

## `workspaces`

Personal / Team / Enterprise workspaces (local entities): CRUD, search, export.

| Channel | Window API |
| --- | --- |
| `workspaces.list` | `window.api.workspaces.list(args)` |
| `workspaces.create` | `window.api.workspaces.create(args)` |
| `workspaces.update` | `window.api.workspaces.update(args)` |
| `workspaces.delete` | `window.api.workspaces.delete(args)` |
| `workspaces.search` | `window.api.workspaces.search(args)` |
| `workspaces.export` | `window.api.workspaces.export(args)` |

## `collections`

Collections: CRUD, duplicate, reorder, lazy tree (flat rows), global search.

| Channel | Window API |
| --- | --- |
| `collections.list` | `window.api.collections.list(args)` |
| `collections.get` | `window.api.collections.get(args)` |
| `collections.create` | `window.api.collections.create(args)` |
| `collections.update` | `window.api.collections.update(args)` |
| `collections.delete` | `window.api.collections.delete(args)` |
| `collections.duplicate` | `window.api.collections.duplicate(args)` |
| `collections.reorder` | `window.api.collections.reorder(args)` |
| `collections.tree` | `window.api.collections.tree(args)` |
| `collections.search` | `window.api.collections.search(args)` |
| `collections.findReplace` | `window.api.collections.findReplace(args)` — preview (`apply: false`) or apply find & replace across one collection (`collectionId`) or a whole workspace (`workspaceId`); literal, whole-word or bounded regex; one transaction, `secretref:` values, secret variables and auth credentials skipped, audited as `FIND_REPLACE` (counts only, never values); returns per-scope counts, a summary and capped before/after samples |

## `folders`

Nested folders with folder-level auth and scripts.

| Channel | Window API |
| --- | --- |
| `folders.get` | `window.api.folders.get(args)` |
| `folders.create` | `window.api.folders.create(args)` |
| `folders.update` | `window.api.folders.update(args)` |
| `folders.delete` | `window.api.folders.delete(args)` |
| `folders.duplicate` | `window.api.folders.duplicate(args)` — deep copy next to the original (sub-folders, requests, scripts, variables, auth re-vaulted) |

## `requests`

Requests: CRUD, duplicate, move/reorder, effective (inherited) auth.

| Channel | Window API |
| --- | --- |
| `requests.get` | `window.api.requests.get(args)` |
| `requests.create` | `window.api.requests.create(args)` |
| `requests.save` | `window.api.requests.save(args)` |
| `requests.delete` | `window.api.requests.delete(args)` |
| `requests.duplicate` | `window.api.requests.duplicate(args)` |
| `requests.move` | `window.api.requests.move(args)` — optional `collectionId` moves a request or folder (with its subtree) into another collection |
| `requests.effectiveAuth` | `window.api.requests.effectiveAuth(args)` |

## `environments`

Environments, activation (production flag).

| Channel | Window API |
| --- | --- |
| `environments.list` | `window.api.environments.list(args)` |
| `environments.create` | `window.api.environments.create(args)` |
| `environments.update` | `window.api.environments.update(args)` |
| `environments.duplicate` | `window.api.environments.duplicate(args)` |
| `environments.delete` | `window.api.environments.delete(args)` |
| `environments.setActive` | `window.api.environments.setActive(args)` |

## `variables`

Variables of any scope (environment/global/collection/folder). Secrets are returned as `secretref:` references; `revealSecret` is an explicit, audited action.

| Channel | Window API |
| --- | --- |
| `variables.get` | `window.api.variables.get(args)` |
| `variables.set` | `window.api.variables.set(args)` |
| `variables.revealSecret` | `window.api.variables.revealSecret(args)` |

## `execution`

Send a request (saved or unsaved draft) / cancel it.

| Channel | Window API |
| --- | --- |
| `execution.send` | `window.api.execution.send(args)` |
| `execution.cancel` | `window.api.execution.cancel(args)` |

## `responses`

Chunked access to response bodies (no huge payloads in the DOM), save to file.

| Channel | Window API |
| --- | --- |
| `responses.readChunk` | `window.api.responses.readChunk(args)` |
| `responses.saveAs` | `window.api.responses.saveAs(args)` |
| `responses.release` | `window.api.responses.release(args)` |

## `history`

Paginated history search, replay, save to collection, delete/clear.

| Channel | Window API |
| --- | --- |
| `history.search` | `window.api.history.search(args)` |
| `history.get` | `window.api.history.get(args)` |
| `history.delete` | `window.api.history.delete(args)` |
| `history.clear` | `window.api.history.clear(args)` |
| `history.replay` | `window.api.history.replay(args)` |
| `history.saveToCollection` | `window.api.history.saveToCollection(args)` |

## `runner`

Collection runner: start/stop, iteration data, results. Progress arrives as `runner:item` / `runner:done` events.
`runner.start` accepts `requestIds` (run only these requests, in this order) and `keepResponses` (store a redacted response head per item: status, non-sensitive headers, first 64 KiB of the body; `runner.items` and `runner:item` then carry `response`).

| Channel | Window API |
| --- | --- |
| `runner.start` | `window.api.runner.start(args)` |
| `runner.stop` | `window.api.runner.stop(args)` |
| `runner.list` | `window.api.runner.list(args)` |
| `runner.items` | `window.api.runner.items(args)` |

## `importExport`

Postman import (preview → commit, transactional), Postman v2.1 / environment export, backups.
`pickAndPreview` / `previewContent` take `kind`: `postman-collection`, `postman-environment`, `backup`, `openapi` (OpenAPI 3.x + Swagger 2.0, JSON/YAML), `har`, `insomnia`, `postman-v1`, `postman-dump`, `aegis-workspace` or `auto` (content-based detection); the preview's `kind` reports what was found. `createBackup` takes an optional `historyLimit` (newest history rows per workspace, default 500, max 100000).

| Channel | Window API |
| --- | --- |
| `importExport.pickAndPreview` | `window.api.importExport.pickAndPreview(args)` |
| `importExport.previewContent` | `window.api.importExport.previewContent(args)` |
| `importExport.commit` | `window.api.importExport.commit(args)` |
| `importExport.discard` | `window.api.importExport.discard(args)` |
| `importExport.exportCollection` | `window.api.importExport.exportCollection(args)` |
| `importExport.exportEnvironment` | `window.api.importExport.exportEnvironment(args)` |
| `importExport.createBackup` | `window.api.importExport.createBackup(args)` |
| `importExport.listBackups` | `window.api.importExport.listBackups(args)` |

## `settings`

Application settings (policy-clamped), proxy password.

| Channel | Window API |
| --- | --- |
| `settings.get` | `window.api.settings.get(args)` |
| `settings.update` | `window.api.settings.update(args)` |
| `settings.setProxyPassword` | `window.api.settings.setProxyPassword(args)` |

## `cookies`

Cookie jar manager.

| Channel | Window API |
| --- | --- |
| `cookies.list` | `window.api.cookies.list(args)` |
| `cookies.reveal` | `window.api.cookies.reveal(args)` |
| `cookies.delete` | `window.api.cookies.delete(args)` |
| `cookies.clear` | `window.api.cookies.clear(args)` |
| `cookies.add` | `window.api.cookies.add(args)` — add a cookie by hand; the value is stored in the vault |
| `cookies.update` | `window.api.cookies.update(args)` — edit attributes and/or value (omit `value` to keep it) |

## `certificates`

Custom CA and client certificates for mutual TLS.

| Channel | Window API |
| --- | --- |
| `certificates.list` | `window.api.certificates.list(args)` |
| `certificates.add` | `window.api.certificates.add(args)` — PEM (`certPem` + `keyPem`) or PKCS#12 (`pfxBase64`, or `pfxPath` read by the main process, 2 MiB cap); keys, bundles and passphrases go to the vault |
| `certificates.pickFile` | `window.api.certificates.pickFile(args)` |
| `certificates.setEnabled` | `window.api.certificates.setEnabled(args)` |
| `certificates.delete` | `window.api.certificates.delete(args)` |

## `audit`

Audit log viewer.

| Channel | Window API |
| --- | --- |
| `audit.list` | `window.api.audit.list(args)` |

## `tools`

JWT decode, file pickers, interactive OAuth 2.0 token acquisition.

| Channel | Window API |
| --- | --- |
| `tools.decodeJwt` | `window.api.tools.decodeJwt(args)` |
| `tools.pickFile` | `window.api.tools.pickFile(args)` |
| `tools.oauth2GetToken` | `window.api.tools.oauth2GetToken(args)` — resolves `{{variables}}` with the request's collection/folder scopes as well as environment and globals; optional `cancelId` makes the flow abortable via `execution.cancel({ executionId: cancelId })` |
| `tools.oauth2DeviceStart` | `window.api.tools.oauth2DeviceStart(args)` — OAuth 2.0 device flow (RFC 8628) step 1: returns `deviceCode` (keep in memory), `userCode`, `verificationUri`, `interval` |
| `tools.oauth2DevicePoll` | `window.api.tools.oauth2DevicePoll(args)` — step 2: one poll of the token endpoint; `{ status: 'pending', interval }` or `{ status: 'done', params }`. Cancel by not polling again. Token/device endpoints go through the same policy host check as requests |

## Example

```ts
const result = await window.api.execution.send({
  executionId: crypto.randomUUID(),
  workspaceId,
  draft, // unsaved editor state
});
if (result.response) console.log(result.response.status, result.tests);
```
