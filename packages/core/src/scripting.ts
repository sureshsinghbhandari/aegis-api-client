/**
 * Contract between the application and the script sandbox (`@aegis/scripting`).
 * Everything crossing the sandbox boundary is plain JSON.
 */
import type { HeaderPair } from './http';
import type { KeyValueEntry } from './model';

export type ScriptPhase = 'prerequest' | 'test';

export type VariableScopeName = 'globals' | 'environment' | 'collectionVariables' | 'variables' | 'iterationData';

/** Flat string maps for every variable scope visible to a script. */
export type ScriptVariableState = Record<VariableScopeName, Record<string, string>>;

export interface ScriptRequestSnapshot {
  method: string;
  /** The raw (non-interpolated at snapshot time) URL as a string. */
  url: string;
  headers: KeyValueEntry[];
  body: {
    mode: 'none' | 'raw' | 'urlencoded' | 'formdata' | 'binary';
    raw?: string;
    rawLanguage?: string;
    urlencoded?: KeyValueEntry[];
    formdata?: Array<{ key: string; value: string; type: string; enabled: boolean }>;
  };
}

export interface ScriptCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

export interface ScriptResponseSnapshot {
  code: number;
  status: string;
  headers: HeaderPair[];
  /** Body decoded as UTF-8 text (binary responses are lossy). */
  bodyText: string;
  responseTimeMs: number;
  responseSizeBytes: number;
  cookies: ScriptCookie[];
}

export interface ScriptInfo {
  eventName: ScriptPhase;
  iteration: number;
  iterationCount: number;
  requestName: string;
  requestId: string;
}

/** A request issued from a script via `pm.sendRequest`. */
export interface ScriptSendRequest {
  url: string;
  method: string;
  headers: HeaderPair[];
  body?: {
    mode: 'raw' | 'urlencoded' | 'formdata';
    raw?: string;
    urlencoded?: Array<{ key: string; value: string }>;
    formdata?: Array<{ key: string; value: string }>;
  };
  timeoutMs?: number;
}

export interface ScriptSendResponse {
  code: number;
  status: string;
  headers: HeaderPair[];
  bodyText: string;
  responseTimeMs: number;
  responseSizeBytes: number;
  cookies: ScriptCookie[];
}

export interface ScriptHost {
  /**
   * Execute a nested request. The implementation MUST apply the same
   * security policies (TLS, proxy, local-only, size and timeout limits) as a
   * normal request and honor `signal`.
   */
  sendRequest(request: ScriptSendRequest, signal: AbortSignal): Promise<ScriptSendResponse>;
}

export interface ScriptLimits {
  /** Total wall-clock budget for the script including pm.sendRequest waits. Default 5000. */
  timeoutMs: number;
  memoryLimitBytes: number;
  maxStackSizeBytes?: number;
  /** Maximum number of nested pm.sendRequest calls per script. */
  maxSendRequests?: number;
}

export interface ScriptRunInput {
  phase: ScriptPhase;
  /** Human-readable origin for diagnostics, e.g. "collection pre-request". */
  origin: string;
  source: string;
  variables: ScriptVariableState;
  request: ScriptRequestSnapshot;
  response?: ScriptResponseSnapshot;
  cookies: ScriptCookie[];
  info: ScriptInfo;
  limits: ScriptLimits;
  /** Secret values that must be redacted from console output. */
  secretValues?: string[];
  host: ScriptHost;
  signal?: AbortSignal;
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: number;
  origin?: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  durationMs: number;
  error?: string;
  origin?: string;
}

export interface ScopeChanges {
  set: Record<string, string>;
  unset: string[];
  cleared: boolean;
}

export interface ScriptRunResult {
  ok: boolean;
  /** Present when the script threw, timed out or exceeded limits. */
  error?: { code: 'SCRIPT_ERROR' | 'SCRIPT_TIMEOUT' | 'SCRIPT_MEMORY'; name: string; message: string; stack?: string };
  durationMs: number;
  console: ConsoleEntry[];
  tests: TestResult[];
  /** Final variable state after the script ran. */
  variables: ScriptVariableState;
  /** What the script changed per scope (relative to the input state). */
  changes: Record<VariableScopeName, ScopeChanges>;
  /** Final `pm.request` (pre-request scripts may modify it). */
  request: ScriptRequestSnapshot;
  skipRequest: boolean;
  /** `undefined` = not called; `null` = setNextRequest(null) (stop run); string = request name/id. */
  nextRequest?: string | null;
}
