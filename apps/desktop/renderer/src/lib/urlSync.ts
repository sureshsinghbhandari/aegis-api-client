/**
 * URL bar <-> Params / Path Variables synchronisation. Pure functions (no React).
 */
import { extractPathVariableNames, parseDisplayUrl, type KeyValueEntry, type RequestDraft } from '@aegis/core';

/**
 * Path variables for the `:names` present in `url`: existing rows are kept (values preserved),
 * missing names are added, rows for names that no longer appear are dropped unless they hold a value.
 */
export function syncPathVariables(url: string, existing: readonly KeyValueEntry[]): KeyValueEntry[] {
  const names = extractPathVariableNames(url);
  const byKey = new Map(existing.map((e) => [e.key, e]));
  const out: KeyValueEntry[] = [];
  for (const name of names) {
    out.push(byKey.get(name) ?? { key: name, value: '', enabled: true });
  }
  for (const e of existing) {
    if (!names.includes(e.key) && e.value !== '') out.push(e);
  }
  return out;
}

/** Apply an edit made in the URL bar and return the draft patch (url, queryParams, pathVariables). */
export function applyUrlEdit(display: string, draft: Pick<RequestDraft, 'queryParams' | 'pathVariables'>): Pick<RequestDraft, 'url' | 'queryParams' | 'pathVariables'> {
  const { url, queryParams } = parseDisplayUrl(display, draft.queryParams);
  return { url, queryParams, pathVariables: syncPathVariables(url, draft.pathVariables) };
}

/** `{{name}}` references found in a text (deduplicated). */
export function findVariableReferences(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g)) names.add(m[1]!);
  return [...names];
}
