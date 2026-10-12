import { existsSync, readFileSync } from 'node:fs';
import { AppError, DEFAULT_POLICY, type AppSettings, type EnterprisePolicy } from '@aegis/core';

/** Read a policy file if it exists; `null` when it does not. Errors propagate (handled by the caller). */
function readPolicyFile(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * Load the first readable policy file among `candidates` (undefined entries are skipped). A missing
 * file falls through to the next candidate; a broken file (unreadable or invalid JSON) also falls
 * through, because a corrupt policy must never silently weaken policy: the defaults are restrictive.
 * Returns the defaults when no candidate applies. Shared by the desktop main process and the CLI.
 */
export function loadPolicyFromFiles(candidates: ReadonlyArray<string | undefined>, read: (file: string) => string | null = readPolicyFile): { policy: PolicyService; file: string | null } {
  for (const file of candidates) {
    if (!file) continue;
    try {
      const text = read(file);
      if (text === null) continue;
      return { policy: new PolicyService(parsePolicy(JSON.parse(text))), file };
    } catch {
      /* fall through to the next candidate / defaults */
    }
  }
  return { policy: new PolicyService(DEFAULT_POLICY), file: null };
}

/** Merge an untrusted policy document over the defaults, keeping only known, correctly typed keys. */
export function parsePolicy(raw: unknown): EnterprisePolicy {
  const out: EnterprisePolicy = { ...DEFAULT_POLICY, blockedHosts: [...DEFAULT_POLICY.blockedHosts] };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_POLICY) as Array<keyof EnterprisePolicy>) {
    const def = DEFAULT_POLICY[key];
    const v = r[key];
    if (v === undefined) continue;
    if (Array.isArray(def)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) (out[key] as string[]) = v as string[];
    } else if (typeof v === typeof def) {
      (out[key] as unknown) = v;
    }
  }
  return out;
}

export class PolicyService {
  constructor(private policy: EnterprisePolicy = DEFAULT_POLICY) {}

  get current(): EnterprisePolicy {
    return this.policy;
  }

  setPolicy(policy: EnterprisePolicy): void {
    this.policy = policy;
  }

  /** User settings clamped by what policy permits. */
  effectiveSettings(settings: AppSettings): AppSettings {
    const p = this.policy;
    return {
      ...settings,
      network: {
        ...settings.network,
        verifyTls: p.allowInsecureTls ? settings.network.verifyTls : true,
        maxResponseBytes: Math.min(settings.network.maxResponseBytes, p.maxResponseBytes),
      },
      scripting: { ...settings.scripting, timeoutMs: Math.min(settings.scripting.timeoutMs, p.maxScriptTimeoutMs) },
      security: { ...settings.security, localOnly: p.enforceLocalOnly ? true : settings.security.localOnly },
    };
  }

  assertCanDisableTlsVerification(): void {
    if (!this.policy.allowInsecureTls) {
      throw new AppError('POLICY_VIOLATION', 'Organization policy does not allow disabling certificate validation.');
    }
  }

  assertCanExportSecrets(): void {
    if (!this.policy.allowSecretExport) {
      throw new AppError('POLICY_VIOLATION', 'Organization policy does not allow exporting secrets.');
    }
  }

  /** Throws when a request to `hostname` is not permitted. */
  assertHostAllowed(hostname: string): void {
    const host = hostname.toLowerCase();
    for (const pattern of this.policy.blockedHosts) {
      const p = pattern.toLowerCase();
      if (p === host || (p.startsWith('*.') && host.endsWith(p.slice(1)))) {
        throw new AppError('POLICY_VIOLATION', `Organization policy blocks requests to ${hostname}.`, { hostname });
      }
    }
  }

  /** Production safety: returns what must happen before a request in a production environment is sent. */
  productionGate(isProduction: boolean): 'allow' | 'confirm' | 'block' {
    if (!isProduction) return 'allow';
    if (this.policy.blockProductionRequests) return 'block';
    return this.policy.requireProductionConfirmation ? 'confirm' : 'allow';
  }
}
