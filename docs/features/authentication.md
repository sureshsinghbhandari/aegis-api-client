# Authentication providers

Aegis applies authorization at send time in the main process (`packages/authentication`, wired by
`packages/app/src/executor.ts`). Every provider receives the fully resolved request (`{{variables}}`
expanded) and returns headers and/or query parameters; it never sees the UI, the vault or the network
directly. Token endpoints and challenge round trips go through the same policy, TLS, proxy and host
checks as ordinary requests.

Package: `@aegis/authentication`. Entry points: `createDefaultAuthRegistry()`, one `AuthProvider` per
scheme, and pure builders (`buildDigestHeader`, `buildHawkHeader`, `buildEdgeGridHeader`,
`buildAsapToken`, `signJwt`, `oauth1Sign`, `signAwsV4`) that the tests feed fixed clocks and nonces.

## Status legend

Every status is backed by an automated test (`tests/unit/authentication.test.ts`,
`tests/unit/authentication-extra.test.ts`, `tests/integration/auth-providers.test.ts`).

- ✅ verified against a published vector, a specification example, or an independent implementation
  (a second, separately written implementation of the spec in `tests/helpers/auth-server.ts` or in the
  test itself, plus `node:crypto` signature verification for everything with a key)
- 🟡 implemented and tested for shape/round trip, but no third-party vector was available
- 🔴 preserved on Postman import/export only, not executable

## Providers

| Type (`AuthConfig.type` / `providerId`) | Scope | Status | Verification |
| --- | --- | --- | --- |
| `none`, `inherit` | - | ✅ | inheritance request > folder (innermost first) > collection |
| `basic`, `bearer`, `apikey` (header or query) | - | ✅ | unit |
| `oauth2` authorization code (+PKCE), client credentials, password, refresh | token to header or query, refreshed tokens persisted | ✅ | local token server |
| `oauth2` **device authorization grant** (RFC 8628) | `grant_type: device_code`; `deviceAuthUrl` (falls back to `authUrl`), `accessTokenUrl`, `clientId`, optional `clientSecret`, `scope`, `audience` | ✅ | local IdP: `authorization_pending`, `slow_down` (+5 s), `access_denied`, `expired_token`, cancellation, expiry |
| `oauth1` HMAC-SHA1 / HMAC-SHA256 / HMAC-SHA512 / PLAINTEXT | header or query | ✅ | Twitter published HMAC-SHA1 vector |
| `oauth1` **RSA-SHA1 / RSA-SHA256 / RSA-SHA512** | `privateKey` (PEM or `data:` URI); consumer secret unused | ✅ | base string signature verified with `node:crypto` |
| `jwt` HS256/384/512, RS256/384/512 | header or query, custom header fields (`kid`) | ✅ | jwt.io HS256 reference token |
| `jwt` **ES256/384/512** | key curve checked (P-256/P-384/P-521), raw `R‖S` signature encoding | ✅ | `createVerify(..., { dsaEncoding: 'ieee-p1363' })` |
| `jwt` **PS256/384/512** | RSASSA-PSS, MGF1, salt = digest length | ✅ | PSS verify succeeds, PKCS#1 v1.5 verify fails |
| `awsv4` | header-based signing | ✅ | AWS test-suite "get-vanilla" |
| `custom` / **`digest`** | RFC 7616 and 2617/2069: MD5, MD5-sess, SHA-256, SHA-256-sess, SHA-512-256(-sess); qop `auth` and `auth-int`; `opaque`; `userhash`; nonce count per nonce; client nonce | ✅ | RFC 2617 section 3.5 example (`6629fae49393a05397450978507c4ef1`), RFC 7616 3.9.1 inputs evaluated by hand, real 401 round trips against an independent verifier (MD5, SHA-256 preferred over MD5, `-sess`, `auth-int` POST, RFC 2069, Basic+Digest mixed headers, nonce-count increments) |
| `custom` / **`hawk`** | Hawk 1.1 header: `id`, `ts`, `nonce`, optional payload `hash`, `ext`, `app`/`dlg`; sha256 or sha1 | ✅ | hawk README protocol examples (`6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE=` and the payload example `aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw=`), independent MAC in the test server |
| `custom` / **`edgegrid`** | Akamai EG1-HMAC-SHA256: timestamp `yyyyMMddTHH:mm:ss+0000`, UUID nonce, headers-to-sign (lower-cased, whitespace collapsed, absent headers skipped), POST body hashed up to `maxBodySize` (default 131072), host override via `baseURL` | 🟡 | matches an independent in-test implementation of the algorithm as documented by Akamai (no official vector with a real secret is published) |
| `custom` / **`asap`** | Atlassian S2S: `alg` (RS/PS/ES), `kid`, `iss`, `sub` (default `iss`), `aud` (comma list), `exp` (`30s`/`15m`/`1h`, max 24 h), `iat`/`nbf`, unique `jti`, extra `claims` JSON; key as PEM or `data:application/pkcs8;...;base64,` URI | ✅ | claims checked, RS256/ES256 signatures verified with `node:crypto` |
| `custom` / `ntlm`, `akamai` and unknown ids | - | 🔴 | import/export round trip only; send fails with "cannot be executed" |

Postman compatibility: digest, hawk, edgegrid and asap keep Postman's `type` as `providerId` and
Postman's parameter names (`username`/`password`/`realm`/`nonce`/`algorithm`/`qop`/`nonceCount`/
`clientNonce`/`opaque`/`disableRetryRequest`; `authId`/`authKey`/`algorithm`/`user`/`nonce`/`extraData`/
`app`/`delegation`/`timestamp`/`includePayloadHash`; `accessToken`/`clientToken`/`clientSecret`/`baseURL`/
`nonce`/`timestamp`/`headersToSign`/`maxBodySize`; `alg`/`kid`/`iss`/`sub`/`aud`/`exp`/`privateKey`/`claims`),
so an imported collection executes and exports byte-for-byte as the same Postman auth type. The
`EXECUTABLE_CUSTOM_AUTH_PROVIDERS` list in `@aegis/core` tells the UI which custom ids get a form.

## Digest challenge round trip

Digest needs the server's nonce. `AuthContext.challenge()` (provided by the executor) sends the
prepared request once **without** an `Authorization` header, with the same cookie jar, policy host
check, TLS and proxy settings, with redirects disabled and the response body capped at 1 MiB and
discarded. The provider parses every `WWW-Authenticate` header (several challenges per header, quoted
commas, escaped quotes), picks the first supported Digest challenge (or the one matching the
configured `algorithm`), computes the response and the real request is sent once with credentials.
No automatic retry loop exists: a wrong password surfaces the server's 401 as the result.

- A configured `nonce` skips the probe (Postman's "pre-filled" mode); `disableRetryRequest` without a
  nonce fails with a clear error.
- A server that answers something other than 401 to the probe gets the request without credentials
  (noted in the Timeline).
- `qop=auth-int` hashes text and form bodies; for file/multipart bodies the provider falls back to
  `auth` when offered, otherwise fails.
- The nonce count is kept per server nonce in memory (bounded), so re-sending against a server that
  reuses nonces increments `nc`.

## OAuth 2.0 device flow (UI)

Authorization tab -> grant type "Device Authorization (device code)" -> "Get New Access Token" shows
the user code and verification URI and polls the token endpoint in the background (interval from the
server, `slow_down` adds five seconds); "Cancel" stops polling. Channels: `tools.oauth2DeviceStart` and
`tools.oauth2DevicePoll` (stateless: the renderer holds the device code in memory only, the main
process never logs or stores it). `{{variables}}` resolve with the full scope chain (environment,
folders, collection, globals) like at send time. Both endpoints are subject to the enterprise
`blockedHosts` policy.

## Secrets

Credential parameters are moved to the OS vault on save (`AUTH_SECRET_PARAMS` in `@aegis/core`:
`password`, `authKey`, `clientSecret`/`accessToken`, `privateKey`, ... and, for `custom` providers,
also any key that looks sensitive). They are blanked on export unless secrets are explicitly
included, resolved only inside the executor, and every auth parameter value joins the executor's
redaction set so neither the Timeline, history, console output nor logs contain them. Provider notes
never include secrets (they name the algorithm, qop and realm only).

## Not verified / known gaps

- EdgeGrid has no official public test vector with a usable secret; correctness rests on the
  documented algorithm being implemented twice independently (provider + test) and agreeing.
- Digest `SHA-512-256` is implemented but only MD5/SHA-256 (and `-sess`) are exercised against a server.
- Digest `username*` (RFC 7616 extended notation for non-ASCII user names) is not emitted; `userhash`
  is honoured when the server asks for it.
- NTLM remains preserved-only (needs MD4 and a multi-leg handshake on one connection).
- Hawk server responses (`Server-Authorization`) are not validated; bewit (URL) tokens are not generated.
