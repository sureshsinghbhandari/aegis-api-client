# Command-line runner (`aegis-cli`)

`aegis-cli` runs a Postman-compatible collection from a terminal or a CI job, with the same engine the desktop
app uses (variable resolution, authentication, scripts in the sandbox, cookies, enterprise policy), and prints
Newman-style results. It is a plain Node.js program: no Electron, no window, no persistent data.

Sources: `apps/cli/`. Bundle: `dist/cli/aegis-cli.cjs` (built by `npm run build:cli`, also part of `npm run build`).

```sh
npm run build:cli
node dist/cli/aegis-cli.cjs run collection.json -e env.json --reporters cli,junit --reporter-junit-export results.xml
# or
npm run cli -- run collection.json -e env.json
```

## Usage

```
aegis-cli run <collection.json> [options]
aegis-cli --help | --version
```

| Option | Meaning |
| --- | --- |
| `-e, --environment <file>` | Postman environment JSON (`values[]`). Secret-typed values are stored encrypted in memory for the run. |
| `-g, --globals <file>` | Postman globals JSON. |
| `-d, --iteration-data <file>` | CSV (RFC 4180) or JSON array data file; one iteration per row, available as `pm.iterationData` and `{{column}}`. |
| `--folder <name>` | Run only that folder and its sub-folders (exact name first, then case-insensitive). |
| `-n, --iteration-count <n>` | Iterations (default 1). With a data file the count is capped by the number of rows. |
| `--delay <ms>` | Pause between requests. |
| `--bail` | Stop at the first failed request or test. |
| `--timeout <ms>` | Request timeout (overrides the default 30 s). |
| `--insecure` | Disable TLS certificate validation. **Refused (exit 2) unless the policy sets `allowInsecureTls: true`.** |
| `--production` | Treat the environment as a production environment. This is the explicit confirmation the production gate requires; if the policy sets `blockProductionRequests` the run is refused with exit 2. |
| `-r, --reporters <list>` | Comma separated: `cli`, `json`, `junit`, `html`. Default `cli`. |
| `--reporter-json-export <f>`, `--reporter-junit-export <f>`, `--reporter-html-export <f>`, `--reporter-cli-export <f>` | Write that report to a file (the reporter is enabled automatically). Without an export path `json`/`junit`/`html` are written to stdout. |
| `--policy <file>` | Enterprise policy JSON. Default: `AEGIS_POLICY_FILE`, then the OS-wide locations used by the desktop app (`%ProgramData%\Aegis\policy.json`, `/Library/Application Support/Aegis/policy.json`, `/etc/aegis/policy.json`). A file named explicitly must exist and parse; otherwise exit 2. |
| `--export-environment <f>` | After the run, write the environment (including values changed by scripts) as a Postman environment file. Secret values are blanked when the policy sets `allowSecretExport: false`. |
| `--color` / `--no-color` | Force ANSI colours on or off. By default colours are used on a TTY unless `NO_COLOR` is set. |
| `--verbose` | Print import warnings and engine warnings to stderr. |

Environment variables: `AEGIS_POLICY_FILE` (policy), `AEGIS_MIGRATIONS_DIR` (folder with the SQLite migrations when the
bundle is deployed outside the repository), `NO_COLOR`, and the usual `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`.

## Output

The `cli` reporter streams one line per request as it completes, then the assertions and a summary:

```
✓ Login                                    200    182ms
    ✓ status is 200
✗ Update user                              400     12ms
    ✗ is 200  expected 400 to equal 200

  collection   Kitchen sink
  environment  Staging
  iterations   1
  requests     2 executed, 1 failed
  tests        1 passed, 1 failed
  duration     194ms
  status       completed

  FAILED
```

- `json`: `{ format: "aegis-run-report", version: 1, collection, environment, startedAt, finishedAt, status, summary, items[] }`
  with per-request method, URL, status, duration, error and per-test results.
- `junit`: `<testsuites>` with one `<testsuite>` per iteration and one `<testcase>` per test (a request without tests is
  one case that fails when the request itself failed). Understood by Jenkins, GitLab, Azure DevOps and GitHub Actions.
- `html`: a single self-contained file (inline CSS, no scripts, no external resources, no links). Everything taken from
  the collection or the server (names, URLs, assertion messages) is HTML-escaped.

Stdout carries only reporter output; diagnostics go to stderr. Secret values never appear in any report.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every request and every test passed and the run completed. |
| 1 | A request or a test failed, the run was stopped (`--bail`, Ctrl+C) or did not complete. |
| 2 | Usage error: unknown option or command, missing input or policy file, unknown folder/reporter, or an option refused by policy (`--insecure`, `--production`). |
| 3 | The collection, environment, globals or data file could not be parsed. |

## Security model

- Everything lives in an in-memory SQLite database. Secrets from environment/globals files are encrypted with a
  random per-process AES-256-GCM key (`CipherBackedSecretStorage`) and are gone when the process exits.
- The enterprise policy applies exactly as in the desktop app: `blockedHosts` make the request fail (`✗ ... policy
  blocks requests to host`), `maxResponseBytes` / `maxScriptTimeoutMs` clamp the limits, `allowInsecureTls` gates
  `--insecure`, `blockProductionRequests` / `requireProductionConfirmation` gate `--production`.
- The CLI makes no network requests other than the collection's own (including `pm.sendRequest` and auth token
  endpoints, which go through the same policy and TLS settings).
- Scripts run in the same QuickJS sandbox as in the desktop app, with the same limits.

## Limitations

- Interactive OAuth 2.0 flows (authorization code, implicit) are not supported: there is no browser window, the auth
  helper reports `interactive OAuth is not supported in the CLI`. Grants that only need a token endpoint (client
  credentials, password, refresh token) and every auth type that works without a browser in the desktop app work the
  same way here, because the CLI uses the same `@aegis/authentication` registry.
- Cookies are kept in the in-memory jar for the duration of the run only; nothing persists between runs.
- Client certificates and custom CAs are not configurable from the CLI yet (the in-memory database starts empty).
- Only Postman collection v2.0/v2.1 and Postman environment/globals files are accepted as inputs. Other formats can be
  imported in the desktop app and exported as a Postman collection first.
- File references in request bodies (`src` of form-data/binary parts) resolve relative to the working directory setting,
  which is empty in the CLI; use absolute paths.
- There is no `--ssl-client-cert`, `--cookie-jar` or `--global-var` option; use environment/globals files instead.
