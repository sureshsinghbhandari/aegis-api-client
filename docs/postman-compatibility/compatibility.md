# Postman compatibility

Aegis API Client is **Postman Collection v2.1 compatible for supported fields/features**. This document lists exactly which fields and features are supported, which are preserved but not executed, and which are not handled. It does not claim full or 100% compatibility with Postman.

Scope of `packages/postman`:

- Import: Postman Collection v1, v2.0 and v2.1, Postman Environment, Postman Globals, Postman data dump, OpenAPI 3.0/3.1 (JSON + YAML), Swagger 2.0, HAR 1.2, Insomnia v4 export, Aegis workspace file. See [Other import formats](#other-import-formats) and [docs/features/import-formats.md](../features/import-formats.md).
- Export: Postman Collection v2.1, Postman Environment, Postman Globals (and the Aegis workspace file, which is built from these).
- The package is DB-independent. It converts between the source documents and the in-memory `CollectionBundle` / `EnvironmentBundle` (`packages/core/src/model.ts`). Every format ends up in the same bundle, so storage, preview, warnings and transactional rollback are shared.

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
| `tests/unit/postman-openapi.test.ts`, `tests/unit/postman-swagger2.test.ts` | OpenAPI 3.0 (JSON) / 3.1 (YAML) and Swagger 2.0 mapping, fixture driven |
| `tests/unit/postman-openapi-security.test.ts` | Local-only `$ref`, recursive schemas, example size caps, prototype pollution, YAML alias bombs / tags / depth, auto-detect dispatch |
| `tests/integration/import-formats.test.ts` | Service level: Aegis workspace file round trip, auto-detect, wrong-kind refusal, rollback, backup history limit |
| `tests/unit/postman-har.test.ts`, `postman-insomnia.test.ts`, `postman-v1.test.ts`, `postman-dump.test.ts` | HAR, Insomnia, Postman v1 and data-dump mapping (maintained with those importers) |

Fixtures live in `tests/fixtures/postman/` (including `kitchen-sink.json`, a 47-request "Customer API" collection), `tests/fixtures/postman/invalid/`, `tests/fixtures/openapi/`, `tests/fixtures/har/`, `tests/fixtures/insomnia/`, `tests/fixtures/postman-v1/` and `tests/fixtures/dump/`.

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
| Collection v1 (`order` / `requests`) | Yes (converted) | Exported as v2.1 | n/a | Supported by `parsePostmanV1` (see [Other import formats](#other-import-formats)); `parsePostmanCollection` itself still rejects v1 with `IMPORT_INVALID`, the service-level importer dispatches it. |
| Environment | Yes | Yes | n/a (verified in app tests) | Supported. `_postman_exported_at` is not re-emitted (determinism); `id`, `_postman_variable_scope`, `_postman_exported_using` and unknown top-level keys are kept. |
| Globals | Yes | Yes | n/a (verified in app tests) | Supported. Name defaults to "Globals". |
| Postman data dump (`collections[]`, `environments[]`, `globals`) | Yes (split into the importers above) | No | n/a | Supported, see [Other import formats](#other-import-formats) |
| Postman API payloads (`{ collection: {...} }` responses of the Postman API) | No | No | n/a | Not supported |
| OpenAPI 3.x, Swagger 2.0, HAR, Insomnia, Aegis workspace file | Yes | No (collections are exported as Postman v2.1) | n/a | Supported, see [Other import formats](#other-import-formats) |

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
| `protocolProfileBehavior` `followRedirects`, `maxRedirects` | Mapped to `settings.followRedirects`, `maxRedirects` | Written back | n/a (verified in app tests) | Supported |
| `protocolProfileBehavior` `strictSSL` | Mapped to `settings.verifyTls` | Written back | `strictSSL: false` is honoured only when the enterprise policy sets `allowInsecureTls: true`; otherwise verification stays on and the send reports a warning (`packages/app/src/executor.ts`) | Supported with a policy gate |
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

## Other import formats

Every importer below produces the same `CollectionBundle` / `EnvironmentBundle`, so the preview, the warning list, the transactional commit and the rollback are identical to the Postman import. None of them exports back to its source format: an imported API is exported as a Postman v2.1 collection. **Nothing is ever fetched**: `$ref`s to other files or URLs, `externalValue` examples, external scripts and OpenID Connect discovery documents become WARNINGs and the referenced part stays empty. Full mapping tables: [docs/features/import-formats.md](../features/import-formats.md).

| Format | Detected by | Import | Runtime | Status / notes |
| --- | --- | --- | --- | --- |
| OpenAPI 3.0 / 3.1 (JSON, YAML) | `openapi: "3.x"` + `paths` (or `webhooks`) | Tags -> folders, operations -> requests, `servers[0]` -> `{{baseUrl}}`, path params -> `:name`, query/header params -> rows (enabled when `required`), request bodies -> JSON / urlencoded / form-data examples generated from schemas (depth 8, 2000 values per example), responses -> examples, `securitySchemes` -> auth with `{{placeholder}}` variables | Requests are ordinary requests | Supported. Not imported, with a WARNING: cookie parameters, callbacks, webhooks, `externalValue`, external `$ref`s, mutual TLS, OpenID Connect discovery, non-basic/bearer `http` schemes. Operation-/path-level `servers` replace `{{baseUrl}}` (INFO). 3.1 JSON Schema keywords outside the supported subset are ignored when generating examples. |
| Swagger 2.0 (JSON, YAML) | `swagger: "2.0"` | Rewritten to the OpenAPI 3 shape first (`host`/`basePath`/`schemes` -> servers, `body`/`formData` parameters -> request bodies, `definitions`/`parameters`/`responses`/`securityDefinitions` -> components, `$ref`s rewritten), then imported like OpenAPI 3 | as above | Supported. `x-example` and response `examples` by mime type are used; `x-nullable` is ignored. |
| HAR 1.2 | `log.entries[]` | Entries -> requests, `log.pages[]` -> folders, recorded responses -> examples | as above | Supported (importer `parseHar`). Credential values (Authorization, Cookie, Set-Cookie, API-key style headers/query/form parameters) are replaced by `{{placeholder}}` variables and never stored literally; binary bodies and oversized example bodies are dropped with a WARNING. |
| Insomnia v4 export | `_type: "export"` + `resources[]` | One collection per workspace, `request_group` -> folder, `request` -> request, base environment -> collection variables, sub-environments -> environments; `{{ _.name }}` -> `{{name}}` | as above | Supported (importer `parseInsomnia`). Nunjucks tags (`{% ... %}`), cookie jars, API specs, unit tests, gRPC/WebSocket requests are not converted (WARNING). Insomnia scripts are imported as text; the `insomnia.*` object is not available in the sandbox. Insomnia v5 YAML exports are not supported. |
| Postman Collection v1 | `requests[]` + `order`/`folders` | Rebuilt from `order`/`folders_order`; auth from the v2-style `auth` block or `currentHelper`/`helperAttributes`; scripts from `events` or `preRequestScript`/`tests`; `responses` -> examples | as above | Supported (importer `parsePostmanV1`). |
| Postman data dump | `collections[]` + `environments[]`/`globals` | Each collection goes to the v1 or v2 importer, environments and globals to theirs; everything is committed in one transaction | as above | Supported (importer `parsePostmanDump`). `headerPresets` are not imported (WARNING). A broken member is reported as an ERROR warning and skipped. |
| Aegis workspace file (`*.aegis-workspace.json`, `format: "aegis-workspace"`) | `format` field | Collections (Postman v2.1), environments and globals are parsed with the Postman importers and restored into a **new** workspace named after the file's workspace (`(imported)` suffix on conflict); existing workspaces are never changed | as above | Supported (this fixes the export-only gap: the file written by Workspace -> Export can be imported again). Secrets are only present when the export was made with "include secrets"; otherwise the variables come back empty. |
| Auto-detect (`kind: 'auto'`) | content, not the file name | Detects every family above plus Postman v2 collections / environments / globals; an Aegis backup is pointed at the backup restore | - | Supported. Choosing an explicit kind refuses a file of another family with a message naming the detected format. YAML is parsed only for OpenAPI/Swagger/Insomnia-shaped text (`yaml` package, YAML 1.2 core schema, bounded aliases, no custom tags, 64 MiB cap). |

<!-- WP-rows:begin — rows handed over by other work packages (WP-B settings keys, WP-A GraphQL body, ...) are inserted between these markers by the file owner; keep the table header above each block. -->

| Feature | Import | Export | Runtime | Status / notes |
| --- | --- | --- | --- | --- |
| `protocolProfileBehavior` `disableCookies`, `disableUrlEncoding`, `followOriginalHttpMethod`, `followAuthorizationHeader`, `removeRefererHeaderOnRedirect` | Mapped to `settings.disableCookies` / `encodeUrl` (inverted) / `followOriginalHttpMethod` / `followAuthorizationHeader` / `removeRefererHeaderOnRedirect` | Written back | Applied by the HTTP engine (`tests/integration/http-client.test.ts`, `tests/unit/http-runtime.test.ts`) | Supported |
| `digest`, `hawk`, `edgegrid`, `asap` auth | Type `custom` + `providerId` (Postman parameter names), WARNING | Original type and parameters restored | Executes at send time: Digest (MD5/SHA-256/-sess, qop auth/auth-int, 401 round trip), Hawk, Akamai EdgeGrid, ASAP | Supported. Digest and Hawk match published vectors; EdgeGrid is verified only against an independent in-test implementation (no public vector with a real secret exists). NTLM remains preserved but not executed. |
| OAuth 2.0 device authorization grant (RFC 8628); OAuth 1.0 RSA-SHA1/-SHA256/-SHA512 and HMAC-SHA512; JWT ES256/384/512 and PS256/384/512 | Parameters kept | Yes | Executes (verified with `node:crypto`) | Supported |
| GraphQL body | Imported as raw JSON `{query, variables}` + WARNING (native mapping not done on import) | Native `{mode: "graphql", graphql: {...}}` for requests in GraphQL body mode | Sent as a JSON POST (`application/json`) | Partial (no introspection / schema explorer) |
| Relative form-data / binary file paths | Kept only if safe and relative | Written back | Resolved ONLY inside Settings → General → Working directory | Supported |
<!-- WP-rows:end -->

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
- **Size limits:** JSON text larger than 256 MiB (configurable) is rejected before parsing (`IMPORT_TOO_LARGE`); YAML text larger than 64 MiB likewise; at most 200000 folders+items (operations for OpenAPI); folder depth at most 64; preserved extras nested deeper than 500 levels are rejected; OpenAPI example generation stops at 8 levels and 2000 values per example and ends every `$ref` cycle.
- **References are local-only.** OpenAPI/Swagger `$ref`s are resolved as JSON pointers inside the imported document only (`#/...`); pointer segments `__proto__`/`constructor`/`prototype` never resolve. External references, `externalValue` examples and OpenID Connect discovery URLs are reported, never fetched.
- **YAML** is parsed with the YAML 1.2 core schema: no custom tags (unknown tags stay plain text), no merge keys, at most 100 alias expansions per document (billion-laughs guard); the result is rebuilt through JSON so prototype keys cannot become own properties.
- **Secrets on export:** see Authentication and Variables above. `includeSecrets: true` must be an explicit choice by the caller.

## Not supported / known limitations

- NTLM and the legacy Akamai id are preserved but cannot be executed (Digest, Hawk, EdgeGrid and ASAP execute; see the table above).
- External scripts (`script.src`) are never downloaded.
- GraphQL requests are plain JSON POST bodies; there is no GraphQL-specific UI or introspection.
- Request-level `certificate` and `proxy` are preserved but not applied; `protocolProfileBehavior` keys other than the mapped ones (see the Requests table and the rows other work packages add) are preserved but not applied.
- Postman Flows, mock servers, monitors and Postman API payloads are not handled. Collection runner data files are a runner feature (CSV/JSON data files are supported by the runner, not by this package).
- OpenAPI/Swagger, HAR, Insomnia, Postman v1 and data dumps are import-only; there is no export back to those formats.
- Variable ids, header `type`/`system` flags and query `equals` flags are not preserved (they carry no behaviour).
- Multiple files in one form-data `src` array: only the first is imported (WARNING).
- Exports have not been validated against the official JSON schema or imported into the Postman application (see the honesty notes).
