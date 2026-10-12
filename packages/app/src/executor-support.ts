import {
  composeDisplayUrl,
  parseDisplayUrl,
  type AuthConfig,
  type KeyValueEntry,
  type RequestBody,
  type RequestDraft,
  type ScopeChanges,
  type ScriptRequestSnapshot,
  type VariableEntry,
} from '@aegis/core';
import { isSecretAuthParam } from '@aegis/storage';
import { REDACTED, isSensitiveKey, redactObject, redactText } from '@aegis/security';

/** Enabled variables as a flat map. Runtime (current) value wins over the initial value. */
export function entriesToRecord(entries: readonly VariableEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    if (!e.enabled || !e.key) continue;
    out[e.key] = e.currentValue !== undefined && e.currentValue !== '' ? e.currentValue : e.initialValue;
  }
  return out;
}

export function secretValuesOf(entries: readonly VariableEntry[]): string[] {
  return entries.filter((e) => e.enabled && e.isSecret).map((e) => (e.currentValue ? e.currentValue : e.initialValue)).filter((v) => v.length >= 3);
}

export function emptyChanges(): ScopeChanges {
  return { set: {}, unset: [], cleared: false };
}

/** Fold `next` (a later script's changes) onto `acc`. */
export function mergeChanges(acc: ScopeChanges, next: ScopeChanges): ScopeChanges {
  const set = { ...acc.set };
  let unset = [...acc.unset];
  let cleared = acc.cleared;
  if (next.cleared) {
    for (const k of Object.keys(set)) delete set[k];
    unset = [];
    cleared = true;
  }
  for (const k of next.unset) {
    delete set[k];
    if (!unset.includes(k)) unset.push(k);
  }
  for (const [k, v] of Object.entries(next.set)) {
    set[k] = v;
    unset = unset.filter((x) => x !== k);
  }
  return { set, unset, cleared };
}

export function hasChanges(c: ScopeChanges): boolean {
  return c.cleared || c.unset.length > 0 || Object.keys(c.set).length > 0;
}

/** Best-effort JSON text of a GraphQL body for scripts (invalid variables JSON is passed through as a string; sending validates it). */
function graphqlSnapshotText(graphql: RequestBody['graphql']): string {
  const g = graphql ?? { query: '', variables: '' };
  const doc: Record<string, unknown> = { query: g.query };
  const vars = (g.variables ?? '').trim();
  if (vars !== '') {
    try {
      doc.variables = JSON.parse(vars);
    } catch {
      doc.variables = g.variables;
    }
  }
  if (g.operationName && g.operationName.trim() !== '') doc.operationName = g.operationName.trim();
  return JSON.stringify(doc);
}

export function draftToSnapshot(draft: RequestDraft): ScriptRequestSnapshot {
  const b = draft.body;
  const body: ScriptRequestSnapshot['body'] = { mode: b.mode === 'graphql' ? 'raw' : b.mode };
  if (b.mode === 'raw') {
    body.raw = b.raw ?? '';
    if (b.rawLanguage) body.rawLanguage = b.rawLanguage;
  } else if (b.mode === 'urlencoded') {
    body.urlencoded = (b.urlencoded ?? []).map((e) => ({ ...e }));
  } else if (b.mode === 'formdata') {
    body.formdata = (b.formData ?? []).map((f) => ({ key: f.key, value: f.value, type: f.type, enabled: f.enabled }));
  } else if (b.mode === 'graphql') {
    // Scripts see the JSON document that is sent on the wire (`{query, variables, operationName}`).
    body.mode = 'raw';
    body.raw = graphqlSnapshotText(b.graphql);
    body.rawLanguage = 'json';
  }
  return {
    method: draft.method,
    url: composeDisplayUrl(draft.url, draft.queryParams),
    headers: draft.headers.map((h) => ({ ...h })),
    body,
  };
}

/** Apply what a pre-request script changed on `pm.request` back onto the draft (by comparing before/after). */
export function applySnapshot(draft: RequestDraft, before: ScriptRequestSnapshot, after: ScriptRequestSnapshot): RequestDraft {
  let next: RequestDraft = draft;
  if (after.method !== before.method) next = { ...next, method: after.method };
  if (after.url !== before.url) {
    const parsed = parseDisplayUrl(after.url, next.queryParams.filter((q) => !q.enabled));
    next = { ...next, url: parsed.url, queryParams: parsed.queryParams };
  }
  if (JSON.stringify(after.headers) !== JSON.stringify(before.headers)) {
    next = { ...next, headers: after.headers.map((h): KeyValueEntry => ({ ...h })) };
  }
  if (JSON.stringify(after.body) !== JSON.stringify(before.body)) {
    const b = after.body;
    let body: RequestBody;
    if (b.mode === 'raw') body = { ...next.body, mode: 'raw', raw: b.raw ?? '', ...(b.rawLanguage ? { rawLanguage: b.rawLanguage as RequestBody['rawLanguage'] } : {}) };
    else if (b.mode === 'urlencoded') body = { ...next.body, mode: 'urlencoded', urlencoded: b.urlencoded ?? [] };
    else if (b.mode === 'formdata') {
      body = {
        ...next.body,
        mode: 'formdata',
        formData: (b.formdata ?? []).map((f) => {
          const original = next.body.formData?.find((o) => o.key === f.key);
          return { key: f.key, value: f.value, type: (f.type === 'file' ? 'file' : f.type === 'variable' ? 'variable' : 'text') as 'text' | 'file' | 'variable', enabled: f.enabled, ...(original?.filePath ? { filePath: original.filePath } : {}) };
        }),
      };
    } else body = { mode: b.mode };
    next = { ...next, body };
  }
  return next;
}

/** All user-visible strings in a draft that may contain `{{variables}}` (for unresolved-variable warnings). */
export function collectDraftStrings(draft: RequestDraft): string[] {
  const out: string[] = [draft.url];
  for (const e of [...draft.headers, ...draft.queryParams, ...draft.pathVariables]) if (e.enabled) out.push(e.key, e.value);
  const b = draft.body;
  if (b.raw) out.push(b.raw);
  if (b.mode === 'graphql' && b.graphql) out.push(b.graphql.query, b.graphql.variables, b.graphql.operationName ?? '');
  for (const e of b.urlencoded ?? []) if (e.enabled) out.push(e.key, e.value);
  for (const f of b.formData ?? []) if (f.enabled) out.push(f.key, f.value);
  for (const v of Object.values(draft.auth.params)) if (typeof v === 'string') out.push(v);
  return out.filter((s) => s.includes('{{'));
}

/** Non-secret auth parameters only. */
export function publicAuth(auth: AuthConfig): AuthConfig {
  const params: AuthConfig['params'] = {};
  for (const [k, v] of Object.entries(auth.params)) {
    if (typeof v === 'string' && isSecretAuthParam(auth.type, k) && v !== '' && !/^\s*\{\{/.test(v)) continue;
    params[k] = v;
  }
  return { type: auth.type, params };
}

/** Stored bodies (opt-in) are redacted structurally and, for raw text, by pattern (e.g. `\"password\": \"...\"` in JSON). */
function redactBody(body: RequestBody): RequestBody {
  const out = redactObject(body);
  if (out.raw !== undefined) out.raw = redactText(out.raw);
  return out;
}

/** A sensitive literal is masked; a `{{variable}}` reference is not a secret and is kept so replay still works. */
function maskEntry(e: KeyValueEntry): KeyValueEntry {
  return isSensitiveKey(e.key) && e.value !== '' && !e.value.includes('{{') ? { ...e, value: REDACTED } : { ...e };
}

/**
 * Unresolved request snapshot stored in history for replay. Never contains
 * credentials: sensitive literals are masked, bodies are omitted unless the
 * user enabled body storage.
 */
export function historySnapshot(draft: RequestDraft, storeBodies: boolean): unknown {
  return {
    draft: {
      name: draft.name,
      method: draft.method,
      url: draft.url,
      queryParams: draft.queryParams.map(maskEntry),
      pathVariables: draft.pathVariables,
      headers: draft.headers.map(maskEntry),
      body: storeBodies ? redactBody(draft.body) : { mode: draft.body.mode, omitted: draft.body.mode !== 'none' },
      auth: publicAuth(draft.auth),
      settings: draft.settings,
    },
  };
}
