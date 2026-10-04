/**
 * Pure URL helpers shared by the renderer (URL bar <-> params table sync) and
 * the HTTP engine (building the final URL). No Node APIs.
 *
 * Storage convention: `RequestDraft.url` is the URL WITHOUT a query string and
 * `queryParams` holds every parameter (enabled and disabled). The URL bar shows
 * `composeDisplayUrl(url, queryParams)` and `parseDisplayUrl` converts edits back.
 */
import type { KeyValueEntry } from './model';

/** Percent-encode a query component but leave existing %XX escapes alone. */
export function encodeQueryComponent(s: string): string {
  return encodeURIComponent(s).replace(/%25([0-9A-Fa-f]{2})/g, '%$1').replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

export function splitUrl(url: string): { base: string; query: string; hash: string } {
  let rest = url;
  let hash = '';
  const h = rest.indexOf('#');
  if (h !== -1) {
    hash = rest.slice(h);
    rest = rest.slice(0, h);
  }
  const q = rest.indexOf('?');
  if (q === -1) return { base: rest, query: '', hash };
  return { base: rest.slice(0, q), query: rest.slice(q + 1), hash };
}

/** Parse a raw query string (without `?`). Keeps `{{vars}}` readable; decodes %XX. */
export function parseQueryString(query: string): KeyValueEntry[] {
  if (!query) return [];
  return query
    .split('&')
    .filter((p) => p.length > 0)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      return { key: safeDecode(key), value: safeDecode(value), enabled: true };
    });
}

export function serializeQuery(entries: readonly KeyValueEntry[]): string {
  return entries
    .filter((e) => e.enabled && e.key !== '')
    .map((e) => (e.value === '' ? encodeQueryComponent(e.key) : `${encodeQueryComponent(e.key)}=${encodeQueryComponent(e.value)}`))
    .join('&');
}

/** What the URL bar shows: base URL plus the enabled query parameters. */
export function composeDisplayUrl(url: string, queryParams: readonly KeyValueEntry[]): string {
  const q = serializeQuery(queryParams);
  return q ? `${url}?${q}` : url;
}

/**
 * Apply an edit made in the URL bar: the part before `?` becomes `url`; the
 * query part replaces the ENABLED params while preserving disabled ones.
 */
export function parseDisplayUrl(display: string, previous: readonly KeyValueEntry[]): { url: string; queryParams: KeyValueEntry[] } {
  const { base, query, hash } = splitUrl(display);
  const parsed = parseQueryString(query);
  // keep descriptions for params that still exist by key+position
  const prevEnabled = previous.filter((p) => p.enabled);
  const merged = parsed.map((p, i) => {
    const old = prevEnabled[i];
    return old && old.key === p.key && old.description ? { ...p, description: old.description } : p;
  });
  const disabled = previous.filter((p) => !p.enabled);
  return { url: base + hash, queryParams: [...merged, ...disabled] };
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** Replace `:name` path segments using enabled path variables. */
export function applyPathVariables(url: string, pathVariables: readonly KeyValueEntry[]): string {
  const { base, query, hash } = splitUrl(url);
  const schemeMatch = SCHEME.exec(base);
  const authorityStart = schemeMatch ? schemeMatch[0].length : 0;
  const pathStart = base.indexOf('/', authorityStart);
  if (pathStart === -1) return url;
  const head = base.slice(0, pathStart);
  const path = base.slice(pathStart);
  const values = new Map(pathVariables.filter((v) => v.enabled).map((v) => [v.key, v.value]));
  const replaced = path
    .split('/')
    .map((seg) => {
      const m = /^:([A-Za-z_][\w.-]*)$/.exec(seg);
      if (!m) return seg;
      const v = values.get(m[1]!);
      return v === undefined || v === '' ? seg : encodeURIComponent(v);
    })
    .join('/');
  return head + replaced + (query ? `?${query}` : '') + hash;
}

/** Names of `:pathVariables` present in a URL (for syncing the Path Variables table). */
export function extractPathVariableNames(url: string): string[] {
  const { base } = splitUrl(url);
  const schemeMatch = SCHEME.exec(base);
  const pathStart = base.indexOf('/', schemeMatch ? schemeMatch[0].length : 0);
  if (pathStart === -1) return [];
  const names: string[] = [];
  for (const seg of base.slice(pathStart).split('/')) {
    const m = /^:([A-Za-z_][\w.-]*)$/.exec(seg);
    if (m && !names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

/**
 * Build the final URL to send from an already variable-resolved URL, query
 * parameters and path variables. Adds `http://` if no scheme is present.
 * The stored request is never mutated.
 */
export function buildRequestUrl(url: string, queryParams: readonly KeyValueEntry[], pathVariables: readonly KeyValueEntry[]): string {
  let full = applyPathVariables(url.trim(), pathVariables);
  const { base, query, hash } = splitUrl(full);
  const extra = serializeQuery(queryParams);
  const mergedQuery = [query, extra].filter(Boolean).join('&');
  full = base + (mergedQuery ? `?${mergedQuery}` : '') + hash;
  if (!SCHEME.test(full)) full = `http://${full}`;
  // fragments are never sent
  const h = full.indexOf('#');
  return h === -1 ? full : full.slice(0, h);
}
