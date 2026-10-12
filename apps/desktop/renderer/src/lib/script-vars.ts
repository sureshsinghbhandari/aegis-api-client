/**
 * Pure helpers for the script "Variables" side pane (no React/DOM): grouping of variable
 * entries per scope, snippet generation for `pm.*` accessors, masking of secrets and the
 * merge used by the "New variable" mini-form.
 */
import type { VariableEntry } from '@aegis/core';
import { isSecretRef, MASK } from './ui-format';
import { isValidVariableKey } from './variables-helpers';

export type ScriptVarScope = 'environment' | 'globals' | 'collection' | 'folder';

/** Scope a "New variable" can be written to from the pane. */
export type WritableScriptVarScope = Exclude<ScriptVarScope, 'folder'>;

export interface ScriptVarRow {
  scope: ScriptVarScope;
  /** Owner id for API calls (environment id, workspace id, collection id or folder id). */
  ownerId: string;
  /** Group heading, e.g. `Environment` or `Folder "Users"`. */
  group: string;
  key: string;
  /** Text for the "current value" column; always the mask for secrets. */
  display: string;
  /** Effective stored value (current, falling back to initial). For secrets this is the opaque reference only. */
  raw: string;
  secret: boolean;
  enabled: boolean;
}

/** Script accessor per scope. Folder variables are folded into the collection scope by the executor. */
export const PM_ACCESSOR: Record<ScriptVarScope, string> = {
  environment: 'pm.environment',
  globals: 'pm.globals',
  collection: 'pm.collectionVariables',
  folder: 'pm.collectionVariables',
};

export const SCOPE_LABEL: Record<ScriptVarScope, string> = {
  environment: 'env',
  globals: 'global',
  collection: 'collection',
  folder: 'folder',
};

/** Double-quoted JavaScript string literal (JSON escaping is a valid JS subset). */
export function jsString(value: string): string {
  return JSON.stringify(value);
}

export function snippetGet(scope: ScriptVarScope, key: string): string {
  return `${PM_ACCESSOR[scope]}.get(${jsString(key)})`;
}

/** `pm.<scope>.set("key", "value");` – secrets get a placeholder so their value never lands in a script. */
export function snippetSet(scope: ScriptVarScope, key: string, value: string, secret = false): string {
  return `${PM_ACCESSOR[scope]}.set(${jsString(key)}, ${secret ? "'new value'" : jsString(value)});\n`;
}

export function templateRef(key: string): string {
  return `{{${key}}}`;
}

export function effectiveValue(e: Pick<VariableEntry, 'initialValue' | 'currentValue'>): string {
  return e.currentValue !== undefined && e.currentValue !== '' ? e.currentValue : e.initialValue;
}

export function isSecretEntry(e: Pick<VariableEntry, 'isSecret' | 'initialValue' | 'currentValue'>): boolean {
  return e.isSecret || isSecretRef(e.initialValue) || isSecretRef(e.currentValue);
}

/** Value for display: never a `secretref:` string and never the plaintext of a secret. */
export function displayValue(e: Pick<VariableEntry, 'isSecret' | 'initialValue' | 'currentValue'>): string {
  return isSecretEntry(e) ? MASK : effectiveValue(e);
}

export function toRows(scope: ScriptVarScope, ownerId: string, group: string, entries: readonly VariableEntry[]): ScriptVarRow[] {
  return entries
    .filter((e) => e.key.trim() !== '')
    .map((e) => ({ scope, ownerId, group, key: e.key, display: displayValue(e), raw: effectiveValue(e), secret: isSecretEntry(e), enabled: e.enabled }));
}

/** Case-insensitive filter on key or group name; an empty needle keeps everything. */
export function filterRows(rows: readonly ScriptVarRow[], needle: string): ScriptVarRow[] {
  const n = needle.trim().toLowerCase();
  if (!n) return [...rows];
  return rows.filter((r) => r.key.toLowerCase().includes(n) || r.group.toLowerCase().includes(n));
}

/** Names (across all scopes) that the last run's scripts set or unset. */
export function changedNames(changes: Record<string, { set: string[]; unset: string[] }> | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!changes) return out;
  for (const c of Object.values(changes)) {
    for (const k of c.set) out.add(k);
    for (const k of c.unset) out.add(k);
  }
  return out;
}

export type MergeResult = { ok: true; entries: VariableEntry[]; action: 'added' | 'updated' } | { ok: false; error: string };

/**
 * Add `key=value` to a stored entry list. Existing rows keep their ids and secret references;
 * a non-secret row with the same key gets its current value replaced, a secret one is refused.
 */
export function mergeVariable(entries: readonly VariableEntry[], key: string, value: string): MergeResult {
  const k = key.trim();
  if (!isValidVariableKey(k)) return { ok: false, error: 'Enter a variable name without "{" or "}".' };
  const idx = entries.findIndex((e) => e.key === k);
  if (idx === -1) {
    return { ok: true, action: 'added', entries: [...entries, { key: k, initialValue: value, currentValue: value, isSecret: false, enabled: true }] };
  }
  const existing = entries[idx]!;
  if (isSecretEntry(existing)) return { ok: false, error: `"${k}" is a secret variable. Change it in the Variables editor instead.` };
  const next = entries.map((e, i) => (i === idx ? { ...e, currentValue: value, enabled: true } : e));
  return { ok: true, action: 'updated', entries: next };
}

/** localStorage key remembering whether the variables pane is open. */
export const VARS_PANE_STORAGE_KEY = 'aegis.scriptVarsPane';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readPaneOpen(storage: StorageLike | null | undefined, fallback = true): boolean {
  try {
    const v = storage?.getItem(VARS_PANE_STORAGE_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* storage unavailable */
  }
  return fallback;
}

export function writePaneOpen(storage: StorageLike | null | undefined, open: boolean): void {
  try {
    storage?.setItem(VARS_PANE_STORAGE_KEY, open ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}
