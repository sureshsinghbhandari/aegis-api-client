/** Helpers for the RequestDraft.scripts array (one entry per phase). Pure functions. */
import type { ScriptEntry, ScriptType } from '@aegis/core';

export function getScript(scripts: readonly ScriptEntry[], type: ScriptType): ScriptEntry {
  const found = scripts.find((s) => s.type === type);
  return found ?? { type, language: 'javascript', source: '', enabled: true };
}

/** Replace the script of `type`; an entry with an empty source is removed. Other phases are untouched. */
export function setScript(scripts: readonly ScriptEntry[], type: ScriptType, patch: Partial<Pick<ScriptEntry, 'source' | 'enabled'>>): ScriptEntry[] {
  const current = getScript(scripts, type);
  const next: ScriptEntry = { ...current, ...patch };
  const others = scripts.filter((s) => s.type !== type);
  if (next.source.trim() === '') return others;
  return type === 'prerequest' ? [next, ...others] : [...others, next];
}

export function hasScript(scripts: readonly ScriptEntry[], type: ScriptType): boolean {
  return scripts.some((s) => s.type === type && s.source.trim() !== '');
}
