import type { FormDataEntry, KeyValueEntry, RequestBody, RequestDraft, VariableEntry } from '@aegis/core';
import { createDefaultDynamicRegistry, type DynamicVariableRegistry } from './dynamic';

/**
 * Variable precedence, highest first. This is the ONLY place the order is defined.
 *
 *   request > local > iteration(data) > environment > folder(innermost first) > collection > global
 */
export const VARIABLE_PRECEDENCE = ['request', 'local', 'iteration', 'environment', 'folder', 'collection', 'global'] as const;
export type VariableScopeKind = (typeof VARIABLE_PRECEDENCE)[number];

export interface VariableValue {
  value: string;
  secret: boolean;
}

export type ScopeMap = ReadonlyMap<string, VariableValue>;

export interface VariableScopes {
  request?: ScopeMap;
  local?: ScopeMap;
  iteration?: ScopeMap;
  environment?: ScopeMap;
  /** Innermost folder first. */
  folders?: ScopeMap[];
  collection?: ScopeMap;
  global?: ScopeMap;
}

export interface LookupResult extends VariableValue {
  scope: VariableScopeKind;
}

/** Build a scope from stored variable rows. Disabled rows are skipped; current value wins over initial. */
export function scopeFromEntries(entries: readonly VariableEntry[]): Map<string, VariableValue> {
  const map = new Map<string, VariableValue>();
  for (const e of entries) {
    if (!e.enabled || !e.key) continue;
    const value = e.currentValue !== undefined && e.currentValue !== '' ? e.currentValue : e.initialValue;
    map.set(e.key, { value, secret: e.isSecret });
  }
  return map;
}

export function scopeFromRecord(record: Readonly<Record<string, string>>, secret = false): Map<string, VariableValue> {
  const map = new Map<string, VariableValue>();
  for (const [k, v] of Object.entries(record)) map.set(k, { value: v, secret });
  return map;
}

export interface ResolveOptions {
  /** Maximum nesting depth for variables whose values reference other variables. */
  maxDepth?: number;
}

const VAR_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * The single variable resolver. Unresolved `{{name}}` references are left
 * untouched (like Postman), so a missing variable is visible in the request.
 */
export class VariableResolver {
  constructor(
    private readonly scopes: VariableScopes,
    private readonly dynamic: DynamicVariableRegistry = createDefaultDynamicRegistry(),
  ) {}

  lookup(name: string): LookupResult | undefined {
    for (const kind of VARIABLE_PRECEDENCE) {
      if (kind === 'folder') {
        for (const folder of this.scopes.folders ?? []) {
          const hit = folder.get(name);
          if (hit) return { ...hit, scope: 'folder' };
        }
        continue;
      }
      const hit = this.scopes[kind]?.get(name);
      if (hit) return { ...hit, scope: kind };
    }
    return undefined;
  }

  /** Values of every secret variable currently visible, for redaction. */
  secretValues(): string[] {
    const out = new Set<string>();
    const scopes: Array<ScopeMap | undefined> = [
      this.scopes.request,
      this.scopes.local,
      this.scopes.iteration,
      this.scopes.environment,
      ...(this.scopes.folders ?? []),
      this.scopes.collection,
      this.scopes.global,
    ];
    for (const scope of scopes) {
      if (!scope) continue;
      for (const v of scope.values()) if (v.secret && v.value) out.add(v.value);
    }
    return [...out];
  }

  /** Names of `{{variables}}` in `input` that cannot be resolved. */
  unresolved(input: string): string[] {
    const missing = new Set<string>();
    for (const m of input.matchAll(VAR_PATTERN)) {
      const name = m[1]!;
      if (!this.lookup(name) && this.dynamic.resolve(name) === undefined) missing.add(name);
    }
    return [...missing];
  }

  resolveString(input: string, options: ResolveOptions = {}): string {
    return this.resolveInternal(input, options.maxDepth ?? 5, new Set());
  }

  private resolveInternal(input: string, depth: number, stack: Set<string>): string {
    if (!input || !input.includes('{{')) return input;
    return input.replace(VAR_PATTERN, (match, rawName: string) => {
      const name = rawName.trim();
      if (name.startsWith('$')) {
        return this.dynamic.resolve(name) ?? match;
      }
      const hit = this.lookup(name);
      if (!hit) return match;
      if (depth <= 0 || stack.has(name)) return hit.value; // cycle or too deep: use the raw value
      stack.add(name);
      const resolved = this.resolveInternal(hit.value, depth - 1, stack);
      stack.delete(name);
      return resolved;
    });
  }

  resolveUrl(url: string): string {
    return this.resolveString(url);
  }

  resolveEntries(entries: readonly KeyValueEntry[]): KeyValueEntry[] {
    return entries.map((e) => ({ ...e, key: this.resolveString(e.key), value: this.resolveString(e.value) }));
  }

  resolveHeaders(headers: readonly KeyValueEntry[]): KeyValueEntry[] {
    return this.resolveEntries(headers);
  }

  resolveBody(body: RequestBody): RequestBody {
    const out: RequestBody = { ...body };
    if (body.raw !== undefined) out.raw = this.resolveString(body.raw);
    if (body.filePath !== undefined) out.filePath = this.resolveString(body.filePath);
    if (body.urlencoded) out.urlencoded = this.resolveEntries(body.urlencoded);
    if (body.graphql) {
      out.graphql = { ...body.graphql, query: this.resolveString(body.graphql.query), variables: this.resolveString(body.graphql.variables) };
      if (body.graphql.operationName !== undefined) out.graphql.operationName = this.resolveString(body.graphql.operationName);
    }
    if (body.formData) {
      out.formData = body.formData.map((f): FormDataEntry => {
        if (f.type === 'variable') {
          // `value` names a variable; resolve it to its value.
          const hit = this.lookup(f.value.trim());
          return { ...f, key: this.resolveString(f.key), type: 'text', value: hit ? this.resolveString(hit.value) : '' };
        }
        const resolved: FormDataEntry = { ...f, key: this.resolveString(f.key), value: this.resolveString(f.value) };
        if (f.filePath !== undefined) resolved.filePath = this.resolveString(f.filePath);
        return resolved;
      });
    }
    return out;
  }

  /** Interpolate every string field of a request. Returns a new object; the stored request is never mutated. */
  resolveRequest(request: RequestDraft): RequestDraft {
    return {
      ...request,
      url: this.resolveUrl(request.url),
      headers: this.resolveHeaders(request.headers),
      queryParams: this.resolveEntries(request.queryParams),
      pathVariables: this.resolveEntries(request.pathVariables),
      body: this.resolveBody(request.body),
    };
  }
}
