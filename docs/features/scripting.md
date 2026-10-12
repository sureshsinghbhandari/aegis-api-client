# Scripting (pre-request and test scripts)

Aegis runs Postman-style JavaScript before a request (pre-request) and after the response (tests) inside an
isolated sandbox, and exposes a Postman-compatible `pm.*` API.

Package: `@aegis/scripting` (`packages/scripting`). Single entry point:

```ts
import { runScript } from '@aegis/scripting';
const result = await runScript(input); // ScriptRunInput -> ScriptRunResult (see packages/core/src/scripting.ts)
```

`runScript` never rejects because of the script: errors, timeouts, out-of-memory and cancellation come back as
`result.ok === false` with `result.error.code` of `SCRIPT_ERROR`, `SCRIPT_TIMEOUT` or `SCRIPT_MEMORY`. Console output,
test results and variable changes made before the failure are still returned. It only throws `TypeError` for malformed
input (a programming error). Chaining scripts (collection -> folder -> request) is the job of the application layer.

## Status legend

Every status below is backed by an automated test (`tests/unit/scripting-*.test.ts`, `tests/security/script-sandbox.test.ts`).

- ✅ supported and tested
- 🟡 supported with documented differences
- 🔴 not supported (the script gets a clear error, or the name is simply undefined)

## Supported `pm.*` surface

| Area | API | Status | Notes |
| --- | --- | --- | --- |
| Variables | `pm.variables.get/set/unset/has/clear/toObject/replaceIn` | ✅ | `get`/`has`/`toObject` resolve local > iteration data > environment > collection > globals; `set`/`unset`/`clear` only touch the local scope |
| | `pm.environment`, `pm.collectionVariables`, `pm.globals`: `get/set/unset/has/clear/toObject/replaceIn` | ✅ | `replaceIn` resolves with the full precedence chain (not just its own scope) |
| | `pm.environment.name` | ✅ | The active environment's name (`ScriptInfo.environmentName`); `undefined` when no environment is active. Read-only |
| | `{{$guid}}`, `{{$randomInt}}`, ... in `replaceIn` | ✅ | Resolved by the host through the shared dynamic-variable registry; unknown names are left untouched |
| | Values are strings | 🟡 | Objects are `JSON.stringify`-ed, everything else `String()`-ed on `set`; `get` always returns a string |
| | `pm.iterationData.get/has/toObject/toJSON/unset` | ✅ | No `set`/`clear` (read-mostly, like Postman) |
| Request | `pm.request.url` (string-assignable, `toString/getHost/getPath/getQueryString/getPathWithQuery/getRemote/update`, parts, `query` list) | ✅ | Untouched URLs round-trip byte for byte; `{{variables}}` are never expanded or encoded |
| | `pm.request.method` get/set, `headers` (`get/has/add/upsert/remove/each/toObject/all/...`), `getHeaders()`, `addHeader/removeHeader`, `toJSON()` | ✅ | Disabled headers are kept (and returned with `enabled: false`) but invisible to `get/has/toObject` |
| | `pm.request.body` (`mode`, `raw`, `urlencoded`, `formdata`, `options.raw.language`, `update`, `toString`) | ✅ | Final snapshot is returned in `result.request`; `binary`/file parts are carried through unchanged |
| | `pm.request.auth` (`type`, `auth[type]` list, `parameters()`, `toJSON()`) | 🟡 | Read-only, frozen view of the request's own auth (`ScriptRunInput.auth`; `none` reads as `noauth`, `undefined` when absent). Credential parameters (`password`, `token`, `clientSecret`, ..., sensitive-looking keys for `custom`, and any value that is a known secret) read as `[REDACTED]`. Inherited auth is not resolved |
| | Mutating the request in a **test** script | 🟡 | Allowed inside the script, but ignored: `result.request` equals the input |
| Response (test phase) | `code`, `status`, `responseTime`, `responseSize`, `headers`, `cookies`, `text()`, `json()`, `reason()`, `size()` | ✅ | `json()` throws `Unable to parse the response body as JSON: ...` on invalid JSON. `pm.response` is `undefined` in pre-request scripts |
| | `pm.response.to.have.status/header/body/jsonBody` and `.to.be.ok/success/error/info/redirection/clientError/serverError/accepted/badRequest/unauthorized/forbidden/notFound/rateLimited/json/withBody`, `.to.not...` | ✅ | `body(string)` is an exact match; `body(regex)` tests the regex |
| | `pm.response.to.have.jsonSchema(schema, options?)` | ✅ | Full JSON Schema draft-07 (and draft-06 via `$schema`) through the bundled ajv 8: `$ref`/`definitions`, `format` (see "Formats"), `additionalProperties`, `contains`, ... `options` are ajv options (defaults: `allErrors`, `strict: false`, `validateFormats`). Schemas declaring draft-04 in `$schema` are validated with tv4. Invalid schemas (unresolvable `$ref`, unknown `type`) fail the assertion with `Invalid JSON schema: ...`. Draft 2019-09/2020-12 are not bundled |
| Cookies | `pm.cookies.get/has/toObject/...` | ✅ | `httpOnly` cookies are never exposed |
| | `pm.cookies.jar()` `get(url, name)`, `getAll(url)` | ✅ | Read the workspace jar for `url` through `ScriptHost.cookieJar`; callback `(err, value)` or promise. `httpOnly` cookies are filtered twice (host and sandbox). Without a host jar (other embedders) reads fall back to the request's cookies |
| | `pm.cookies.jar()` `set(url, name, value)` / `set(url, {name|key, value, domain?, path?, expires?, maxAge?, secure?, sameSite?})`, `unset(url, name)`, `clear(url)` | ✅ | Writes go to the workspace jar (visible in Settings -> Cookies and sent with the next request, including the current one when done in a pre-request script). Scripts cannot create (`httpOnly: true` is rejected), replace or remove an `httpOnly` cookie; `clear` leaves them. Every write is audited (`SCRIPT_COOKIE_WRITE`, names only) and reported in `ExecutionResult.warnings` ("Cookies changed by script ..."). Without a host jar the write rejects with an error |
| Info / control | `pm.info.eventName/iteration/iterationCount/requestName/requestId` | ✅ | |
| | `pm.execution.setNextRequest(name \| null)`, `pm.execution.skipRequest()` | ✅ | `skipRequest` is pre-request only (throws elsewhere). `result.nextRequest` is `undefined` unless called |
| | `pm.execution.location` | 🟡 | Array with the script origin; `.current` is the origin string |
| Tests | `pm.test(name, fn)`, `pm.test.skip`, `pm.test.index()` | ✅ | `fn` may be sync, return a promise, or take a `done` callback. Failures never abort the script. A test whose promise never settles is reported as failed. Skipped tests are `passed: true, skipped: true` |
| | `pm.expect` and global `expect` (chai 6) | ✅ | Chai's own messages (`expected 1 to equal 2`); misspelled properties throw `Invalid Chai property` |
| Network | `pm.sendRequest(urlOrRequest, callback?)` | ✅ | Callback `(err, res)` or a returned Promise; `res` has `code/status/headers/responseTime/responseSize/text()/json()/cookies/to.have.status(...)`. Variables in the URL/body are **not** interpolated (same as Postman). Every call writes `-> METHOD url` and `<- status reason METHOD url (ms, bytes)` (or `<- ... failed after N ms: error`) to the console with sensitive query parameters and secrets masked |
| | `pm.sendRequest({ auth })` | 🟡 | `basic`, `bearer`, `apikey` (`in: 'header'` default or `'query'`) and `noauth`, given flat (`{ type: 'bearer', token }`) or Postman style (`{ type, bearer: [{ key, value }] }`). Applied inside the sandbox (header upsert / query append). Other types throw |
| Visualizer | `pm.visualizer.set(template, data?, options?)`, `pm.visualizer.clear()` | ✅ | Handlebars 4 (bundled) renders inside the sandbox; the last `set` wins, `clear` removes it. Template and output are capped at 2 MiB (`RangeError`). The HTML leaves the sandbox with `<script>`/`<iframe>`/event handlers/`javascript:` URLs stripped and secrets redacted (`ScriptRunResult.visualizer`, passed through as `ExecutionResult.visualizer`); the Visualize tab renders it inside a sandboxed iframe with a strict CSP, so **no script ever runs** (CSS is allowed). Handlebars blocks prototype access (`{{constructor}}` renders empty) |
| Legacy | `postman.setEnvironmentVariable/getEnvironmentVariable/clearEnvironmentVariable/setGlobalVariable/getGlobalVariable/clearGlobalVariable/setNextRequest/getResponseHeader` | ✅ | |
| | `tests["name"] = bool`, `responseBody`, `responseCode`, `responseHeaders`, `responseTime` | ✅ | The response globals exist only in the test phase |
| Console | `console.log/info/warn/error/debug` (+ `dir`, `trace`) | ✅ | Objects are JSON-stringified (cycle safe, errors print `name: message`); `%s %d %i %f %j %o %O %%` supported |
| Async | top-level `await` and `return`, `async/await`, promises, `setTimeout/clearTimeout`, `queueMicrotask` | ✅ | The run finishes when all timers, requests and promise jobs are done |
| | `setInterval`, `setImmediate` | 🔴 | Undefined |
| | Floating (never awaited) promise rejections | 🟡 | Rejections that reach the script's own promise chain (awaited code, `pm.test` bodies, `pm.sendRequest` callbacks) are reported. A rejected promise that nothing awaits is silently ignored: QuickJS offers no rejection tracker to the host |
| Built-ins | `atob`, `btoa`, `TextEncoder`, `TextDecoder` (UTF-8) | ✅ | |
| | `URL`, `URLSearchParams` | 🟡 | WHATWG subset: parsing, getters, `searchParams`, relative resolution against a base. No IDNA/punycode, no percent-encoding normalisation, limited setters |
| Libraries | `require(name)` and the globals `_`, `CryptoJS`, `moment`, `tv4`, `xml2Json`, `Buffer` | ✅ | See "Libraries" below. Only the allow-list loads; anything else (`fs`, `child_process`, `http`, `cheerio`, `postman-collection`, relative paths, ...) throws `Cannot find module` (`code: 'MODULE_NOT_FOUND'`) or `... is not available in the Aegis script sandbox` |
| Not available | `pm.require` | 🔴 | Throws (Postman package library). Use `require()` for the bundled libraries |
| | `cheerio` | 🔴 | Accessing the name throws `cheerio is not available in the Aegis script sandbox` |
| | `fetch`, `XMLHttpRequest`, `WebAssembly`, `process`, `crypto`, `global`, `performance`, timers beyond the above | 🔴 | Undefined (use `pm.sendRequest`; `uuid` and `CryptoJS` get randomness from a host-backed shim that only the libraries receive) |

## Libraries

Postman's scripting libraries are bundled at build time (esbuild, MIT licences, `devDependencies` only; see
`scripts/build-sandbox-libs.mjs` and the committed `packages/scripting/src/generated/libs-bundle.ts`) and
evaluated **inside the sandbox on first use**, so scripts that do not need them pay nothing. Every status below is
covered by `tests/unit/scripting-libs.test.ts`.

| `require()` name | Global | Status | Notes |
| --- | --- | --- | --- |
| `lodash` | `_` | ✅ | lodash 4 (full build, incl. `_.template`, chaining, `noConflict`) |
| `moment` | `moment` | ✅ | moment 2 with the `en` locale only (other locales are not bundled) |
| `crypto-js` | `CryptoJS` | ✅ | crypto-js 4.2 full build: `MD5/SHA1/SHA224/SHA256/SHA384/SHA512/SHA3/RIPEMD160`, `Hmac*`, `PBKDF2`, `EvpKDF`, `AES/DES/TripleDES/Rabbit/RC4/Blowfish`, `enc.*`, `mode.*`, `pad.*`, `format.*`, `lib.WordArray.random` (host randomness). Test vectors from RFC 1321/3174/4231/6234 pass. As in upstream, `SHA3` is Keccak (pre-FIPS padding) |
| `uuid` | - | ✅ | uuid 14: `v1/v3/v4/v5/v6/v7`, `NIL`, `MAX`, `parse`, `stringify`, `validate`, `version` (RFC 4122 v3/v5 vectors pass) |
| `ajv` | - | ✅ | ajv 8 class with the draft-06 meta-schema and the formats below pre-registered (`new Ajv({...})`, `compile`, `validate`, `addSchema`, `addFormat`, `addKeyword`, `errorsText`). Unknown formats are ignored unless `strict: true` |
| `tv4` | `tv4` | ✅ | tv4 1.3 (draft-04) with the formats below pre-registered |
| `xml2js` | `xml2Json` | 🟡 | A facade over fast-xml-parser 5 that produces xml2js-shaped objects: attributes under `$`, text of mixed nodes under `_`, values kept as strings, repeated elements as arrays; `xml2Json` = `explicitArray: false`, `parseString`/`parseStringPromise`/`Parser` default to `explicitArray: true`; options `explicitArray`, `explicitRoot`, `ignoreAttrs`, `attrkey`, `charkey`, `trim`, `normalizeTags`; `Builder.buildObject`. Malformed XML throws `Invalid XML`. CDATA/comments/namespaces follow fast-xml-parser, not xml2js, in edge cases; DOCTYPE entity expansion is bounded by fast-xml-parser |
| `chai` | `expect` | ✅ | The same chai 6 instance as `pm.expect` |
| `atob`, `btoa` | `atob`, `btoa` | ✅ | |
| `buffer` | `Buffer` | 🟡 | Pure-JS subset of Node's `Buffer` (a `Uint8Array` subclass): `from` (string with `utf8/hex/base64/base64url/latin1/binary/ascii/ucs2/utf16le`, arrays, `ArrayBuffer`, views, `{type:'Buffer',data}`), `alloc/allocUnsafe` (max 64 MiB), `isBuffer`, `isEncoding`, `byteLength`, `concat`, `compare`, `toString(encoding, start, end)`, `toJSON`, `equals`, `compare`, `slice/subarray`, `write`, `fill`, `indexOf/includes`, `read/writeUInt8/16/32 BE/LE`, `readInt8/16/32`. No `readBigInt64`, floats, `swap*`, `transcode` |
| `csv-parse/lib/sync` (function), `csv-parse/sync` (`{ parse }`) | - | 🟡 | In-house RFC 4180 parser: `delimiter`, `quote`, `escape`, `comment`, `columns` (true | names), `skip_empty_lines`, `trim/ltrim/rtrim`, `relax_column_count`, `from_line`, `to_line`, `bom`, `cast(value, context)`; throws `Invalid Record Length` / unterminated-quote errors. Other csv-parse options are ignored |
| `cheerio`, `postman-collection`, Node built-ins (`fs`, `path`, `util`, `url`, `events`, `stream`, ...) | - | 🔴 | Throw. `require` resolves names only; no relative or absolute paths |

Formats (registered for ajv's `format` keyword and tv4): `date`, `time`, `date-time`, `iso-time`, `iso-date-time`, `duration`,
`email`, `hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uri-template`, `url`, `uuid`, `regex`, `json-pointer`,
`relative-json-pointer`, `byte`, `binary`, `password`, `int32`, `int64`, `float`, `double` (in-house validators; `ajv-formats`
is not bundled, so `idn-*`, `iri*` are unknown).

Library footprint: evaluating a bundle costs roughly 10-80 ms and 0.3-1 MB inside the sandbox and counts against the
script's time and memory budgets (all eight together need about 3 MB). A library that fails to load (for example under a
tiny memory limit) throws `The "<name>" library could not be loaded`; the sandbox stays healthy.

## Limits

| Limit | Default | Behaviour |
| --- | --- | --- |
| Wall-clock time (`limits.timeoutMs`) | 5000 ms | One budget for CPU time **and** async waits (`pm.sendRequest`, timers, promises). CPU-bound loops are stopped by the interpreter's interrupt handler; in-flight `pm.sendRequest` calls are aborted through their `AbortSignal`. Result: `SCRIPT_TIMEOUT` |
| Memory (`limits.memoryLimitBytes`) | caller supplied (64 MiB if invalid) | Budget for what the script allocates (the fixed prelude/chai footprint is added on top). Result: `SCRIPT_MEMORY` |
| Stack (`limits.maxStackSizeBytes`) | 128 KiB (clamped to 32-256 KiB) | See "Native stack" below. Result of runaway recursion: `SCRIPT_ERROR` (`InternalError: stack overflow`) |
| `pm.sendRequest` calls | 20 (`limits.maxSendRequests`) | Calls over the cap fail with an error naming the limit |
| `pm.cookies.jar()` operations | 200 per run (`MAX_COOKIE_OPS`) | Reads and writes; operations over the cap reject with an error naming the limit. URL ≤ 8 KiB, name/domain/path ≤ 4 KiB, value ≤ 64 KiB |
| Host randomness (`uuid`, `CryptoJS.lib.WordArray.random`) | 100 000 calls per run, 64 KiB per call | Over the cap: error / `RangeError` |
| `pm.visualizer` | 2 MiB template and 2 MiB rendered HTML (`MAX_VISUALIZER_CHARS`) | `RangeError`; the previous visualizer output is kept |
| Library loading | one evaluation per library per run | While a bundle is evaluated the QuickJS stack limit is raised to the clamped maximum (256 KiB, still safe for the host); it is restored right after |
| Console | 1000 entries, 16 KiB per message | The last entry becomes a "truncated" warning |
| Tests | 5000 | Extra tests still run but are not recorded (a console warning is added) |
| Script source | 2 MiB, bracket nesting depth 256 | Rejected before parsing with `SCRIPT_ERROR` |
| Pending timers | 1000 | `setTimeout` throws beyond that |
| Cancellation (`input.signal`) | - | Aborting stops the script with `SCRIPT_ERROR` / `Script cancelled` and aborts in-flight requests |

Cancellation caveat: the sandbox runs on the caller's thread. While a purely synchronous script is spinning, the event loop
cannot deliver the `abort` event, so such a script is only stopped by the timeout (the signal is polled from the
interrupt handler, so a signal that flips while the script runs is honoured). Scripts that wait (`await`, timers,
`pm.sendRequest`) are cancelled immediately. Hosts that need hard cancellation of CPU-bound scripts should run `runScript`
in a utility process.

## Security model

- **Engine**: QuickJS compiled to WebAssembly (`quickjs-emscripten`). A fresh runtime and context is created for every run
  and disposed in a `finally`, even on error, timeout or abort. No state (globals, prototypes, timers) survives a run.
  The WASM module itself is instantiated once and shared.
- **No ambient authority**: the context has no `process`, `require`, `import()` loader, filesystem, network, `Buffer`,
  Electron or IPC objects, and no `std`/`os` modules. User code is never evaluated in the host realm (no `eval`,
  `new Function`, `vm` or worker threads with Node access on the host side). `Function(...)`, `constructor.constructor(...)`,
  `(function(){return this})()` and `eval` only reach the guest's own global object. A test asserts the exact allow-list
  of global names.
- **Narrow bridge**: the guest receives nine host functions (log, dynamic variable lookup, `setTimeout`/`clearTimeout`,
  `sendRequest`, uncaught-error report, `cookieJar`, `requireLib`, `randomBytes`). They are captured in the prelude's closure
  and are not reachable by name from user code. Every argument is treated as untrusted (type-checked, size-capped,
  JSON-parsed and re-validated). Nested requests go through `ScriptHost.sendRequest`, which must enforce the same
  policies as normal requests; cookie writes go through `ScriptHost.cookieJar`, which must hide `httpOnly` cookies and audit.
- **Libraries**: `requireLib` only evaluates the committed, generated bundles (`generated/libs-bundle.ts`, allow-list keyed
  by name) at the guest's global scope and hands the resulting factory to the prelude, which calls it with a single
  injected object: a `crypto.getRandomValues` shim backed by `node:crypto` (`randomBytes`, capped). Libraries never see
  `host`, Node or Electron; `Function('return this')()` inside a bundle is the guest global. Loading all libraries adds no
  global names (a test asserts the exact allow-list before and after). The `require()` function is guest-side JavaScript
  with a fixed name table; it never touches the host for names outside the bundle allow-list.
- **Visualizer**: Handlebars runs inside QuickJS (its generated code is guest code). The HTML is cut to 2 MiB, secrets are
  redacted, `sanitizeHtmlForPreview` strips scripts/handlers/`javascript:` URLs, and the renderer must still show it only
  through `buildPreviewDocument` in a sandboxed iframe (CSP `default-src 'none'`).
- **Auth view**: `pm.request.auth` is built on the host from `ScriptRunInput.auth` with credential parameters replaced by
  `[REDACTED]` (well-known keys per auth type, sensitive-looking keys for `custom`, and any value equal to a known secret)
  before the JSON crosses into the guest, so secrets never exist in the sandbox heap.
- **Untrusted results**: everything read back from the guest (variables, request, tests) is re-validated field by field;
  records are built with `defineProperty`, so keys such as `__proto__` stay plain data and cannot pollute host objects.
  If a script tampers with built-ins so that results cannot be read back, the run fails with `SCRIPT_ERROR`.
- **Secrets**: console messages (including the `pm.sendRequest` trace lines), test names/errors, error messages/stacks,
  cookie-jar error messages and the visualizer HTML pass through `redactText(..., secretValues)` before leaving the sandbox
  (messages are cut to a bounded size first, then redacted, then cut to 16 KiB, so a secret cannot survive by straddling the
  cut). Hashing or encrypting a secret with `CryptoJS` is allowed (the digest is ordinary data); logging the secret itself is
  redacted. `httpOnly` cookies are never given to the script, neither through `pm.cookies` nor through the jar.
- **Native stack (known limitation)**: QuickJS-in-WASM recurses on the host's native stack, while its own stack check
  measures a different (shadow) stack. The default limit is therefore deliberately small, but a hostile script can still
  overflow the native stack with deeply nested data or code (for example `JSON.stringify` of a 100k-deep object). That is caught
  on the host, reported as `SCRIPT_ERROR` (`SandboxError`) and the shared WASM module is discarded and re-created, because
  its internal stack pointer is no longer trustworthy. Concurrent runs that were using the discarded module may fail too.
  Run scripts in a utility process if you need fault isolation between runs.
- After an interrupt (timeout/cancel) or a crash the interpreter is not torn down (QuickJS can leak objects when interrupted
  inside a promise job, which makes `JS_FreeRuntime` abort); it is dropped together with its WASM instance.

## Examples

Set a header from a variable (pre-request):

```js
pm.request.headers.upsert({ key: 'X-Request-Id', value: pm.variables.replaceIn('{{$guid}}') });
pm.request.url.query.add({ key: 'page', value: pm.environment.get('page') || '1' });
```

Assertions (test):

```js
pm.test('status is 200', () => pm.response.to.have.status(200));
pm.test('returns the user', () => {
  const body = pm.response.json();
  pm.expect(body).to.have.property('id');
  pm.expect(body.tags).to.include('a');
});
pm.response.to.have.jsonSchema({ type: 'object', required: ['id'], properties: { id: { type: 'integer' } } });
```

Request chaining with `pm.sendRequest` (pre-request):

```js
const login = await pm.sendRequest({
  url: pm.environment.get('baseUrl') + '/login',
  method: 'POST',
  header: { 'Content-Type': 'application/json' },
  body: { mode: 'raw', raw: JSON.stringify({ user: pm.environment.get('user') }) },
});
pm.environment.set('token', login.json().access_token);
```

Callback style works too:

```js
pm.sendRequest('https://example.com/ping', (err, res) => {
  if (err) { console.error(err.message); return; }
  pm.collectionVariables.set('lastPing', String(res.responseTime));
});
```

Collection runner flow control:

```js
if (pm.response.code === 429) pm.execution.setNextRequest('Retry later');
// pm.execution.setNextRequest(null) stops the run; pm.execution.skipRequest() (pre-request) skips sending
```

Libraries, cookie jar and visualizer (unchanged Postman scripts):

```js
const moment = require('moment');
const { v4: uuidv4 } = require('uuid');
const signature = CryptoJS.HmacSHA256(pm.request.body.toString(), pm.environment.get('signingSecret')).toString();
pm.request.headers.upsert({ key: 'X-Signature', value: signature });
pm.request.headers.upsert({ key: 'X-Request-Id', value: uuidv4() });
pm.request.url.query.add({ key: 'since', value: moment().utc().subtract(1, 'day').format('YYYY-MM-DD') });
const first = _.get(xml2Json(pm.response.text()), 'feed.entry[0].title');

await pm.cookies.jar().set(pm.environment.get('baseUrl'), { name: 'session', value: pm.response.json().sessionId, secure: true });

pm.response.to.have.jsonSchema({ definitions: { id: { type: 'integer' } }, properties: { id: { $ref: '#/definitions/id' }, email: { type: 'string', format: 'email' } } });
pm.visualizer.set('<ul>{{#each items}}<li>{{name}}</li>{{/each}}</ul>', { items: pm.response.json() });
```

## Maintenance

- Guest-side code lives as string constants in `packages/scripting/src/guest/*.ts` and is assembled by
  `packages/scripting/src/prelude.ts`. They are plain JavaScript executed only inside QuickJS; avoid backticks and dollar-brace
  sequences in them (they use `String.raw`).
- The library bundles are generated: `npm run build:sandbox-libs` (`scripts/build-sandbox-libs.mjs`, esbuild, deterministic)
  writes `packages/scripting/src/generated/chai-bundle.ts` (evaluated at start-up) and
  `packages/scripting/src/generated/libs-bundle.ts` (lodash, moment, crypto-js, uuid, ajv + draft-06 meta-schema, tv4,
  fast-xml-parser, handlebars; evaluated lazily). Both are committed; re-run the script after upgrading any of these
  devDependencies and commit the result. Each lazy bundle is a `(function (crypto) { ...; return exports; })` expression;
  Node built-ins are marked external so a bundle can never pull them in. The chai bundle needs two tiny shims (`Event`,
  `EventTarget`), supplied by the bootstrap and removed again before user code runs.
- Guest-side facades (`require`, `Buffer`, csv-parse, xml2js, JSON-schema formats, `pm.visualizer`, `pm.sendRequest` auth)
  live in `packages/scripting/src/guest/libs.ts`. The editor typings in
  `apps/desktop/renderer/src/workspace/scriptSupport.ts` mirror this document; update both together.
