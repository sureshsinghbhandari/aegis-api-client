/**
 * Variable hints for the request editors: `{{` autocomplete, hover information and
 * "unresolved" highlighting BEFORE a request is sent. Pure functions (no React, no DOM).
 *
 * The index is built from the same scopes the executor resolves at send time
 * (environment > folder (innermost first) > collection > global). `@aegis/variables`
 * owns the real precedence list; `HINT_PRECEDENCE` mirrors the subset that exists
 * before a run (a unit test keeps the two in sync). Request/local/iteration scopes
 * only exist while scripts run, so they cannot be hinted.
 */
import type { VariableEntry } from '@aegis/core';

export type HintScope = 'environment' | 'folder' | 'collection' | 'global' | 'dynamic';

/** Static scopes, highest precedence first. */
export const HINT_PRECEDENCE = ['environment', 'folder', 'collection', 'global'] as const;

export interface VariableHint {
  name: string;
  scope: HintScope;
  /** Raw value: a `secretref:` reference for stored secrets, the plaintext otherwise. */
  value: string;
  secret: boolean;
  /** Owner label, e.g. the environment or folder name. */
  owner?: string;
  /** Lower-precedence definitions of the same name (for "shadows" hints). */
  shadowed: Array<{ scope: HintScope; owner?: string }>;
}

export interface VariableIndex {
  byName: ReadonlyMap<string, VariableHint>;
  /** Names in precedence order (then alphabetical inside a scope). */
  names: readonly string[];
}

export interface HintScopes {
  environment?: { owner?: string; entries: readonly VariableEntry[] };
  /** Innermost folder first. */
  folders?: Array<{ owner?: string; entries: readonly VariableEntry[] }>;
  collection?: { owner?: string; entries: readonly VariableEntry[] };
  global?: { owner?: string; entries: readonly VariableEntry[] };
}

/** Dynamic variables understood by the resolver (`packages/variables/src/dynamic.ts`); never flagged as unresolved. */
export const DYNAMIC_VARIABLE_NAMES: readonly string[] = [
  '$guid',
  '$randomUUID',
  '$timestamp',
  '$isoTimestamp',
  '$randomInt',
  '$randomBoolean',
  '$randomAlphaNumeric',
  '$randomHexColor',
  '$randomIP',
  '$randomFirstName',
  '$randomLastName',
  '$randomEmail',
  '$randomPassword',
];

export const EMPTY_VARIABLE_INDEX: VariableIndex = { byName: new Map(), names: [] };

export const SECRET_REF_PREFIX = 'secretref:';

export function isSecretValue(e: Pick<VariableEntry, 'isSecret' | 'initialValue' | 'currentValue'>): boolean {
  return e.isSecret || (e.currentValue ?? '').startsWith(SECRET_REF_PREFIX) || e.initialValue.startsWith(SECRET_REF_PREFIX);
}

function effectiveValue(e: VariableEntry): string {
  return e.currentValue !== undefined && e.currentValue !== '' ? e.currentValue : e.initialValue;
}

/** Build the lookup index. Enabled rows only; the current value wins over the initial value. */
export function buildVariableIndex(scopes: HintScopes): VariableIndex {
  const byName = new Map<string, VariableHint>();
  const ordered: Array<{ scope: HintScope; owner?: string; entries: readonly VariableEntry[] }> = [];
  if (scopes.environment) ordered.push({ scope: 'environment', ...scopes.environment });
  for (const f of scopes.folders ?? []) ordered.push({ scope: 'folder', ...f });
  if (scopes.collection) ordered.push({ scope: 'collection', ...scopes.collection });
  if (scopes.global) ordered.push({ scope: 'global', ...scopes.global });

  for (const { scope, owner, entries } of ordered) {
    const names = [...entries]
      .filter((e) => e.enabled && e.key.trim() !== '')
      .map((e) => ({ ...e, key: e.key.trim() }))
      .sort((a, b) => a.key.localeCompare(b.key));
    for (const e of names) {
      const existing = byName.get(e.key);
      if (existing) {
        existing.shadowed.push({ scope, ...(owner ? { owner } : {}) });
        continue;
      }
      byName.set(e.key, { name: e.key, scope, value: effectiveValue(e), secret: isSecretValue(e), ...(owner ? { owner } : {}), shadowed: [] });
    }
  }
  return { byName, names: [...byName.keys()] };
}

export interface VariableToken {
  /** Trimmed name as written between the braces. */
  name: string;
  /** Offset of the opening `{{`. */
  start: number;
  /** Offset just past the closing `}}`. */
  end: number;
}

const TOKEN_RE = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;

/** Every `{{name}}` reference in `text` with its offsets. */
export function findVariableTokens(text: string): VariableToken[] {
  const out: VariableToken[] = [];
  if (!text.includes('{{')) return out;
  for (const m of text.matchAll(TOKEN_RE)) out.push({ name: m[1]!, start: m.index, end: m.index + m[0].length });
  return out;
}

export function isDynamicVariable(name: string): boolean {
  return name.startsWith('$');
}

/** Hint for a name, or a synthetic `dynamic` hint for `$names`. */
export function lookupHint(index: VariableIndex, name: string): VariableHint | undefined {
  const hit = index.byName.get(name.trim());
  if (hit) return hit;
  if (isDynamicVariable(name)) return { name, scope: 'dynamic', value: '', secret: false, shadowed: [] };
  return undefined;
}

export function isUnresolved(index: VariableIndex, name: string): boolean {
  return lookupHint(index, name) === undefined;
}

/** Unique unresolved names referenced in `text`. */
export function unresolvedIn(index: VariableIndex, text: string): string[] {
  const names = new Set<string>();
  for (const t of findVariableTokens(text)) if (isUnresolved(index, t.name)) names.add(t.name);
  return [...names];
}

export interface CompletionContext {
  /** Offset of the opening `{{`. */
  start: number;
  /** Text typed after `{{` up to the caret. */
  prefix: string;
}

/** When the caret sits inside an unfinished `{{prefix`, describe it; otherwise null. */
export function completionContext(text: string, caret: number): CompletionContext | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const m = /\{\{([^{}]*)$/.exec(before);
  if (!m) return null;
  return { start: m.index, prefix: m[1] ?? '' };
}

export interface CompletionItem {
  name: string;
  scope: HintScope;
  secret: boolean;
  owner?: string;
}

/** Variables matching `prefix` (case-insensitive substring; prefix matches first), then dynamic variables. */
export function filterCompletions(index: VariableIndex, prefix: string, limit = 40): CompletionItem[] {
  const p = prefix.trim().toLowerCase();
  const starts: CompletionItem[] = [];
  const contains: CompletionItem[] = [];
  for (const name of index.names) {
    const h = index.byName.get(name)!;
    const item: CompletionItem = { name: h.name, scope: h.scope, secret: h.secret, ...(h.owner ? { owner: h.owner } : {}) };
    const lower = name.toLowerCase();
    if (p === '' || lower.startsWith(p)) starts.push(item);
    else if (lower.includes(p)) contains.push(item);
  }
  const dynamic = DYNAMIC_VARIABLE_NAMES.filter((n) => p === '' || n.toLowerCase().includes(p)).map((name): CompletionItem => ({ name, scope: 'dynamic', secret: false }));
  return [...starts, ...contains, ...dynamic].slice(0, limit);
}

/** Replace the unfinished `{{prefix` at the caret with `{{name}}`. Reuses a `}}` that already follows the caret. */
export function applyCompletion(text: string, caret: number, name: string): { text: string; caret: number } {
  const ctx = completionContext(text, caret);
  if (!ctx) return { text, caret };
  const after = text.slice(caret);
  const closing = after.startsWith('}}') ? '' : '}}';
  const inserted = `{{${name}}}`;
  const next = text.slice(0, ctx.start) + inserted + (closing === '' ? after.slice(2) : after);
  return { text: next, caret: ctx.start + inserted.length };
}

export const MASK = '••••••••';

/** Display value for a hint: secrets are masked, long values truncated, dynamic ones described. */
export function displayValue(hint: VariableHint, max = 60): string {
  if (hint.scope === 'dynamic') return '(generated when sent)';
  if (hint.secret) return MASK;
  const v = hint.value.replace(/\s+/g, ' ');
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

export function scopeLabel(scope: HintScope): string {
  switch (scope) {
    case 'environment':
      return 'Environment';
    case 'folder':
      return 'Folder';
    case 'collection':
      return 'Collection';
    case 'global':
      return 'Globals';
    case 'dynamic':
      return 'Dynamic';
  }
}

/** One-line description used by tooltips and hover providers. */
export function describeHint(index: VariableIndex, name: string): { title: string; detail: string; unresolved: boolean } {
  const hint = lookupHint(index, name);
  if (!hint) return { title: `{{${name}}}`, detail: 'Unresolved: not defined in the active environment, folder, collection or globals.', unresolved: true };
  const where = hint.owner ? `${scopeLabel(hint.scope)} "${hint.owner}"` : scopeLabel(hint.scope);
  const shadow = hint.shadowed.length ? ` · also defined in ${hint.shadowed.map((s) => scopeLabel(s.scope).toLowerCase()).join(', ')}` : '';
  const value = hint.secret ? `${MASK} (secret)` : displayValue(hint);
  return { title: `{{${hint.name}}}`, detail: `${where}: ${value}${shadow}`, unresolved: false };
}
