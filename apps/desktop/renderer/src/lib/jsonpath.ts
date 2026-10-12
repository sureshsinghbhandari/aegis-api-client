/**
 * Small, dependency-free JSONPath subset for the response filter box.
 * Supported: `$`, `.name`, `['name']`, `[n]` (negative from the end), `[*]` / `.*`,
 * `..name` / `..[*]` (recursive descent), `[a,b]` and `[0,2]` unions, `[start:end:step]` slices,
 * filters `[?(@.price < 10 && @.tags)]` with `== != < <= > >= && || !`, nested `@.a.b[0]`
 * paths and string/number/boolean/null literals.
 * The expression is parsed into a tiny AST and interpreted: no eval, no Function.
 */

export class JsonPathError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'JsonPathError';
  }
}

type Selector =
  | { kind: 'name'; name: string }
  | { kind: 'wildcard' }
  | { kind: 'index'; index: number }
  | { kind: 'union'; items: Array<string | number> }
  | { kind: 'slice'; start: number | null; end: number | null; step: number | null }
  | { kind: 'filter'; expr: Expr };

interface Segment {
  deep: boolean;
  selector: Selector;
}

type Expr =
  | { t: 'lit'; v: string | number | boolean | null }
  | { t: 'path'; root: '@' | '$'; segments: Segment[] }
  | { t: 'bin'; op: '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'; l: Expr; r: Expr }
  | { t: 'not'; e: Expr };

export interface JsonPathQuery {
  segments: Segment[];
  /** True when every segment selects exactly one child (plain `$.a.b[0]`). */
  definite: boolean;
}

const MAX_EXPRESSION = 1000;
const MAX_RESULTS = 10_000;
const MAX_DEPTH = 200;

class Parser {
  pos = 0;
  constructor(private readonly src: string) {}

  fail(message: string, at = this.pos): never {
    throw new JsonPathError(`${message} (at position ${at + 1})`, at);
  }
  peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }
  eof(): boolean {
    return this.pos >= this.src.length;
  }
  skipWs(): void {
    while (!this.eof() && /\s/.test(this.peek())) this.pos++;
  }
  expect(ch: string): void {
    this.skipWs();
    if (this.peek() !== ch) this.fail(`Expected "${ch}"`);
    this.pos++;
  }
  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  parseRoot(): JsonPathQuery {
    this.skipWs();
    const segments: Segment[] = [];
    if (this.peek() === '$') this.pos++;
    else if (/[A-Za-z_]/.test(this.peek())) segments.push({ deep: false, selector: { kind: 'name', name: this.parseIdentifier() } }); // `store.book` without `$`
    segments.push(...this.parseSegments());
    this.skipWs();
    if (!this.eof()) this.fail(`Unexpected "${this.peek()}"`);
    return { segments, definite: segments.every((s) => !s.deep && (s.selector.kind === 'name' || s.selector.kind === 'index')) };
  }

  parseSegments(): Segment[] {
    const out: Segment[] = [];
    for (;;) {
      this.skipWs();
      if (this.startsWith('..')) {
        this.pos += 2;
        if (this.peek() === '[') out.push({ deep: true, selector: this.parseBracket() });
        else if (this.peek() === '*') {
          this.pos++;
          out.push({ deep: true, selector: { kind: 'wildcard' } });
        } else out.push({ deep: true, selector: { kind: 'name', name: this.parseIdentifier() } });
      } else if (this.peek() === '.') {
        this.pos++;
        if (this.peek() === '*') {
          this.pos++;
          out.push({ deep: false, selector: { kind: 'wildcard' } });
        } else out.push({ deep: false, selector: { kind: 'name', name: this.parseIdentifier() } });
      } else if (this.peek() === '[') {
        out.push({ deep: false, selector: this.parseBracket() });
      } else return out;
    }
  }

  parseIdentifier(): string {
    const m = /^[A-Za-z_$][\w$-]*/.exec(this.src.slice(this.pos));
    if (!m) this.fail('Expected a property name');
    this.pos += m[0].length;
    return m[0];
  }

  parseBracket(): Selector {
    const start = this.pos;
    this.expect('[');
    this.skipWs();
    if (this.peek() === '*') {
      this.pos++;
      this.expect(']');
      return { kind: 'wildcard' };
    }
    if (this.peek() === '?') {
      this.pos++;
      this.expect('(');
      const expr = this.parseOr();
      this.expect(')');
      this.expect(']');
      return { kind: 'filter', expr };
    }
    // slice or union of names/indices
    const items: Array<string | number> = [];
    let slice: { start: number | null; end: number | null; step: number | null } | null = null;
    this.skipWs();
    if (this.peek() === ':' || this.peek() === '-' || /\d/.test(this.peek())) {
      const first = this.peek() === ':' ? null : this.parseInt();
      this.skipWs();
      if (this.peek() === ':') {
        this.pos++;
        this.skipWs();
        const end = this.peek() === ']' || this.peek() === ':' ? null : this.parseInt();
        this.skipWs();
        let step: number | null = null;
        if (this.peek() === ':') {
          this.pos++;
          this.skipWs();
          step = this.peek() === ']' ? null : this.parseInt();
          if (step === 0) this.fail('Slice step must not be 0');
        }
        slice = { start: first, end, step };
      } else {
        items.push(first ?? 0);
      }
    } else if (this.peek() === '"' || this.peek() === "'") {
      items.push(this.parseString());
    } else {
      this.fail('Expected an index, a quoted name, "*" or "?(...)"', start);
    }
    if (slice) {
      this.expect(']');
      return { kind: 'slice', ...slice };
    }
    this.skipWs();
    while (this.peek() === ',') {
      this.pos++;
      this.skipWs();
      if (this.peek() === '"' || this.peek() === "'") items.push(this.parseString());
      else items.push(this.parseInt());
      this.skipWs();
    }
    this.expect(']');
    if (items.length === 1) {
      const only = items[0]!;
      return typeof only === 'number' ? { kind: 'index', index: only } : { kind: 'name', name: only };
    }
    return { kind: 'union', items };
  }

  parseInt(): number {
    const m = /^-?\d+/.exec(this.src.slice(this.pos));
    if (!m) this.fail('Expected a number');
    this.pos += m[0].length;
    return Number(m[0]);
  }

  parseString(): string {
    const quote = this.peek();
    const start = this.pos;
    this.pos++;
    let out = '';
    while (!this.eof() && this.peek() !== quote) {
      if (this.peek() === '\\') {
        this.pos++;
        const esc = this.peek();
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else out += esc;
        this.pos++;
      } else {
        out += this.peek();
        this.pos++;
      }
    }
    if (this.eof()) this.fail('Unterminated string', start);
    this.pos++;
    return out;
  }

  // ---- filter expressions
  parseOr(): Expr {
    let left = this.parseAnd();
    for (;;) {
      this.skipWs();
      if (!this.startsWith('||')) return left;
      this.pos += 2;
      left = { t: 'bin', op: '||', l: left, r: this.parseAnd() };
    }
  }
  parseAnd(): Expr {
    let left = this.parseUnary();
    for (;;) {
      this.skipWs();
      if (!this.startsWith('&&')) return left;
      this.pos += 2;
      left = { t: 'bin', op: '&&', l: left, r: this.parseUnary() };
    }
  }
  parseUnary(): Expr {
    this.skipWs();
    if (this.peek() === '!' && this.peek(1) !== '=') {
      this.pos++;
      return { t: 'not', e: this.parseUnary() };
    }
    if (this.peek() === '(') {
      this.pos++;
      const inner = this.parseOr();
      this.expect(')');
      return inner;
    }
    return this.parseComparison();
  }
  parseComparison(): Expr {
    const left = this.parseOperand();
    this.skipWs();
    for (const op of ['==', '!=', '<=', '>=', '<', '>'] as const) {
      if (this.startsWith(op)) {
        this.pos += op.length;
        if (op === '==' && this.peek() === '=') this.pos++; // tolerate ===
        if (op === '!=' && this.peek() === '=') this.pos++; // tolerate !==
        const right = this.parseOperand();
        return { t: 'bin', op, l: left, r: right };
      }
    }
    return left;
  }
  parseOperand(): Expr {
    this.skipWs();
    const ch = this.peek();
    if (ch === '@' || ch === '$') {
      this.pos++;
      return { t: 'path', root: ch, segments: this.parseSegments() };
    }
    if (ch === '"' || ch === "'") return { t: 'lit', v: this.parseString() };
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (num) {
      this.pos += num[0].length;
      return { t: 'lit', v: Number(num[0]) };
    }
    for (const [word, v] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.startsWith(word) && !/[\w$]/.test(this.peek(word.length))) {
        this.pos += word.length;
        return { t: 'lit', v };
      }
    }
    this.fail('Expected a value or a path starting with "@"');
  }
}

export function parseJsonPath(expression: string): JsonPathQuery {
  if (expression.length > MAX_EXPRESSION) throw new JsonPathError('The expression is too long.', 0);
  return new Parser(expression).parseRoot();
}

// ----------------------------------------------------------------------------- evaluation

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function children(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObject(v)) return Object.values(v);
  return [];
}

/** All descendants of `v` including `v` itself, depth-first, depth-limited. */
function descendants(v: unknown, out: unknown[], depth = 0): void {
  if (depth > MAX_DEPTH || out.length > MAX_RESULTS) return;
  out.push(v);
  for (const c of children(v)) descendants(c, out, depth + 1);
}

function selectIndex(v: unknown, index: number): unknown[] {
  if (!Array.isArray(v)) return [];
  const i = index < 0 ? v.length + index : index;
  return i >= 0 && i < v.length ? [v[i]] : [];
}

function selectName(v: unknown, name: string): unknown[] {
  if (isObject(v) && Object.prototype.hasOwnProperty.call(v, name)) return [v[name]];
  if (Array.isArray(v) && /^-?\d+$/.test(name)) return selectIndex(v, Number(name));
  return [];
}

function applySelector(sel: Selector, v: unknown, root: unknown): unknown[] {
  switch (sel.kind) {
    case 'name':
      return selectName(v, sel.name);
    case 'index':
      return selectIndex(v, sel.index);
    case 'wildcard':
      return children(v);
    case 'union':
      return sel.items.flatMap((it) => (typeof it === 'number' ? selectIndex(v, it) : selectName(v, it)));
    case 'slice': {
      if (!Array.isArray(v)) return [];
      const n = v.length;
      const step = sel.step ?? 1;
      const norm = (x: number | null, def: number) => (x === null ? def : x < 0 ? Math.max(0, n + x) : Math.min(n, x));
      const out: unknown[] = [];
      if (step > 0) {
        for (let i = norm(sel.start, 0); i < norm(sel.end, n); i += step) out.push(v[i]);
      } else {
        const start = sel.start === null ? n - 1 : sel.start < 0 ? n + sel.start : Math.min(n - 1, sel.start);
        const end = sel.end === null ? -1 : sel.end < 0 ? n + sel.end : sel.end;
        for (let i = start; i > end; i += step) if (i >= 0 && i < n) out.push(v[i]);
      }
      return out;
    }
    case 'filter':
      return children(v).filter((c) => truthy(evaluateExpr(sel.expr, c, root)));
  }
}

function applySegments(segments: readonly Segment[], start: unknown, root: unknown): unknown[] {
  let current: unknown[] = [start];
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const v of current) {
      const bases = seg.deep ? (() => {
        const all: unknown[] = [];
        descendants(v, all);
        return all;
      })() : [v];
      for (const b of bases) {
        for (const hit of applySelector(seg.selector, b, root)) {
          next.push(hit);
          if (next.length > MAX_RESULTS) throw new JsonPathError(`More than ${MAX_RESULTS} results; narrow the expression.`, 0);
        }
      }
    }
    current = next;
  }
  return current;
}

type Value = { kind: 'value'; v: unknown } | { kind: 'none' };

function evaluateExpr(e: Expr, item: unknown, root: unknown): Value {
  switch (e.t) {
    case 'lit':
      return { kind: 'value', v: e.v };
    case 'path': {
      const hits = applySegments(e.segments, e.root === '@' ? item : root, root);
      return hits.length === 0 ? { kind: 'none' } : { kind: 'value', v: hits[0] };
    }
    case 'not':
      return { kind: 'value', v: !truthy(evaluateExpr(e.e, item, root)) };
    case 'bin': {
      if (e.op === '&&') return { kind: 'value', v: truthy(evaluateExpr(e.l, item, root)) && truthy(evaluateExpr(e.r, item, root)) };
      if (e.op === '||') return { kind: 'value', v: truthy(evaluateExpr(e.l, item, root)) || truthy(evaluateExpr(e.r, item, root)) };
      const l = evaluateExpr(e.l, item, root);
      const r = evaluateExpr(e.r, item, root);
      if (l.kind === 'none' || r.kind === 'none') return { kind: 'value', v: e.op === '!=' && l.kind !== r.kind };
      return { kind: 'value', v: compare(e.op, l.v, r.v) };
    }
  }
}

function compare(op: '==' | '!=' | '<' | '<=' | '>' | '>=', a: unknown, b: unknown): boolean {
  switch (op) {
    case '==':
      return deepEqual(a, b);
    case '!=':
      return !deepEqual(a, b);
    default: {
      if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) return false;
      const x = a as number | string;
      const y = b as number | string;
      if (op === '<') return x < y;
      if (op === '<=') return x <= y;
      if (op === '>') return x > y;
      return x >= y;
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function truthy(v: Value): boolean {
  if (v.kind === 'none') return false;
  const x = v.v;
  return !(x === false || x === null || x === undefined || x === 0 || x === '');
}

/** Evaluate `expression` against parsed JSON `data`. Throws `JsonPathError` for invalid expressions. */
export function evaluateJsonPath(data: unknown, expression: string): unknown[] {
  return applySegments(parseJsonPath(expression).segments, data, data);
}

export type JsonPathOutcome = { ok: true; results: unknown[]; definite: boolean } | { ok: false; error: string };

/** Filter a JSON text with a JSONPath expression; never throws. */
export function applyJsonPathToText(text: string, expression: string): JsonPathOutcome {
  const expr = expression.trim();
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, error: 'The response body is not valid JSON.' };
  }
  try {
    const query = parseJsonPath(expr);
    return { ok: true, results: applySegments(query.segments, data, data), definite: query.definite };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSONPath expression.' };
  }
}

/** Text shown in the editor for a filter outcome: a single value for definite paths, otherwise the result list. */
export function formatJsonPathResults(outcome: Extract<JsonPathOutcome, { ok: true }>): string {
  const value = outcome.definite && outcome.results.length === 1 ? outcome.results[0] : outcome.results;
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}
