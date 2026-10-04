# Postman compatibility

Aegis API Client is **Postman Collection v2.1 compatible for supported fields/features**. This document lists exactly which fields and features are supported, which are preserved but not executed, and which are not handled. It does not claim full or 100% compatibility with Postman.

Scope of `packages/postman`:

- Import: Postman Collection v2.0 and v2.1, Postman Environment, Postman Globals.
- Export: Postman Collection v2.1, Postman Environment, Postman Globals.
- The package is DB-independent. It converts between Postman JSON and the in-memory `CollectionBundle` / `EnvironmentBundle` (`packages/core/src/model.ts`).

## How "Supported" is decided

A feature is marked **Supported** only when a test in this repository demonstrates it. The tests are:

| Test file | What it covers |
| --- | --- |
| `tests/unit/postman-detect.test.ts` | Format detection of every fixture |
| `tests/unit/postman-import.test.ts` | Field-by-field import mapping, warnings, progress |
| `tests/unit/postman-export.test.ts` | Export shape, secret handling, determinism, structural validator, semantic comparison |
| `tests/unit/postman-environment.test.ts` | Environment and globals import/export |
| `tests/unit/postman-security.test.ts` | Unsafe file paths, prototype pollution, size/depth limits, malformed input, warning caps |
| `tests/integration/postman-roundtrip.test.ts` | For every collection fixture: import, export, structural validation, re-import, semantic comparison, determinism, JSON-level preservation, no secret leakage |

Fixtures live in `tests/fixtures/postman/` (including `kitchen-sink.json`, a 47-request "Customer API" collection) and `tests/fixtures/postman/invalid/`.

The **Runtime** column says what happens when a request is actually sent or a script is executed. This package only converts documents, so unless a row says otherwise the value is `n/a (verified in app tests)`: runtime behaviour belongs to the HTTP client, authentication and scripting packages and is verified by their own tests, not here.

## Important honesty notes

- **No official schema validation.** `validatePostmanV21Structure` is a structural check written for this project (info, schema URL, item tree, request/url/header/body/auth/event/variable shapes). The official Postman JSON schema could not be fetched during development (no network), so exports have **not** been validated against it and have **not** been imported into the Postman application. "Valid" in our tests means "passes our structural check and re-imports to a semantically equal bundle".
- `compareCollectionBundles` is our own semantic comparison, used by the round-trip tests. It also compares preserved metadata, so a field that is silently lost makes the round-trip tests fail.
- Postman behaviour that is ambiguous is documented in [Documented behaviours](#documented-behaviours) and the documented behaviour is what the tests assert.

## Feature matrix

Legend: **Supported** = import and export demonstrated by tests. **Preserved** = kept in `metadata` / `sourceMetadata`, reported as a warning, re-emitted on export, but not executed. **Not supported** = not read.

### Documents

| Feature | Import | Export | Runtime | Status / notes |
| --- | --- | --- | --- | --- |
| Collection v2.1 | Yes | Yes | n/a (verified in app tests) | Supported |
| Collection v2.0 | Yes | Exported as v2.1 | n/a (verified in app tests) | Supported. String headers, `request` as URL string, object-form auth parameters and string `exec` are read; an INFO warning says the file is converted. |
| Collection without `info.schema` | Yes (treated as v2.1) | Yes | n/a | Supported. INFO warning on import. |
| Collection v1 (`order` / `requests`) | No | No | n/a | Not supported. Rejected with `IMPORT_INVALID`. |
| Environment | Yes | Yes | n/a (verified in app tests) | Supported. `_postman_exported_at` is not re-emitted (determinism); `id`, `_postman_variable_scope`, `_postman_exported_using` and unknown top-level keys are kept. |
| Globals | Yes | Yes | n/a (verified in app tests) | Supported. Name defaults to "Globals". |
| Postman API responses, workspace dumps, OpenAPI | No | No | n/a | Not supported |

### Collection structure

| Feature | Import | Export | Runtime | Status / notes |
| --- | --- | --- | --- | --- |
| `info.name`, `_postman_id`, description | Yes | Yes | n/a | Supported. Missing `_postman_id` on export: deterministic uuid-shaped id from SHA-1 of the name. |
| `info.version`, `_exporter_id`, other `info` keys | Preserved (`sourceMetadata.info`) | Re-emitted | n/a | Preserved |
| Unknown top-level keys | Preserved (`sourceMetadata.extra`), WARNING | Re-emitted | n/a | Preserved |
| Folders, any nesting up to 64 levels | Yes | Yes | n/a | Supported. Deeper nesting is rejected (`IMPORT_INVALID`). Item order is preserved. |
| Folder / request / collection `description` (string or `{content,type}`) | Yes (type kept in `_descriptionType`) | Restored | n/a | Supported |
| Description stored on the item instead of the request | Yes (`_descriptionAt: 'item'`) | Restored | n/a | Supported |
| Item `id` | Preserved (`postmanId`) | Re-emitted | n/a | Preserved |
| Unknown item / request / folder keys (e.g. `x-custom`) | Preserved (`itemExtras`, `requestExtras`), WARNING | Re-emitted | n/a | Preserved |
| Request-level `certificate`, `proxy` | Preserved (`requestExtras`), WARNING | Re-emitted | Not applied | Preserved |
| Items that are neither folder nor request | Skipped, WARNING with the source | Not exported | n/a | Reported only |

### Requests

| Feature | Import | Export | Runtime | Status / notes |
| --- | --- | --- | --- | --- |
| Methods (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, custom) | Yes | Yes | n/a (verified in app tests) | Supported. Missing method defaults to GET. |
| URL as string or object | Yes | Always object | n/a | Supported. URL stored without query; `{{vars}}` and `:pathVars` kept verbatim. |
| Query parameters incl. disabled | Yes | Yes | n/a (verified in app tests) | Supported. Values are kept as written (no percent-decoding). |
| Path variables (`url.variable`, `:name`) | Yes | Yes | n/a (verified in app tests) | Supported. `{{name}}` segments are variables, not path variables. |
| URL fragment (`#...`) | Preserved (`urlHash`) | Re-emitted | Fragments are never sent | Preserved |
| Unknown `url` keys | Preserved (`urlExtras`), WARNING | Re-emitted | n/a | Preserved |
| Headers incl. disabled, descriptions | Yes | Yes | n/a (verified in app tests) | Supported. v2.0 string form is parsed. |
| Body `raw` (json, xml, text, html, javascript) | Yes | Yes | n/a (verified in app tests) | Supported |
| Body `raw` with another language (e.g. yaml) | Imported as `text`, original in `bodyOptions`, INFO | Original language restored unless the user changed it | n/a | Preserved |
| Body `urlencoded` | Yes | Yes | n/a (verified in app tests) | Supported |
| Body `formdata` (text, file, contentType, disabled, description) | Yes | Yes | n/a (verified in app tests) | Supported. File paths are validated, see [Security](#security-behaviour). |
| Body `file` (binary) | Yes | Yes | n/a (verified in app tests) | Supported. Path validated like form-data files. |
| Body `graphql` | Imported as raw JSON `{query, variables}`, WARNING | Original `graphql` body restored while the raw body is unchanged; rebuilt from the raw JSON if it was edited | Sent as a JSON POST body, no GraphQL-specific features | Partial |
| Disabled body (`body.disabled`) | Imported as "no body", original kept (`bodyOriginal`), WARNING | Restored | Not sent | Preserved |
| Unknown body mode | Imported as "no body", original kept, WARNING | Restored | Not sent | Preserved |
| Unknown body keys | Preserved (`bodyExtra`), WARNING | Re-emitted | n/a | Preserved |
| `protocolProfileBehavior` `followRedirects`, `maxRedirects`, `strictSSL` | Mapped to `settings.followRedirects`, `maxRedirects`, `verifyTls` | Written back | n/a (verified in app tests) | Supported |
| Other `protocolProfileBehavior` keys (`disableBodyPruning`, ...) | Preserved, INFO | Re-emitted | Not applied | Preserved |
| Folder- and collection-level `protocolProfileBehavior` | Preserved as a whole, not applied | Re-emitted | Not applied | Preserved |

### Authentication

| Feature | Import | Export | Runtime | Status / notes |
| --- | --- | --- | --- | --- |
| `noauth` | `none` | `{type: noauth}` at request/folder level; omitted at collection level | n/a | Supported |
| Inheritance | Missing auth: collection `none`, folder `inherit`, request `inherit` | `inherit` omits `auth` | n/a (verified in app tests) | Supported |
| `basic`, `bearer`, `apikey` | Yes | Yes | n/a (verified in app tests) | Supported. Parameter names are Postman's. |
| `oauth2` (authorization code with PKCE, client credentials, other grants) | Parameters kept with Postman names | Yes | n/a (verified in app tests) | Supported for parameter round trip. Structured parameters (e.g. `tokenRequestParams`) are stored as JSON text and restored. Whether a grant can be executed is decided by the authentication package. |
| `oauth1`, `awsv4`, `jwt` | Yes | Yes | n/a (verified in app tests) | Supported for parameter round trip |
| `digest`, `hawk`, `ntlm`, `edgegrid`, `asap`, `akamai`, any other type | Type `custom` with `providerId` = original type, WARNING | Original type and parameters restored | Not executable | Preserved |
| Per-parameter `type` labels, extra keys beside the parameter list | Preserved (`authMeta`) | Restored | n/a | Preserved |
| Secrets on export | n/a | Credential parameters are blanked unless `includeSecrets`; `{{variable}}` references are kept | n/a | Supported |

Credential parameters are the ones in `AUTH_SECRET_PARAMS` (`password`, `token`, `value` of apikey, `clientSecret`, `accessToken`, `refreshToken`, `consumerSecret`, `tokenSecret`, `secret`, `privateKey`, `secretKey`, `sessionToken`, ...). For `custom` auth, every parameter whose key looks sensitive (`isSensitiveKey`, plus `authKey`) is blanked.

### Scripts, variables, examples

| Feature | Import | Export | Runtime | Status / notes |
| --- | --- | --- | --- | --- |
| `prerequest` and `test` events at collection, folder and request level | Yes (`exec` array or string, joined with `\n`) | Yes (`exec` split on `\n`, type `text/javascript`) | n/a (verified in app tests) | Supported. Script text is preserved exactly (no whitespace normalisation). |
| Disabled events | `enabled: false` | `disabled: true` | Not run | Supported |
| Event / script `id`, `name` and other keys | Preserved (`scriptExtras`) | Restored | n/a | Preserved |
| External script (`script.src` without `exec`) | **Not fetched**, event kept (`eventExtras`), WARNING | Re-emitted | Not executed | Preserved |
| Unknown `listen` values | Kept (`eventExtras`), WARNING | Re-emitted | Not executed | Preserved. Our structural validator flags such documents (official schema allows any string). |
| Script type other than `text/javascript` | Treated as JavaScript, original type kept, WARNING | Original type restored | n/a | Preserved |
| `pm.*` API coverage | n/a | n/a | n/a (verified in app tests) | Handled by the scripting package; gaps are documented there |
| Collection and folder variables (`key`, `value`, `description`, `disabled`, `type`) | Yes | Yes | n/a (verified in app tests) | Supported |
| `type: secret` variables | `isSecret: true` | Value blanked unless `includeSecrets`; `type: secret` kept | n/a | Supported |
| Variable `id`, legacy variables using `id` as the name | `id` as the name only when `key` is absent; otherwise `id` is not preserved | Not emitted | n/a | Limitation |
| Saved responses (`item.response[]`): name, status, code, headers, body, `_postman_previewlanguage`, `cookie`, `originalRequest`, `id` | Yes (headers array or string) | Yes | Examples are documentation only | Supported |
| Saved-response keys such as `responseTime` | Preserved in example metadata | Re-emitted | n/a | Preserved |
| Credentials inside a saved response's `originalRequest.auth` | Kept | Blanked unless `includeSecrets` | n/a | Supported |

### Environments and globals

| Feature | Import | Export | Runtime | Status / notes |
| --- | --- | --- | --- | --- |
| `values[].key/value/type/enabled` | Yes | Yes | n/a (verified in app tests) | Supported. Types `default`, `secret`, `any`. |
| Secret values | `isSecret: true` | Blank unless `includeSecrets`; the current value is preferred over the initial one | n/a | Supported |
| `description` on values | Yes | Yes | n/a | Supported (extension; not part of the classic Postman environment format) |
| Unknown value keys | Dropped with a WARNING | Not exported | n/a | Limitation |
| Unknown top-level keys | Preserved (`sourceMetadata`), WARNING | Re-emitted | n/a | Preserved |

## Documented behaviours

These are choices made where Postman is ambiguous or the internal model is narrower than Postman. Tests assert them.

- **Query strings are not percent-decoded or re-encoded.** `sort=name%20asc` is stored and exported as written, so `{{vars}}`, `+` and `%XX` survive. When a request is sent, the HTTP client encodes values with `encodeQueryComponent` (existing `%XX` escapes are left alone).
- **Empty query values are exported as `key=`.** A source `?flag` therefore comes back as `?flag=` in `url.raw`; the bundles are equal.
- **Only enabled parameters appear in `url.raw`**, disabled ones only in `url.query` with `disabled: true` (as Postman does).
- **Variable values are strings.** Non-string source values (numbers, booleans) are converted to text and re-exported as strings; `type` is kept. Structured values (arrays/objects) are stored as JSON text with a WARNING.
- **Exports always contain** `header: []` and `response: []` for requests, and `type: "text"` on headers, urlencoded entries and text form fields. These are the shapes the Postman app writes.
- **Auth `none`:** collection-level `none` is exported by omitting `auth`; request/folder `none` as `noauth`. A collection without `auth` imports as `none`; folders and requests without `auth` import as `inherit`.
- **Disabled body.** A body with `disabled: true` becomes "no body" in the app (it would not be sent) and is restored on export.
- **Depth limit** is reported as `IMPORT_INVALID` ("nested deeper than ..."); item count and text size limits as `IMPORT_TOO_LARGE`.
- **Warnings are bounded:** at most 2000 non-error entries; source values are cut at 300 characters; a final INFO states how many entries were suppressed.
- **Deterministic exports:** stable key order, no timestamps, ids derived from names when absent. Exporting an imported export gives identical text (tested).
- **Headers, URLs and bodies are exported as stored.** Only variables, auth parameters and saved-response auth are redacted when `includeSecrets` is false. A literal `Authorization` header or a token inside a body is **not** detected; use `{{variables}}` for credentials.

## Security behaviour

- **File references** (form-data `src`, binary `file.src`) are checked with `checkImportedFilePath`. Absolute paths, drive letters, UNC paths, `..` segments, `~`, environment-variable expansion, `file:` URLs and NUL bytes are rejected: the path is **not stored** in the bundle and a WARNING with the reason and the source value is recorded. Only plain relative paths are kept. Code that later reads a file for upload must validate the path again (`assertSafeFilePath` in `@aegis/security`); the importer does not read files.
- **Prototype pollution:** unknown fields are deep-cloned and the keys `__proto__`, `constructor` and `prototype` are dropped at every level, with a WARNING.
- **Size limits:** JSON text larger than 256 MiB (configurable) is rejected before parsing (`IMPORT_TOO_LARGE`); at most 200000 folders+items; folder depth at most 64; preserved extras nested deeper than 500 levels are rejected.
- **Secrets on export:** see Authentication and Variables above. `includeSecrets: true` must be an explicit choice by the caller.

## Not supported / known limitations

- Digest, Hawk, NTLM, EdgeGrid, ASAP and Akamai auth are preserved but cannot be executed.
- External scripts (`script.src`) are never downloaded.
- GraphQL requests are plain JSON POST bodies; there is no GraphQL-specific UI or introspection.
- Request-level `certificate` and `proxy`, and `protocolProfileBehavior` keys other than the three mapped ones, are preserved but not applied.
- Postman Flows, mock servers, monitors, collection runner data files, `postman_collection` v1, Postman API payloads and workspace exports are not handled.
- Variable ids, header `type`/`system` flags and query `equals` flags are not preserved (they carry no behaviour).
- Multiple files in one form-data `src` array: only the first is imported (WARNING).
- Exports have not been validated against the official JSON schema or imported into the Postman application (see the honesty notes).
