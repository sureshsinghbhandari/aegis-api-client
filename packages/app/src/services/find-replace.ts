import { AppError, FIND_REPLACE_SCOPES, type FindReplaceInput, type FindReplaceResult, type FindReplaceScope } from '@aegis/core';
import { mergeFindReplaceResults, type Repositories, type TextReplacer } from '@aegis/storage';
import type { AppContext } from '../context';

/**
 * Find & replace across collections. The pattern is compiled ONCE here (literal, whole word or a
 * bounded regular expression); the storage layer applies it field by field inside one SQLite
 * transaction and skips `secretref:` values, secret variables and auth credentials entirely.
 */

/** Longest accepted pattern (regex or literal). */
export const MAX_PATTERN_LENGTH = 500;
/** Wall-clock budget for evaluating the pattern over the whole run. */
export const DEFAULT_BUDGET_MS = 2_000;
/** Excerpts returned for the preview. */
export const MAX_SAMPLES = 25;

export interface PatternOptions {
  find: string;
  matchCase?: boolean | undefined;
  wholeWord?: boolean | undefined;
  useRegex?: boolean | undefined;
}

export interface ReplacerOptions extends PatternOptions {
  replace: string;
  /** Override for tests. */
  budgetMs?: number | undefined;
}

const UNBOUNDED = /^[*+]|^\{\d*,\s*\d*\}|^\{\d+\}/;

/** `true` when a quantifier with max > 1 follows at `i` (e.g. `*`, `+`, `{2,}`, `{3}`; `?` and `{0,1}` do not count). */
function unboundedQuantifierAt(source: string, i: number): boolean {
  const rest = source.slice(i, i + 24);
  const m = UNBOUNDED.exec(rest);
  if (!m) return false;
  if (m[0] === '*' || m[0] === '+') return true;
  const range = /^\{(\d*),?\s*(\d*)\}/.exec(m[0]);
  if (!range) return false;
  const [, lo = '', hi = ''] = range;
  if (m[0].includes(',')) return hi === '' || Number(hi) > 1;
  return Number(lo) > 1;
}

/**
 * Static ReDoS heuristic: a group that is itself repeated (`*`, `+`, `{n,}`) and contains another
 * unbounded quantifier, e.g. `(a+)+`, `(\d*)*`, `((ab)+)*`, `(x{2,})+`. Escapes and character classes are skipped.
 */
export function hasNestedQuantifier(source: string): boolean {
  const stack: boolean[] = []; // per open group: contains an unbounded quantifier?
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      stack.push(false);
      continue;
    }
    if (ch === ')') {
      const inner = stack.pop() ?? false;
      if (unboundedQuantifierAt(source, i + 1)) {
        if (inner) return true;
        if (stack.length) stack[stack.length - 1] = true;
      } else if (inner && stack.length) {
        stack[stack.length - 1] = true;
      }
      continue;
    }
    if (unboundedQuantifierAt(source, i) && stack.length) stack[stack.length - 1] = true;
  }
  return false;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function tryCompile(source: string, flags: string): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** Compile the search pattern with the `g` flag. Throws `VALIDATION_FAILED` for empty, oversized, invalid or dangerous patterns. */
export function compileFindPattern(options: PatternOptions): RegExp {
  const { find } = options;
  if (find === '') throw new AppError('VALIDATION_FAILED', 'Enter text to find.');
  if (find.length > MAX_PATTERN_LENGTH) throw new AppError('VALIDATION_FAILED', `The search pattern is too long (max ${MAX_PATTERN_LENGTH} characters).`);
  let source = options.useRegex ? find : escapeRegex(find);
  if (options.useRegex && hasNestedQuantifier(find)) {
    throw new AppError('VALIDATION_FAILED', 'This regular expression nests repetition (such as (a+)+) and could take forever to evaluate. Simplify it.');
  }
  const base = `g${options.matchCase ? '' : 'i'}`;
  // Unicode mode gives proper word boundaries; fall back to legacy mode when the user's pattern only compiles there.
  const unicode = tryCompile(source, `${base}u`) !== null;
  if (options.wholeWord) source = unicode ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : `(?<!\\w)(?:${source})(?!\\w)`;
  const re = tryCompile(source, unicode ? `${base}u` : base);
  if (!re) {
    const reason = (() => {
      try {
        new RegExp(find);
        return '';
      } catch (e) {
        return e instanceof Error ? e.message.replace(/^Invalid regular expression:\s*/i, '') : '';
      }
    })();
    throw new AppError('VALIDATION_FAILED', `The regular expression is not valid${reason ? `: ${reason}` : '.'}`);
  }
  const probe = new RegExp(re.source, re.flags.replace('g', ''));
  if (probe.test('')) throw new AppError('VALIDATION_FAILED', 'The pattern matches the empty string, which would insert the replacement everywhere.');
  return re;
}

/** Build the substitution used by the repository: counting, first index and replacement under a time budget. */
export function createReplacer(options: ReplacerOptions): TextReplacer {
  const re = compileFindPattern(options);
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const literal = !options.useRegex;
  const replacement = options.replace;
  let started = 0;
  const tick = () => {
    const now = Date.now();
    if (!started) started = now;
    if (now - started > budget) throw new AppError('VALIDATION_FAILED', 'Find & replace took too long to evaluate the pattern. Nothing was changed; simplify the pattern or narrow the scope.');
  };
  const count = (text: string): number => {
    tick();
    let n = 0;
    re.lastIndex = 0;
    for (;;) {
      const m = re.exec(text);
      if (!m) break;
      n += 1;
      if (m[0] === '') re.lastIndex += 1;
      if ((n & 1023) === 0) tick();
    }
    re.lastIndex = 0;
    return n;
  };
  return {
    count,
    firstIndex: (text) => {
      tick();
      re.lastIndex = 0;
      const m = re.exec(text);
      re.lastIndex = 0;
      return m ? m.index : -1;
    },
    apply: (text) => {
      tick();
      re.lastIndex = 0;
      // Literal replacements must not interpret `$&`, `$1`, ... ; regex replacements may.
      const out = literal ? text.replace(re, () => replacement) : text.replace(re, replacement);
      re.lastIndex = 0;
      return out;
    },
  };
}

function validScopes(scopes: readonly FindReplaceScope[]): FindReplaceScope[] {
  const set = new Set<FindReplaceScope>();
  for (const s of scopes) if ((FIND_REPLACE_SCOPES as readonly string[]).includes(s)) set.add(s);
  if (set.size === 0) throw new AppError('VALIDATION_FAILED', 'Select at least one scope (URL, params, headers, body, scripts, descriptions or variables).');
  return [...set];
}

/**
 * Preview (`apply: false`) or apply find & replace over one collection or every collection of a
 * workspace. Applying runs in ONE transaction (any failure rolls everything back) and writes an audit
 * entry with counts only: never the searched or replacement text.
 */
export function runFindReplace(ctx: AppContext, input: FindReplaceInput): FindReplaceResult {
  const repos = ctx.storage.repos;
  const scopes = validScopes(input.scopes);
  const apply = input.apply === true;
  let collectionIds: string[];
  if (input.collectionId) {
    repos.collections.requireCollection(input.collectionId);
    collectionIds = [input.collectionId];
  } else if (input.workspaceId) {
    repos.workspaces.require(input.workspaceId);
    collectionIds = repos.collections.listCollections(input.workspaceId).map((c) => c.id);
  } else {
    throw new AppError('VALIDATION_FAILED', 'Choose a collection or a workspace to search.');
  }
  const replacer = createReplacer({ find: input.find, replace: input.replace, matchCase: input.matchCase, wholeWord: input.wholeWord, useRegex: input.useRegex });
  const run = (r: Repositories): FindReplaceResult =>
    mergeFindReplaceResults(
      collectionIds.map((id) => r.collections.findReplace(id, { scopes, replacer, apply, maxSamples: MAX_SAMPLES })),
      apply,
      MAX_SAMPLES,
    );
  const result = apply ? ctx.storage.transaction(run) : run(repos);
  if (apply) {
    ctx.deps.audit.log('FIND_REPLACE', {
      target: input.collectionId ? 'collection' : 'workspace',
      collectionsSearched: collectionIds.length,
      scopes,
      matchCase: !!input.matchCase,
      wholeWord: !!input.wholeWord,
      regex: !!input.useRegex,
      findLength: input.find.length,
      replaceLength: input.replace.length,
      matches: result.matches,
      requests: result.requests,
      folders: result.folders,
      variables: result.variables,
      collections: result.collections,
    });
  }
  return result;
}
