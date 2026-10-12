# Import formats

File -> Import accepts, besides Postman Collection v2.0/v2.1 and Postman environments/globals:

| Format | Menu entry / import kind | Extensions | Importer |
| --- | --- | --- | --- |
| OpenAPI 3.0 / 3.1 | OpenAPI / Swagger… (`openapi`) | `.json`, `.yaml`, `.yml` | `parseOpenApiDocument` (`packages/postman/src/import-openapi.ts`) |
| Swagger 2.0 | OpenAPI / Swagger… (`openapi`) | `.json`, `.yaml`, `.yml` | `parseSwagger2Document` (`import-swagger2.ts`) |
| HAR 1.2 | HAR Archive… (`har`) | `.har`, `.json` | `parseHar` (`import-har.ts`) |
| Insomnia v4 export | Insomnia Export… (`insomnia`) | `.json`, `.yaml` | `parseInsomnia` (`import-insomnia.ts`) |
| Postman Collection v1 | Postman Collection… (`postman-collection` accepts v1 too) or `postman-v1` | `.json` | `parsePostmanV1` (`import-v1.ts`) |
| Postman data dump | Any Supported File… (`postman-dump`) | `.json` | `parsePostmanDump` (`import-dump.ts`) |
| Aegis workspace file | Any Supported File… (`aegis-workspace`) | `.aegis-workspace.json` | `importDocument` (`import-document.ts`) |
| Auto-detect | Any Supported File (auto-detect)… (`auto`, Ctrl+Shift+O) | all of the above | `detectImportFormat` + registry |

All of them share one pipeline (`packages/app/src/services/import-export.ts`): parse -> detect -> convert to `CollectionBundle` / `EnvironmentBundle` -> preview (counts + warnings) -> commit in **one SQLite transaction** -> rollback on any error. The Import dialog (`ImportModal.tsx`) lists every kind; dropping or pasting a file works for every format (pasted YAML is recognised by its content).

Principles that hold for every importer:

- **Nothing is fetched.** External `$ref`s, `externalValue` examples, external scripts, OpenID Connect discovery documents and Insomnia API specs are reported as WARNINGs; the referenced part stays empty. The importers never read other files from disk either.
- **Unsupported parts become warnings**, never silent drops. The preview shows INFO / WARNING / ERROR counts and the full list before anything is written.
- **Same limits as the Postman importer**: 256 MiB of JSON (64 MiB of YAML), 200 000 items/operations, 64 folder levels, 500 levels inside preserved extras, prototype-pollution keys (`__proto__`, `constructor`, `prototype`) dropped everywhere, file references validated with `checkImportedFilePath` (absolute paths, `..`, UNC, `~`, `file:` URLs are never stored).
- **YAML** is parsed with the `yaml` package using the YAML 1.2 core schema only: no custom tags (`!!js/function` stays a string), no merge keys, bounded alias expansion (billion-laughs guard), and the parsed value is rebuilt through JSON.

## OpenAPI 3.0 / 3.1 and Swagger 2.0

| OpenAPI | Aegis | Notes |
| --- | --- | --- |
| `info.title` / `info.description` / `info.version` | Collection name / description (`API version: x` appended) | |
| `servers[0].url` (server variables substituted with their `default`, else first `enum` value) | Collection variable `baseUrl`; every request URL starts with `{{baseUrl}}` | Other servers are kept in `sourceMetadata.openapi.servers` (INFO). A relative server URL is a WARNING. Operation- or path-level `servers` replace `{{baseUrl}}` for that request (INFO). |
| `tags` (declared order, then first-seen) | One folder per tag that has operations; untagged operations stay at the root | The first tag of an operation decides its folder. |
| Operation | Request named `summary` > `operationId` > `METHOD /path` | `description` + "DEPRECATED operation." for deprecated ones; `metadata.openapi = { operationId, path, method, tags, deprecated, extensions }`. |
| `/path/{param}` | `/path/:param` + path variable row (`example` / `default` / first `enum` as the value) | A template inside a segment (`/{a}.json`) becomes `{{a}}` with a WARNING. |
| Query / header parameters | Rows, **enabled only when `required: true`**, description kept | Values come from `example`, `examples`, `default`, `enum[0]`; generic placeholders (`"string"`, `{}`) are left empty. Cookie parameters are not supported (WARNING). |
| `requestBody.content` | `application/json` (or `+json`) preferred, then `x-www-form-urlencoded`, `multipart/form-data`, else the first media type | A `Content-Type` header is added. JSON bodies come from `example` > first `examples` entry > generated from `schema`; urlencoded/multipart from the schema's properties (`format: binary` / `contentMediaType` -> file field, `encoding[].contentType` kept). Other media types use a string example if present, otherwise an empty body with a WARNING. |
| `responses` | Up to 10 examples per request (`200 description`, status text from a built-in table), response headers, `Content-Type`; an `Accept` header is added to the request | `links` are kept in example metadata. |
| `components.securitySchemes` + `security` | Collection auth from the first global requirement; operations whose `security` differs get request-level auth, `security: []` -> no auth | `http basic` -> `{{username}}`/`{{password}}`, `http bearer` / `openIdConnect` -> `{{bearerToken}}`, `apiKey` (header/query) -> `{{apiKey}}`, `oauth2` -> authorization code > client credentials > password > implicit (`{{clientId}}`, `{{clientSecret}}`, scopes from the requirement). Placeholder variables are created as collection variables; secret ones are marked secret. `mutualTLS`, `apiKey in: cookie`, other `http` schemes -> custom/none with a WARNING. |
| `$ref` | Local JSON pointers only (`#/components/...`) | Cycles end the branch (`children: []`), dangling and external refs are WARNINGs. |
| `callbacks`, `webhooks`, `externalDocs`, `x-*` | Not converted (WARNING) / kept in metadata | |

Example generation from schemas: `example` / `examples[0]` / `default` / `enum[0]` win; otherwise one value per type (`"string"`, format-aware strings for `date-time`, `email`, `uuid`, `uri`, ..., `0`, `true`, `null`, one array item, every property). `allOf` is merged, `oneOf`/`anyOf` use their first alternative, `type: [..., "null"]` uses the first non-null type. Limits: 8 levels deep, 2000 values per example, 200 properties per object, each limit reported once as INFO.

Swagger 2.0 is rewritten into the OpenAPI 3 shape before conversion: `host`/`basePath`/`schemes` -> `servers` (one per scheme), `in: body` -> `requestBody` with the operation's (or global) `consumes[0]`, `in: formData` -> urlencoded or multipart body (multipart when a `type: file` parameter or a multipart `consumes` exists), `definitions`/`parameters`/`responses`/`securityDefinitions` -> `components` with `$ref`s rewritten, `produces[0]` -> response content type, `examples[mime]` -> response example, `x-example` -> example, OAuth2 `implicit`/`password`/`application`/`accessCode` -> the matching flows.

## HAR 1.2, Insomnia v4, Postman v1, Postman data dump

These importers register themselves in `packages/postman/src/register-importers.ts` and are documented row by row in [the compatibility matrix](../postman-compatibility/compatibility.md#other-import-formats). Security notes that apply to them: HAR credential values (Authorization, Cookie, Set-Cookie, API-key style parameters) are replaced by `{{placeholder}}` variables and never stored literally; Insomnia Nunjucks tags are kept verbatim with a warning; data dumps report a broken member as an ERROR warning and import the rest.

### Function signatures (`@aegis/postman`)

All four are synchronous, accept JSON text or an already parsed object, share `ImportLimitOptions` (`maxBytes` 256 MiB, `maxItems` 200 000, `maxDepth` 64, `onProgress`), report through the same `WarningCollector` (bounded, source values truncated) and throw `AppError` `IMPORT_INVALID` (with `details.warnings`) or `IMPORT_TOO_LARGE`. Shared helpers live in `import-common.ts` (`CredentialPlaceholders`, `safeFilePath`, `splitRequestUrl`, `stripUrlCredentials`, `flattenVariables`, `rawLanguageFromMime`).

```ts
parseHar(input: string | object, options?: ParseHarOptions): ParseHarResult
// ParseHarOptions = ImportLimitOptions & { name?: string; maxExampleBodyBytes?: number /* 1 MiB */ }
// ParseHarResult  = { bundle: CollectionBundle; warnings; stats; format: 'har-1.2' }

parseInsomnia(input: string | object, options?: ImportLimitOptions): ParseInsomniaResult
// { collections: CollectionBundle[] /* one per workspace */; environments: EnvironmentBundle[] /* sub-environments */; warnings; stats; format: 'insomnia-v4' }

parsePostmanV1(input: string | object, options?: ImportLimitOptions): ParseV1Result
// { bundle: CollectionBundle; warnings; stats; format: 'collection-v1' }   (bundle.postmanSchemaVersion = '1.0.0')

parsePostmanDump(input: string | object, options?: ImportLimitOptions): ParseDumpResult
// { collections: CollectionBundle[]; environments: EnvironmentBundle[]; globals?: EnvironmentBundle; warnings; stats /* aggregate */; format: 'postman-dump' }

convertInsomniaTemplate(w: WarningCollector, text: string, path: string): string   // `{{ _.x }}` -> `{{x}}`
```

Through `importDocument()` the registry maps them to `ImportedDocuments` with `format` `har` (`schemaVersion` `1.2`, name = file name without `.har`), `postman-v1` (`1.0.0`), `insomnia` (`4`; name = the collection name, or `Insomnia export (N collections, M environments)`) and `postman-dump` (`1`; `globals` = the dump's global variables). Every bundle round-trips through `exportPostmanCollection` -> `validatePostmanV21Structure` -> `parsePostmanCollection` -> `compareCollectionBundles` with no differences (tested).

### HAR 1.2 (`import-har.ts`)

| HAR | Aegis | Notes |
| --- | --- | --- |
| `log.pages[]` | One folder per page (`title`, else `id`); entries without / with an unknown `pageref` stay at the top level (INFO) | Duplicate page ids are merged into the first (WARNING). |
| `log.entries[].request` | One request named `METHOD /path` (Postman style); `comment` -> description | Collection name = `options.name`, else the first page title, else `HAR import`; the description names creator/browser and the entry count. |
| `url` | Base URL + query rows (raw, not decoded) + `#fragment` (`metadata.urlHash`) | `user:password@` is removed (WARNING). `queryString[]` is used only when the URL has no query. |
| `headers[]` | Header rows | HTTP/2 pseudo-headers (`:method`, ...) and `Host`/`Content-Length` are dropped (one INFO each with a count). |
| `Authorization`, `Cookie`, `Proxy-Authorization`, `X-Api-Key`, any name matching the security package's sensitive-key patterns (`*token`, `*secret`, `password`, ...) in headers, query, form params and **JSON body fields** (request and response) | Value replaced by `{{har_<name>}}`; one **empty**, secret-flagged collection variable per distinct value (`har_authorization_2` for a second value); INFO per replacement without the value | The literal credential is never stored (bundle or warnings). A JSON body is re-serialised compactly only when something was replaced. Non-JSON text bodies (XML, plain text) are imported as recorded. |
| `cookies[]` (request/response) | Not imported (one INFO with the count); the `Cookie` placeholder covers them | |
| `postData` `application/x-www-form-urlencoded` | urlencoded rows from `params[]`, else decoded from `text` | |
| `postData` `multipart/form-data` | form-data rows; `fileName` -> file row with `filePath` only when `checkImportedFilePath` accepts it, `contentType` kept | Multipart without `params[]` is imported as raw text (WARNING). |
| `postData` other `mimeType` + `text` | Raw body; `rawLanguage` from the media type (json/xml/html/javascript/text) | Non-textual types are WARNINGs. |
| `response` | One example `"<status> <statusText>"`, headers (Set-Cookie placeholdered), `content.text` (base64 decoded for textual types), language from `content.mimeType` | Status 0 (blocked/aborted) -> no example (INFO); binary bodies -> empty body (INFO); bodies above `maxExampleBodyBytes` -> empty (WARNING). |
| `timings`, `cache`, `time`, `serverIPAddress`, `_*` | Not imported (one INFO) | |

### Insomnia v4 export (`import-insomnia.ts`)

| Insomnia | Aegis | Notes |
| --- | --- | --- |
| `workspace` | Collection (name, description); orphaned resources (missing parent, parent cycles) join the first collection's root with a WARNING; a file without a workspace gets `Insomnia import` | `scope: design` -> INFO (the API spec is not imported). |
| `environment` with `parentId` = workspace (base environment) | Collection variables (nested objects flattened to `a.b` keys, arrays as JSON text) | Values that look like credentials (`*token`, `*secret`, `password`, ...) are marked secret. |
| `environment` with `parentId` = base environment (sub-environment) | `EnvironmentBundle` | `isPrivate` -> INFO. Environments without a base -> stand-alone (WARNING). |
| `request_group` | Folder (name, description, `environment` -> folder variables, `authentication`, scripts); siblings ordered by `metaSortKey` | |
| `request` | Request: `method`, `url` (query merged with `parameters[]`), `headers[]`, `description`, `settingFollowRedirects` on/off -> `followRedirects` | `settingSendCookies`, `settingStoreCookies`, `settingEncodeUrl`, `settingRebuildPath`, `settingDisableRenderMacro` -> INFO only. |
| `{{ _.name }}` / `{{ name }}` | `{{name}}` everywhere (URL, headers, params, bodies, auth, environments) | `{% tag %}` and `{{ x \| filter }}` are kept verbatim with a WARNING (not resolved). |
| `body.mimeType` `application/x-www-form-urlencoded` / `multipart/form-data` | urlencoded / form-data rows; `type: file` -> `fileName` validated like every file reference | |
| `body.mimeType` `application/graphql` | Raw JSON `{query, variables}` + `metadata.graphqlBody` (exported back as a Postman `graphql` body) | A `Content-Type: application/json` header is added when missing. |
| `body.fileName` without `text` | Binary body (path validated) | |
| other `body.text` | Raw body; `rawLanguage` from the media type; `Content-Type` header added when missing | |
| `authentication` `basic`, `bearer` (prefix must be empty/Bearer), `apikey` (`addTo` -> `in`), `oauth2` (`grantType` authorization_code[+pkce]/client_credentials/password/implicit, `credentialsInBody` -> `client_authentication`), `oauth1`, `iam` -> `awsv4` | Native auth with Postman parameter names | `digest`, `hawk`, `asap`, `ntlm` -> custom providers (digest/hawk/asap executable); `netrc` and unknown types -> no auth (WARNING, parameters dropped); `disabled: true` -> inherit (WARNING). |
| `preRequestScript` / `afterResponseScript` | pre-request / test scripts, source unchanged | WARNING: `insomnia.*` calls may need to become `pm.*`. |
| `cookie_jar` | Not imported (INFO with count) | |
| `api_spec`, `unit_test*`, `websocket_*`, `grpc_request`, `proto_*`, `mock_*`, `*_certificate` | Skipped with a WARNING naming the resource | |

### Postman Collection v1 (`import-v1.ts`)

| v1 | Aegis | Notes |
| --- | --- | --- |
| `id`, `name`, `description`, `variables[]`, `auth`, `events[]` | `uid`, name, description, collection variables, collection auth, scripts | `postmanSchemaVersion` `1.0.0`; exported as v2.1 (INFO). |
| `folders_order[]` / `order[]` (collection and folder level), `folders[].folders_order` for nesting | Tree in that order (folders first, then requests) | Folders/requests not referenced by any order list are appended to their `folder` parent or the root (INFO); unknown ids, duplicate references and duplicate ids are WARNINGs; cycles cannot recurse. |
| `request.url` | Base URL + query rows (`queryParams[]` when present, else parsed from the URL) + `#fragment` | `user:password@` removed (WARNING). |
| `headerData[]`, else the `headers` string | Header rows (enabled flags and descriptions kept) | |
| `pathVariableData[]`, else `pathVariables{}` | Path variable rows | |
| `dataMode` `raw` + `rawModeData` + `dataOptions.raw.language` | Raw body (language from `dataOptions`, else from the Content-Type header) | |
| `dataMode` `params` / `urlencoded` + `data[]` | form-data (file `value` validated) / urlencoded rows | |
| `dataMode` `graphql` + `graphqlModeData` | Raw JSON `{query, variables}` + `metadata.graphqlBody` | |
| `dataMode` `binary` | Binary body; `rawModeData` as the file path when safe | |
| `auth` (v2-shaped) | Same conversion as the v2 importer | Takes precedence over the helper fields. |
| `currentHelper` + `helperAttributes` (`basicAuth`, `bearerAuth`, `apikeyAuth`, `awsSigV4`, `oAuth1`, `oAuth2`, `digestAuth`, `hawkAuth`, `ntlmAuth`) | Native auth (`basic`, `bearer`, `apikey`, `awsv4`, `oauth1`, `oauth2`) or custom provider (`digest`, `hawk`, `ntlm`) with the attributes as parameters | `normal`/none -> inherit. |
| `events[]`, else `preRequestScript` / `tests` strings | Scripts | |
| `description` + `descriptionFormat` (`html`/`markdown`) | Description with the Postman description type (`text/html`, `text/markdown`) | |
| `responses[]` (`responseCode.code/name`, `headers[].key|name`, `text`, `language`, `id`) | Examples | `requestObject`, `cookies`, `time` are not imported. |
| `timestamp`, `owner`, `public`, `collectionId`, `time`, ... | Not imported; unknown fields are INFOs | |

### Postman data dump (`import-dump.ts`)

`{ version, collections[], environments[], globals, headerPresets }` (Settings -> Data -> Export). Every `collections[i]` is handed to the v2 importer (`info` + `item`) or the v1 importer (`requests[]`); `environments[i]` with a `values[]` array to `parsePostmanEnvironment`; `globals` (an array of variables or an object with `values`) to `parsePostmanGlobals`. Warnings of the members are prefixed with their path (`collections[1].requests[0].url`). A member that fails with `IMPORT_INVALID` becomes an ERROR warning and is skipped; the dump itself fails only when nothing at all could be imported. `IMPORT_TOO_LARGE` propagates (the item limit applies to the dump and inside each member). `headerPresets` are not imported (INFO).

## Aegis workspace file

`Workspace -> Export` writes `{ format: 'aegis-workspace', version: 1, workspace, collections[], environments[], globals }` where collections are Postman v2.1 documents and environments/globals Postman environment documents. Importing the file (kind `aegis-workspace` or auto-detect) parses those with the Postman importers and restores everything into a **new** workspace named after the file's workspace (`"Name (imported)"` on a name clash); existing workspaces are never modified. Secrets are only present when the export was made with "include secrets" (policy-gated and audited); otherwise secret variables come back empty. The backup restore refuses a workspace file with a pointer to this importer, and the auto-detect refuses a backup with a pointer to the restore.

## Adding an importer

1. Write `parseX(doc, options)` in `packages/postman/src/import-x.ts` that returns `{ bundle | collections, warnings, stats }` using `WarningCollector`, `cloneAt`/`collectExtras` and `checkImportedFilePath` like the Postman importer.
2. Add the detection rule to `detectImportFormat` (`detect.ts`) and the family to `ImportFormat`.
3. Register it: `registerDocumentImporter('x', (doc, o) => singleCollection('x', parseX(doc, o)))` (see `register-importers.ts`). An unregistered family is reported as "not available in this build" instead of being ignored.
4. Add the kind to `ImportSourceKind` / `ImportDocumentKind` (`packages/core/src/api.ts`), `EXPECTED`/`FILTERS` in `import-export.ts`, the IPC enum, `IMPORT_KINDS` in `lib/import-helpers.ts` and a fixture-driven test.
