# Request authoring: variable hints, bulk edit and GraphQL bodies

This document covers the request-editing features added by work package A (see
`docs/postman-gap-analysis.md`, section 3). Code generation and cURL import are documented separately.

## Variable hints (autocomplete, hover, unresolved highlighting)

Every text field that accepts `{{variables}}` - the URL bar, query parameter / header / form cells, path
variables, the body editors (raw, GraphQL query and variables) and text auth fields - shows hints **before**
the request is sent:

- Typing `{{` opens a completion list. Entries show the variable name, its scope badge (Environment, Folder,
  Collection, Globals, Dynamic) and a `secret` marker. `Enter`/`Tab` accept, `Esc` closes. Dynamic variables
  (`{{$guid}}`, `{{$timestamp}}`, ...) are offered as well.
- Hovering a `{{name}}` shows the scope that wins, the owner (environment or folder name), the value (masked
  for secrets) and the other scopes that also define the name ("shadowed").
- References that no scope defines are underlined (warning colour) and the field is marked `aria-invalid`.
  The post-send list of unresolved variables is unchanged.

Implementation (`apps/desktop/renderer/src`):

| File | Role |
| --- | --- |
| `lib/variable-hints.ts` | Pure functions: index building with the static precedence (environment > folder, innermost first > collection > global), token scanning, completion context/apply, display helpers. `HINT_PRECEDENCE` mirrors `VARIABLE_PRECEDENCE` of `@aegis/variables` (unit-tested; the renderer cannot import that package because it uses `node:crypto`). |
| `lib/variable-index.ts` | Zustand store with the ACTIVE tab's index. Loaded through the existing `variables.get` channel (globals, active environment, the tab's collection and its folder chain via `folders.get`). Reloads when the workspace, active environment, environment list (refreshed after each send) or the tab's collection/folder change, on window focus and when a field is focused (throttled to 1.5 s). The URL bar mounts the loader once per active tab. |
| `components/VariableInput.tsx` | `<input>` replacement: a mirror element renders the highlighted text behind a transparent-text input so the native caret, selection, scrolling and IME keep working. Hover hit-testing measures the text with the input's computed font. |
| `components/monacoVariables.ts` | Monaco completion + hover providers (registered once) and per-editor decorations (`variableHints` prop of `CodeEditor`/`MonacoEditor`). |

Security: secrets arrive from `variables.get` as `secretref:` references and are only ever displayed as
`••••••••` (never the reference, never the plaintext). Nothing is written back; the index is read-only.

## Bulk edit

Params, Headers, `x-www-form-urlencoded` and `form-data` have a **Bulk Edit** toggle (`components/BulkEditor.tsx`,
`lib/bulk-edit.ts`). Text format: one `key:value` per line; a `//` prefix disables the row. The split happens
at the first colon, so URLs in values work. Descriptions (and for form-data the type, content type and file) are
not part of the text; they are carried over from the previous row with the same key, so toggling back and forth
loses nothing for unchanged rows. A form-data file row keeps its file while its line is unchanged; editing the
line turns it into a text row (files can only be chosen in the table).

## GraphQL body mode

`RequestBody.mode = 'graphql'` with `body.graphql = { query, variables, operationName? }` (`packages/core/src/model.ts`).
`variables` is JSON text.

- UI: `workspace/GraphQLBody.tsx` - query editor (Monaco `graphql`), variables editor (JSON, with Beautify and an
  "not valid JSON" indicator) and an optional operation name. The Content-Type override still applies.
- Sending: `packages/http-client/src/prepare.ts` serialises `{ query, variables, operationName }` as a JSON text
  body (`variables` parsed; empty text omits the key; invalid JSON is a `VALIDATION_FAILED` error) and adds
  `Content-Type: application/json` unless a header or override is present.
- Variables: `{{name}}` references are resolved in the query, the variables JSON and the operation name
  (`packages/variables/src/resolver.ts`); unresolved ones are reported like for any other body.
- Scripts: `pm.request.body` sees a `raw`/JSON snapshot of the document (`executor-support.ts` `draftToSnapshot`).
- Storage: no schema change - `request_bodies.raw_content` holds the `graphql` JSON when `mode = 'graphql'`.
- IPC: `apps/desktop/main/ipc-schemas.ts` body schema accepts the mode and the `graphql` object.
- Postman: export writes a native `{ mode: 'graphql', graphql: { query, variables, operationName } }` body.
  Import still maps Postman `graphql` bodies to a raw JSON body with the original kept in metadata (unchanged
  behaviour, owned by the import work package); such requests export as `graphql` again via that metadata.

## Other

- `MethodLabel` (`components/ui.tsx`) shows long custom methods (e.g. `PROPFIND`) in full instead of truncating
  them; the History method filter lists every well-known method including `TRACE`/`CONNECT` (`HTTP_METHODS`).

## Tests

`tests/unit/ui-variable-hints.test.ts`, `tests/unit/ui-bulk-edit.test.ts`, `tests/unit/graphql-body.test.ts`
(spec building, snapshot, resolver, storage round-trip, export) and `tests/integration/graphql.test.ts`
(JSON POST against the local test server).
