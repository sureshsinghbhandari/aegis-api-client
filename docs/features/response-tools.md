# Response tools, examples and shell UX

This page documents the features added by the "response tools" work package: examples, the JSONPath filter, the
Visualize tab, the console network log, the workbench layout toggle, tab restore, keyboard shortcuts and Markdown
descriptions. Every statement here is backed by `tests/unit/ui-jsonpath.test.ts`, `ui-markdown.test.ts`,
`ui-tab-persistence.test.ts` and `ui-network-log.test.ts`.

## Examples

- **Save as example** (button in the response status row) stores the current response — status, status text, headers
  and the body (text bodies only; binary or very large bodies are stored without a body and flagged in
  `metadata.bodyOmitted`) — as a named example of the request. The redacted request line (method, URL, headers as
  sent) is kept as `originalRequest`.
- The request's **Examples** tab (badge = number of examples) lists the examples and lets you edit name, status
  code, status text, body type, headers and body, or delete them. "Add example" creates an empty one.
- Examples are part of the request draft: for a saved request "Save as example" persists immediately; for an unsaved
  tab they are kept until you save the request. They are exported and imported with the collection (Postman v2.1
  `response[]`).

## JSONPath filter (Pretty view)

A filter box appears above JSON bodies. Supported subset: `$`, `.name`, `['name']`, `[n]` (negative indexes),
`[*]`/`.*`, `..name` (recursive descent), unions `[0,2]` / `['a','b']`, slices `[start:end:step]` and filters
`[?(@.price < 10 && @.tags)]` with `== != < <= > >= && || !`, `@.a.b[0]` paths and string/number/boolean/null
literals. The expression is parsed into a small AST and interpreted: there is no `eval`, no `Function`, and inherited
properties (`__proto__`, `constructor`, `length`) are never reachable. Invalid expressions show an inline error with
the position; a definite path (`$.a.b[0]`) shows the single value, anything else the result list.

## Visualize tab

Renders `ExecutionResult.visualizer` (the HTML produced by `pm.visualizer.set(template, data)` in the sandbox).
The markup is passed through `buildPreviewDocument` (script/handler/`javascript:` stripping + a CSP of
`default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'`) and shown in an `<iframe sandbox="">`:
no scripts, no network, no forms, no same-origin access. Without a visualizer the tab shows a hint.

## Console network log

The Console panel now shows, chronologically with script output, one entry per:

- request sent from a tab (method, URL, status, duration, body size), including failed sends (error code);
- `pm.sendRequest` call reported by the sandbox (`-> METHOD url` / `<- STATUS ... ms` lines);
- runner item (`runner:item` events).

Entries expand to the request and response headers. Values of `Authorization`, `Proxy-Authorization`, `Cookie`,
`Set-Cookie`, `X-API-Key` and any header whose name contains `token`, `secret`, `password`, `credential` or
`api-key` are shown as `[REDACTED]`; bodies are not logged. The kind filter switches between scripts, network and
both; the level filter `error` keeps network entries with an error or status >= 400.

## Layout, tabs and shortcuts

- **Layout**: stacked (request above response) or side by side, toggled from the tab bar button or
  Settings → General → Layout; persisted in `appearance.layout`.
- **Tab restore**: open tabs are written to `localStorage` (`aegis.tabs`, debounced) and restored on start.
  Only request ids are stored for clean tabs; unsaved or edited tabs store the draft **without credentials**: every
  secret auth parameter (password, token, client secret, private key, API key, …) is stripped and re-attached from the
  saved request on restore when the auth type is unchanged. Responses are never persisted; payloads above 2 MB fall
  back to ids only.
- **Shortcuts**: Ctrl+W now asks before closing a tab with unsaved changes (same dialog as the close button);
  Ctrl+Tab / Ctrl+Shift+Tab cycle through tabs; Ctrl+Shift+F opens Find & Replace for the active tab's collection.

## Markdown descriptions

Request descriptions (Docs tab) and collection/folder descriptions (Edit dialog) are edited next to a live preview.
The renderer is an in-app safe subset (headings, emphasis, code, lists, task lists, quotes, rules, tables, links,
images): all text is escaped, raw HTML is shown literally, links keep only `http(s)`/`mailto` URLs, and images are
limited to inline `data:image/*` URLs (no remote images, so previews never make network requests). The output goes
through `buildPreviewDocument` and is displayed in an `<iframe sandbox="">`.
