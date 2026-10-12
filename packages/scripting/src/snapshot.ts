import type {
  KeyValueEntry,
  ScopeChanges,
  ScriptRequestSnapshot,
  ScriptRunInput,
  ScriptVariableState,
  TestResult,
  VariableScopeName,
} from '@aegis/core';
import { MAX_TESTS, MAX_VISUALIZER_CHARS } from './limits';

export const SCOPE_NAMES: readonly VariableScopeName[] = ['globals', 'environment', 'collectionVariables', 'variables', 'iterationData'];

/**
 * Everything coming out of the guest is UNTRUSTED (a script can replace any
 * guest-side object). It is parsed from JSON and re-validated field by field;
 * records are built with defineProperty so a "__proto__" key stays plain data.
 */
export interface GuestSnapshot {
  variables: ScriptVariableState;
  cleared: Record<VariableScopeName, boolean>;
  tests: TestResult[];
  request: ScriptRequestSnapshot | undefined;
  skipRequest: boolean;
  nextRequest: { called: boolean; value: string | null };
  /** Raw (unsanitised) HTML from `pm.visualizer.set()`, size-capped. */
  visualizer: string | undefined;
}

type Json = unknown;

function isRecord(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function parseStringRecord(v: Json): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(v)) return out;
  for (const key of Object.keys(v)) {
    const value = v[key];
    setOwn(out, key, typeof value === 'string' ? value : String(value));
  }
  return out;
}

function str(v: Json, fallback: string, max = 1_000_000): string {
  return typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : fallback;
}

function parseKeyValues(v: Json): KeyValueEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: KeyValueEntry[] = [];
  for (const e of v) {
    if (!isRecord(e)) continue;
    const entry: KeyValueEntry = { key: str(e.key, ''), value: str(e.value, ''), enabled: e.enabled !== false };
    if (typeof e.description === 'string') entry.description = e.description;
    out.push(entry);
  }
  return out;
}

const BODY_MODES = ['none', 'raw', 'urlencoded', 'formdata', 'binary'] as const;

function parseRequest(v: Json, fallback: ScriptRequestSnapshot): ScriptRequestSnapshot | undefined {
  if (!isRecord(v)) return undefined;
  const body = isRecord(v.body) ? v.body : {};
  const mode = BODY_MODES.find((m) => m === body.mode) ?? fallback.body.mode;
  const outBody: ScriptRequestSnapshot['body'] = { mode };
  if (typeof body.raw === 'string') outBody.raw = body.raw;
  if (typeof body.rawLanguage === 'string') outBody.rawLanguage = body.rawLanguage;
  const urlencoded = parseKeyValues(body.urlencoded);
  if (urlencoded) outBody.urlencoded = urlencoded;
  if (Array.isArray(body.formdata)) {
    outBody.formdata = body.formdata.filter(isRecord).map((e) => ({
      key: str(e.key, ''),
      value: str(e.value, ''),
      type: str(e.type, 'text', 32),
      enabled: e.enabled !== false,
    }));
  }
  return {
    method: str(v.method, fallback.method, 256) || fallback.method,
    url: str(v.url, fallback.url),
    headers: parseKeyValues(v.headers) ?? fallback.headers,
    body: outBody,
  };
}

export function parseGuestSnapshot(json: string, input: ScriptRunInput, redact: (s: string) => string): GuestSnapshot | undefined {
  let raw: Json;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || !isRecord(raw.variables)) return undefined;

  const variables = {} as ScriptVariableState;
  const cleared = {} as Record<VariableScopeName, boolean>;
  const clearedRaw = isRecord(raw.cleared) ? raw.cleared : {};
  for (const name of SCOPE_NAMES) {
    variables[name] = parseStringRecord(raw.variables[name]);
    cleared[name] = clearedRaw[name] === true;
  }

  const tests: TestResult[] = [];
  if (Array.isArray(raw.tests)) {
    for (const t of raw.tests.slice(0, MAX_TESTS)) {
      if (!isRecord(t)) continue;
      const result: TestResult = {
        name: redact(str(t.name, '(unnamed)', 1024)),
        passed: t.passed === true,
        durationMs: typeof t.durationMs === 'number' && Number.isFinite(t.durationMs) ? t.durationMs : 0,
        origin: input.origin,
      };
      if (t.skipped === true) result.skipped = true;
      if (typeof t.error === 'string') result.error = redact(t.error.slice(0, 4096));
      tests.push(result);
    }
  }

  const next = isRecord(raw.nextRequest) ? raw.nextRequest : {};
  return {
    variables,
    cleared,
    tests,
    request: input.phase === 'prerequest' ? parseRequest(raw.request, input.request) : undefined,
    skipRequest: input.phase === 'prerequest' && raw.skipRequest === true,
    nextRequest: { called: next.called === true, value: typeof next.value === 'string' ? next.value : null },
    visualizer: typeof raw.visualizer === 'string' ? raw.visualizer.slice(0, MAX_VISUALIZER_CHARS) : undefined,
  };
}

export function emptyChanges(): Record<VariableScopeName, ScopeChanges> {
  const out = {} as Record<VariableScopeName, ScopeChanges>;
  for (const name of SCOPE_NAMES) out[name] = { set: {}, unset: [], cleared: false };
  return out;
}

/** Diff input vs final state. After `clear()` the consumer wipes the scope and applies `set`, which then holds the full final content. */
export function computeChanges(
  before: ScriptVariableState,
  after: ScriptVariableState,
  cleared: Record<VariableScopeName, boolean>,
): Record<VariableScopeName, ScopeChanges> {
  const out = emptyChanges();
  for (const name of SCOPE_NAMES) {
    const prev = before[name] ?? {};
    const next = after[name];
    const changes = out[name];
    if (cleared[name]) {
      changes.cleared = true;
      for (const key of Object.keys(next)) setOwn(changes.set, key, next[key]!);
      continue;
    }
    for (const key of Object.keys(next)) {
      if (!Object.hasOwn(prev, key) || prev[key] !== next[key]) setOwn(changes.set, key, next[key]!);
    }
    for (const key of Object.keys(prev)) if (!Object.hasOwn(next, key)) changes.unset.push(key);
  }
  return out;
}
