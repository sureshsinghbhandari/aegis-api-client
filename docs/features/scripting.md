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
| | `pm.environment`, `pm.collectionVariables`, `pm.globals`: `get/set/unset/has/clear/toObject/replaceIn` | ✅ | `pm.environment.name === 'environment'`. `replaceIn` resolves with the full precedence chain (not just its own scope) |
| | `{{$guid}}`, `{{$randomInt}}`, ... in `replaceIn` | ✅ | Resolved by the host through the shared dynamic-variable registry; unknown names are left untouched |
| | Values are strings | 🟡 | Objects are `JSON.stringify`-ed, everything else `String()`-ed on `set`; `get` always returns a string |
| | `pm.iterationData.get/has/toObject/toJSON/unset` | ✅ | No `set`/`clear` (read-mostly, like Postman) |
| Request | `pm.request.url` (string-assignable, `toString/getHost/getPath/getQueryString/getPathWithQuery/getRemote/update`, parts, `query` list) | ✅ | Untouched URLs round-trip byte for byte; `{{variables}}` are never expanded or encoded |
| | `pm.request.method` get/set, `headers` (`get/has/add/upsert/remove/each/toObject/all/...`), `getHeaders()`, `addHeader/removeHeader`, `toJSON()` | ✅ | Disabled headers are kept (and returned with `enabled: false`) but invisible to `get/has/toObject` |
| | `pm.request.body` (`mode`, `raw`, `urlencoded`, `formdata`, `options.raw.language`, `update`, `toString`) | ✅ | Final snapshot is returned in `result.request`; `binary`/file parts are carried through unchanged |
| | Mutating the request in a **test** script | 🟡 | Allowed inside the script, but ignored: `result.request` equals the input |
| Response (test phase) | `code`, `status`, `responseTime`, `responseSize`, `headers`, `cookies`, `text()`, `json()`, `reason()`, `size()` | ✅ | `json()` throws `Unable to parse the response body as JSON: ...` on invalid JSON. `pm.response` is `undefined` in pre-request scripts |
| | `pm.response.to.have.status/header/body/jsonBody` and `.to.be.ok/success/error/info/redirection/clientError/serverError/accepted/badRequest/unauthorized/forbidden/notFound/rateLimited/json/withBody`, `.to.not...` | ✅ | `body(string)` is an exact match; `body(regex)` tests the regex |
| | `pm.response.to.have.jsonSchema(schema)` | 🟡 | JSON-schema subset: `type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `additionalProperties` (boolean), `allOf`, `anyOf`, `oneOf`, `not`. Any other keyword (e.g. `$ref`) throws `Unsupported JSON schema keyword`; `format` is ignored |
| Cookies | `pm.cookies.get/has/toObject/...` | ✅ | `httpOnly` cookies are never exposed |
| | `pm.cookies.jar()` `get/getAll` | 🟡 | Reads the visible cookies |
| | `pm.cookies.jar()` `set/unset/clear` | 🟡 | No-ops that log a warning and still call the callback: the cookie jar is read-only for scripts in this version |
| Info / control | `pm.info.eventName/iteration/iterationCount/requestName/requestId` | ✅ | |
| | `pm.execution.setNextRequest(name \| null)`, `pm.execution.skipRequest()` | ✅ | `skipRequest` is pre-request only (throws elsewhere). `result.nextRequest` is `undefined` unless called |
| | `pm.execution.location` | 🟡 | Array with the script origin; `.current` is the origin string |
| Tests | `pm.test(name, fn)`, `pm.test.skip`, `pm.test.index()` | ✅ | `fn` may be sync, return a promise, or take a `done` callback. Failures never abort the script. A test whose promise never settles is reported as failed. Skipped tests are `passed: true, skipped: true` |
| | `pm.expect` and global `expect` (chai 6) | ✅ | Chai's own messages (`expected 1 to equal 2`); misspelled properties throw `Invalid Chai property` |
| Network | `pm.sendRequest(urlOrRequest, callback?)` | ✅ | Callback `(err, res)` or a returned Promise; `res` has `code/status/headers/responseTime/responseSize/text()/json()/cookies/to.have.status(...)`. Variables in the URL/body are **not** interpolated (same as Postman) |
| Legacy | `postman.setEnvironmentVariable/getEnvironmentVariable/clearEnvironmentVariable/setGlobalVariable/getGlobalVariable/clearGlobalVariable/setNextRequest/getResponseHeader` | ✅ | |
| | `tests["name"] = bool`, `responseBody`, `responseCode`, `responseHeaders`, `responseTime` | ✅ | The response globals exist only in the test phase |
| Console | `console.log/info/warn/error/debug` (+ `dir`, `trace`) | ✅ | Objects are JSON-stringified (cycle safe, errors print `name: message`); `%s %d %i %f %j %o %O %%` supported |
| Async | top-level `await` and `return`, `async/await`, promises, `setTimeout/clearTimeout`, `queueMicrotask` | ✅ | The run finishes when all timers, requests and promise jobs are done |
| | `setInterval`, `setImmediate` | 🔴 | Undefined |
| | Floating (never awaited) promise rejections | 🟡 | Rejections that reach the script's own promise chain (awaited code, `pm.test` bodies, `pm.sendRequest` callbacks) are reported. A rejected promise that nothing awaits is silently ignored: QuickJS offers no rejection tracker to the host |
| Built-ins | `atob`, `btoa`, `TextEncoder`, `TextDecoder` (UTF-8) | ✅ | |
| | `URL`, `URLSearchParams` | 🟡 | WHATWG subset: parsing, getters, `searchParams`, relative resolution against a base. No IDNA/punycode, no percent-encoding normalisation, limited setters |
| Not available | `require(...)` | 🔴 | Not defined (`ReferenceError`) |
| | `pm.require`, `pm.visualizer.set` | 🔴 | Throw `... is not supported in the Aegis script sandbox` |
| | `CryptoJS`, lodash `_`, `moment`, `cheerio`, `tv4`, `xml2Json` | 🔴 | Accessing the name throws `<name> is not available in the Aegis script sandbox` |
| | `fetch`, `XMLHttpRequest`, `WebAssembly`, `Buffer`, `process`, `crypto`, `performance`, timers beyond the above | 🔴 | Undefined (use `pm.sendRequest`) |

## Limits

| Limit | Default | Behaviour |
| --- | --- | --- |
| Wall-clock time (`limits.timeoutMs`) | 5000 ms | One budget for CPU time **and** async waits (`pm.sendRequest`, timers, promises). CPU-bound loops are stopped by the interpreter's interrupt handler; in-flight `pm.sendRequest` calls are aborted through their `AbortSignal`. Result: `SCRIPT_TIMEOUT` |
| Memory (`limits.memoryLimitBytes`) | caller supplied (64 MiB if invalid) | Budget for what the script allocates (the fixed prelude/chai footprint is added on top). Result: `SCRIPT_MEMORY` |
| Stack (`limits.maxStackSizeBytes`) | 128 KiB (clamped to 32-256 KiB) | See "Native stack" below. Result of runaway recursion: `SCRIPT_ERROR` (`InternalError: stack overflow`) |
| `pm.sendRequest` calls | 20 (`limits.maxSendRequests`) | Calls over the cap fail with an error naming the limit |
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
- **Narrow bridge**: the guest receives five host functions (log, dynamic variable lookup, `setTimeout`/`clearTimeout`,
  `sendRequest`, uncaught-error report). They are captured in the prelude's closure and are not reachable by name from user
  code. Every argument is treated as untrusted (type-checked, size-capped, JSON-parsed and re-validated).
  Nested requests go through `ScriptHost.sendRequest`, which must enforce the same policies as normal requests.
- **Untrusted results**: everything read back from the guest (variables, request, tests) is re-validated field by field;
  records are built with `defineProperty`, so keys such as `__proto__` stay plain data and cannot pollute host objects.
  If a script tampers with built-ins so that results cannot be read back, the run fails with `SCRIPT_ERROR`.
- **Secrets**: console messages, test names/errors and error messages/stacks pass through `redactText(..., secretValues)`
  before leaving the sandbox (messages are cut to a bounded size first, then redacted, then cut to 16 KiB, so a secret cannot
  survive by straddling the cut). `httpOnly` cookies are never given to the script.
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

## Maintenance

- Guest-side code lives as string constants in `packages/scripting/src/guest/*.ts` and is assembled by
  `packages/scripting/src/prelude.ts`. They are plain JavaScript executed only inside QuickJS; avoid backticks and dollar-brace
  sequences in them (they use `String.raw`).
- The chai bundle is generated: `npm run build:sandbox-libs` (`scripts/build-sandbox-libs.mjs`, esbuild) writes
  `packages/scripting/src/generated/chai-bundle.ts`, which is committed. Re-run it after upgrading `chai`. The bundle needs two
  tiny shims (`Event`, `EventTarget`), supplied by the bootstrap and removed again before user code runs.
