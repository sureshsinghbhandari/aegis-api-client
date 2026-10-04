import type { VariableEntry } from '@aegis/core';

export function blankVariable(): VariableEntry {
  return { key: '', initialValue: '', currentValue: '', isSecret: false, enabled: true, description: '' };
}

/** Stable comparison used for dirty tracking. */
export function entriesSignature(entries: VariableEntry[]): string {
  return JSON.stringify(
    entries.map((e) => ({
      id: e.id ?? null,
      key: e.key,
      i: e.initialValue,
      c: e.currentValue ?? '',
      s: e.isSecret,
      en: e.enabled,
      d: e.description ?? '',
    })),
  );
}

export interface PreparedEntries {
  entries: VariableEntry[];
  /** Keys that appear more than once among enabled rows (the last one wins at resolution time). */
  duplicates: string[];
  /** Number of untitled rows that were dropped. */
  dropped: number;
}

/** Trim keys, drop rows without a key and report duplicates. Values are passed through untouched. */
export function prepareEntries(rows: VariableEntry[]): PreparedEntries {
  const entries: VariableEntry[] = [];
  let dropped = 0;
  for (const r of rows) {
    const key = r.key.trim();
    if (key === '') {
      dropped++;
      continue;
    }
    entries.push({ ...r, key });
  }
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const e of entries) {
    if (!e.enabled) continue;
    if (seen.has(e.key)) dup.add(e.key);
    seen.add(e.key);
  }
  return { entries, duplicates: [...dup], dropped };
}

/** Valid variable names are non-empty and must not contain braces or whitespace-only text. */
export function isValidVariableKey(key: string): boolean {
  const k = key.trim();
  return k.length > 0 && !/[{}]/.test(k);
}

/** Entries whose key is syntactically unusable inside `{{...}}`. */
export function invalidKeys(entries: VariableEntry[]): string[] {
  return entries.filter((e) => e.key.trim() !== '' && !isValidVariableKey(e.key)).map((e) => e.key);
}
