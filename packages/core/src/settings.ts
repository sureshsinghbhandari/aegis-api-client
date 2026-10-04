export type ThemePreference = 'system' | 'dark' | 'light';
export type HistoryRetention = '7d' | '30d' | '90d' | '1y' | 'unlimited';

export interface ProxySettings {
  mode: 'none' | 'system' | 'manual';
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
  username: string;
  /** Proxy password lives in the secret store; this only flags that one is set. */
  hasPassword: boolean;
}

export interface AppSettings {
  appearance: { theme: ThemePreference };
  history: {
    enabled: boolean;
    storeRequestBodies: boolean;
    storeResponseBodies: boolean;
    retention: HistoryRetention;
  };
  network: {
    timeoutMs: number;
    followRedirects: boolean;
    maxRedirects: number;
    maxResponseBytes: number;
    maxRequestBytes: number;
    /** Honored only when enterprise policy allows disabling certificate validation. */
    verifyTls: boolean;
    proxy: ProxySettings;
  };
  scripting: { timeoutMs: number; memoryLimitMb: number };
  security: {
    /** When true the app never makes network calls other than user-initiated API traffic. */
    localOnly: boolean;
    /** Additional case-insensitive redaction patterns (regular expression sources). */
    redactionPatterns: string[];
    auditLogEnabled: boolean;
    developerMode: boolean;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { theme: 'system' },
  history: { enabled: true, storeRequestBodies: false, storeResponseBodies: false, retention: '30d' },
  network: {
    timeoutMs: 30_000,
    followRedirects: true,
    maxRedirects: 10,
    maxResponseBytes: 100 * 1024 * 1024,
    maxRequestBytes: 100 * 1024 * 1024,
    verifyTls: true,
    proxy: { mode: 'system', httpProxy: '', httpsProxy: '', noProxy: '', username: '', hasPassword: false },
  },
  scripting: { timeoutMs: 5_000, memoryLimitMb: 64 },
  security: { localOnly: true, redactionPatterns: [], auditLogEnabled: true, developerMode: false },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge `patch` into `base` without mutating either. Unknown keys in `patch` are ignored. */
export function mergeSettings<T extends object>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(base)) {
    const b = (base as Record<string, unknown>)[key];
    if (!(key in patch)) continue;
    const p = patch[key];
    if (isPlainObject(b)) out[key] = mergeSettings(b, p);
    else if (typeof p === typeof b || (Array.isArray(b) && Array.isArray(p))) out[key] = p;
  }
  return out as T;
}

/** Enterprise policy; administrators supply this file, users cannot override it. */
export interface EnterprisePolicy {
  /** If false the UI/engine never allows disabling TLS verification. Default false. */
  allowInsecureTls: boolean;
  /** If true, sending a request while a production environment is active requires confirmation. */
  requireProductionConfirmation: boolean;
  /** If true, sending requests in a production environment is blocked entirely. */
  blockProductionRequests: boolean;
  /** Force local-only mode on (no optional network features). */
  enforceLocalOnly: boolean;
  /** Upper bound for script timeout. */
  maxScriptTimeoutMs: number;
  /** Whether secrets may be exported at all. */
  allowSecretExport: boolean;
  /** Upper bound for max response size. */
  maxResponseBytes: number;
  /** Hosts (exact or `*.suffix`) that requests may never be sent to. */
  blockedHosts: string[];
}

export const DEFAULT_POLICY: EnterprisePolicy = {
  allowInsecureTls: false,
  requireProductionConfirmation: true,
  blockProductionRequests: false,
  enforceLocalOnly: false,
  maxScriptTimeoutMs: 60_000,
  allowSecretExport: true,
  maxResponseBytes: 1024 * 1024 * 1024,
  blockedHosts: [],
};
