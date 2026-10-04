import type { AuthConfig, ScriptEntry } from '@aegis/core';

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseAuth(text: string | null | undefined, fallbackType: AuthConfig['type']): AuthConfig {
  const parsed = parseJson<Partial<AuthConfig>>(text, {});
  return { type: parsed.type ?? fallbackType, params: parsed.params ?? {} };
}

export function parseScripts(text: string | null | undefined): ScriptEntry[] {
  return parseJson<ScriptEntry[]>(text, []);
}

/** Split an array in chunks (SQLite bound-parameter limits). */
export function chunk<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Escape `%` and `_` for use in a LIKE ... ESCAPE '\' pattern. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
