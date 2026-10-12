# HTTP runtime, request settings and TLS details

Package: `@aegis/http-client` (`packages/http-client`), wired by `packages/app/src/executor.ts` and
`packages/app/src/network.ts`. Everything below is covered by `tests/integration/http-client.test.ts`,
`tests/unit/http-runtime.test.ts` and the policy rows in `tests/security/security.test.ts`.

## HTTP/2

- undici `Agent({ allowH2: true })` with a custom connector (`packages/http-client/src/connector.ts`). HTTP/2 is
  negotiated through ALPN **over TLS only**; plain `http://` is always HTTP/1.1 (no h2c, no `Upgrade`).
- `ResponseView.httpVersion` is the **negotiated** protocol read from the socket (`HTTP/2` or `HTTP/1.1`), not a
  constant any more (gap-analysis finding #4).
- Preference: Settings → Network → *HTTP version* (`network.httpVersion`: `auto` | `2` | `1.1`), overridable per
  request in the request Settings tab (`settings.httpVersion`). `1.1` disables ALPN `h2`; `2` prefers `h2` in the
  ALPN list and adds a Timeline note when the server only offered 1.1.
- Through a proxy, HTTP/2 to the origin is still negotiated inside the CONNECT tunnel, but DNS/TCP/TLS timings and
  the TLS/connection details are not available (the proxy owns the connection).

## Timings and connection details (Timeline tab)

`ResponseTimings` gains `dnsMs`, `connectMs`, `tlsMs` (final hop's connection; all `0` when the connection was
reused, when the host was an IP literal or a hosts override, and `tlsMs = 0` for plain http). The Timeline draws DNS,
TCP connect, TLS handshake, waiting (TTFB) and download bars.

`HttpResponse.tls` / `ResponseView.tls`: TLS protocol, cipher suite, ALPN, whether the chain was verified, and the
peer certificate's subject, issuer, validity window (ISO), subject alternative names and SHA-256 fingerprint. Never
any key material. `connection`: remote/local address and port, `reused`, and `hostOverride` when a hosts entry
resolved the name.

## Request settings (request → Settings tab; Postman `protocolProfileBehavior`)

| Setting (`RequestSettings`) | Postman key | Behaviour |
| --- | --- | --- |
| `timeoutMs`, `followRedirects`, `maxRedirects` | `maxRedirects`, `followRedirects` | unchanged |
| `maxResponseBytes` | – (global in Postman) | now editable per request; clamped by the global setting and policy `maxResponseBytes` |
| `verifyTls` | `strictSSL` | **Honoured only when policy `allowInsecureTls` is true** (finding #5). Otherwise the tab shows an *enforced by policy* badge, the stored `false` is ignored and every send adds the warning "organization policy enforces it". When allowed and off, the Timeline carries the existing "certificate validation is disabled" warning. |
| `disableCookies` | `disableCookies` | the workspace cookie jar is neither read nor written for this request (`Set-Cookie` is still shown) |
| `encodeUrl: false` | `disableUrlEncoding: true` | query keys/values are joined as typed (no percent-encoding); the WHATWG parser still escapes what it must (spaces) |
| `followOriginalHttpMethod` | `followOriginalHttpMethod` | keep method and body on 301/302/303 instead of switching to GET |
| `followAuthorizationHeader` | `followAuthorizationHeader` | default **off**: `Authorization` is dropped on cross-origin redirects. On: forwarded, with a warning in the Settings tab, in `warnings` and in the Timeline notes. `Cookie`/`Proxy-Authorization` are never forwarded cross-origin. |
| `removeRefererHeaderOnRedirect` | `removeRefererHeaderOnRedirect` | strips a user-set `Referer` when following a redirect (the engine never adds one itself) |
| `httpVersion` | – | see HTTP/2 |

`disableBodyPruning` stays preserved in metadata (bodies are already sent for every method, so nothing to apply).
Import (`packages/postman/src/import-parts.ts`) and export (`export-collection.ts`) map the booleans both ways;
non-boolean values are preserved verbatim instead of mapped.

## Settings → General → Working directory (`files.workingDirectory`)

Imported Postman form-data / binary `src` values are relative paths (absolute ones are rejected at import). At send
time a relative path is resolved **only inside the working directory** (`assertSafeFilePath` with `allowedRoots`);
`..` escapes, UNC/device paths and an unset directory are `PATH_NOT_ALLOWED` (finding #8). Absolute paths picked in
the app keep the previous validation and are not restricted to the directory.

## Settings → Network → Host overrides (`network.hosts`, policy `allowHostOverrides`)

An application-local hosts file: `{ host, address }` rows (IPv4/IPv6 literal). The connector's `lookup` returns the
address for the host; the `Host` header, SNI and certificate validation keep the original host name, so staging boxes
behind a production certificate still verify. Overrides are reported in the response (`connection.hostOverride`, note
"resolved via hosts override") and never apply to proxied requests. The policy key `allowHostOverrides` (default
`true`) disables them: entries are kept but ignored and every send gets a warning.

## PKCS#12 client certificates (finding #15)

`certificates.add` accepts `pfxBase64` or `pfxPath` (the main process reads the file; 2 MiB cap; a DER SEQUENCE
check rejects PEM/text) plus an optional passphrase. Bundle and passphrase go to the vault like PEM keys; the Timeline
note says "Client certificate attached (PKCS#12)". Settings → Certificates has a PEM / PKCS#12 format switch.

## Executor fixes

- `ExecuteRequestInput.runScripts: false` now skips every pre-request and test script (finding #2).
- `tools.oauth2GetToken` resolves `{{variables}}` with the request's collection and folder scopes (same order as the
  executor: environment > folders innermost-first > collection > globals) and accepts a `cancelId`; `execution.cancel`
  with that id aborts the token request / browser flow (finding #3).
- `AuthContext.challenge()` (`packages/authentication/src/types.ts`) sends the prepared request without an
  `Authorization` header and returns status + headers, so challenge/response schemes (Digest) can read
  `WWW-Authenticate` with the same policy, cookies, TLS and proxy handling as the real request.

## Test server (`tests/helpers/http-server.ts`)

`startHttp2Server(key, cert)` (node:http2, `allowHTTP1`), `startHttpsServer(key, cert, { requestCert, ca })` for
mutual TLS, routes `/host` (echoes the Host header), `/digest/md5` and `/digest/sha256` (RFC 7616 challenge and
verification for `admin` / `digest-password-literal`, realm `metrics`), `/token` (minimal OAuth 2.0 token endpoint) and
`httpVersion` in `/echo`. Certificates come from the `openssl` CLI; TLS tests are skipped when it is unavailable.
