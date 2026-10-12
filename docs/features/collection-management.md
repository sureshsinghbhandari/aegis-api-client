# Collection management: find & replace, folder duplicate, cross-collection move, cookie editor

These operations live in the main process (`packages/app/src/services/core-services.ts` handlers `collections`,
`folders`, `requests`, `cookies`; `packages/app/src/services/find-replace.ts`) on top of the storage repositories
(`packages/storage/src/repositories/collections.ts`, `misc.ts`). The renderer only calls the IPC channels listed in
`API.md` and never sees secret values.

## Find & Replace (`collections.findReplace`)

Open it from the collection context menu ("Find & Replace…") or Ctrl+Shift+F. The dialog previews first and only
writes after an explicit confirmation.

| Input | Meaning |
| --- | --- |
| `collectionId` or `workspaceId` | One collection, or every collection of the workspace |
| `find`, `replace` | Search text and replacement (`replace` may be empty) |
| `matchCase`, `wholeWord` | Case-sensitive match; whole words only (letters, digits and `_` are word characters, Unicode-aware) |
| `useRegex` | Treat `find` as a JavaScript regular expression; `$1`, `$<name>` and `$&` work in `replace`. In literal mode `$` is never special |
| `scopes` | Any of `url`, `params` (query + path variables), `headers`, `body` (raw, GraphQL, urlencoded, form-data text fields), `scripts` (request, folder and collection), `descriptions` (request, folder, collection; key/value descriptions when combined with the owning scope), `variables` (collection and folder variables, non-secret only) |
| `apply` | `false` = preview: counts and excerpts, nothing written |

The result carries `matches`, `requests`, `folders`, `variables`, `collection`, `collections`, per-scope counts
(`byScope`), a human summary (`"12 matches in 2 requests, 1 folder and 2 variables"`) and up to 25 before/after
excerpts (`samples`, 60 characters of context on each side of the first match in a field).

### Guarantees

- **One transaction.** Applying runs every update in a single SQLite transaction; any failure (including the pattern
  budget below) rolls back all of it. A preview never writes.
- **Secrets are out of scope.** `secretref:` values are skipped wherever they appear, secret variables are never read,
  counted or written, and authorization parameters (request, folder and collection auth) are not searched at all,
  even non-secret ones such as a username. Excerpts therefore never contain credentials.
- **Bounded regular expressions.** Patterns are at most 500 characters; regexes that nest unbounded repetition
  (`(a+)+`, `(\d*)*`, `(x{2,})+`, ...) are rejected statically; patterns that match the empty string are rejected;
  evaluation has a 2-second wall-clock budget checked between fields and every 1,024 matches inside a field. This is a
  best-effort defence against catastrophic backtracking, not a proof: keep the scope narrow when experimenting.
- **Audited.** Applying writes an audit entry `FIND_REPLACE` with the target kind, scopes, flags, the lengths of the
  search and replacement text and the counts. The searched or replacement text is never stored in the audit log.
- **Open tabs.** After a replace, saved tabs of the affected collections are reloaded from the database. Tabs with
  unsaved edits are left untouched and a notice explains that saving them would overwrite the replacement.

## Folder duplicate (`folders.duplicate`)

Context menu "Duplicate" on a folder creates `<name> Copy` next to the original with a deep copy of sub-folders,
requests (headers, params, body, scripts, examples, settings), folder scripts and folder variables. Credentials are
read through the vault and re-vaulted under the new folder/request ids (`auth:<newRequestId>:*`, `auth:f:<newFolderId>:*`,
new secret-variable rows), so deleting either copy never affects the other. The copy runs in one transaction.

## Cross-collection move (`requests.move` with `collectionId`)

Folders and requests can be dragged onto another collection (its row, a folder in it, or between its items) or moved
through the context menu "Move to…" which lets you pick the collection and the destination folder. The repository
(`moveToCollection`) updates `collectionId` on the whole subtree (folders and requests) and re-numbers the siblings in
the new parent, inside one transaction.

Nothing is re-vaulted: request auth, folder auth and folder variables are keyed by request/folder id and travel with
their owner. What does change is the inherited context: the moved items now inherit the **target** collection's auth,
scripts and collection variables, and no longer see the source collection's. A toast says so after the move.
A folder cannot be moved into itself or one of its descendants; the destination folder must belong to the chosen
collection.

Drag & drop onto a collection that has not been expanded yet works: the tree is loaded before the move is planned.
The planner (`planNodeMove` in `apps/desktop/renderer/src/lib/collectionTree.ts`) takes the target collection's tree
and returns `collectionId` only for cross-collection moves.

## Cookie manager: add and edit (`cookies.add`, `cookies.update`)

Settings › Cookies has "Add cookie" and a per-row "Edit". The form is rendered inside the settings dialog so the settings
stay open. Validation (`normalizeCookieInput` in `packages/storage/src/repositories/misc.ts`):

- `domain`: host name only (no scheme, port, path, `@`, whitespace or wildcards), not empty and not `*`; lower-cased.
  A leading dot includes sub-domains; `hostOnly` defaults to true without a leading dot.
- `name`: RFC 6265 token characters only (no spaces, `=`, `;`, `,`); `value`: no spaces, semicolons or control
  characters (max 64 KiB); `path`: must start with `/`, defaults to `/`.
- `sameSite`: `Strict`, `Lax`, `None` or unset; `None` requires `secure`.
- `expiresAt`: ISO timestamp (normalised) or empty for a session cookie.
- Duplicates (same domain + path + name) are refused on add and on edit.

The value is written to the vault only (`cookie:<id>`); the `cookies` table holds a reference. On edit, an empty value
keeps the stored one. Every change invalidates the in-memory jar of the workspace, so the next request reloads from
the database. `httpOnly` cookies remain invisible to scripts (`pm.cookies`) but are editable in the manager.

## Tests

- `tests/integration/storage-collection-ops.test.ts`: deep copy with re-vaulted secrets and independent deletion,
  move cascade, find & replace counts, dry run, rollback, scopes, flags, service-level channels, audit without values,
  cookie validation and jar refresh.
- `tests/security/find-replace.test.ts`: ReDoS heuristics, pattern limits, time budget with rollback, secrets never
  searched or changed.
- `tests/unit/ui-move-plan.test.ts`: cross-collection drop planning, subtree request ids, tab reload partitioning.
