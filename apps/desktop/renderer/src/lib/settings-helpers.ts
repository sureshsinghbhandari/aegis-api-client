import type { EnterprisePolicy, HistoryRetention } from '@aegis/core';

/** Build a nested patch object: buildPatch(['network', 'timeoutMs'], 5) => { network: { timeoutMs: 5 } }. */
export function buildPatch(path: readonly string[], value: unknown): Record<string, unknown> {
  if (path.length === 0) throw new Error('buildPatch needs a non-empty path');
  let acc: unknown = value;
  for (let i = path.length - 1; i >= 0; i--) acc = { [path[i]!]: acc };
  return acc as Record<string, unknown>;
}

/** Returns an error message when `source` is not a valid regular expression source, else null. */
export function validateRegexSource(source: string): string | null {
  if (source.trim() === '') return 'The pattern is empty.';
  if (source.length > 500) return 'The pattern is too long (max 500 characters).';
  try {
    new RegExp(source, 'i');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^Invalid regular expression:\s*/i, '') : 'Invalid regular expression.';
  }
}

/** Parse a user-typed integer, clamped to [min, max]; returns null when it is not a number. */
export function parseBoundedInt(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

const MB = 1024 * 1024;
export const bytesToMb = (bytes: number): number => Math.round((bytes / MB) * 100) / 100;
export const mbToBytes = (mb: number): number => Math.round(mb * MB);

export const RETENTION_OPTIONS: Array<{ value: HistoryRetention; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' },
  { value: 'unlimited', label: 'Unlimited' },
];

/** Maximum script timeout the user may choose given the policy. */
export function maxScriptTimeout(policy: EnterprisePolicy | undefined): number {
  return policy ? Math.max(100, policy.maxScriptTimeoutMs) : 60_000;
}

export interface PolicyLine {
  label: string;
  value: string;
  /** True when the organization restricts the corresponding user setting. */
  enforced: boolean;
}

/** Read-only summary of the enterprise policy; `enforced` marks restrictions that differ from "unrestricted". */
export function policySummary(policy: EnterprisePolicy): PolicyLine[] {
  return [
    { label: 'Disabling TLS verification', value: policy.allowInsecureTls ? 'allowed' : 'not allowed', enforced: !policy.allowInsecureTls },
    { label: 'Production confirmation', value: policy.requireProductionConfirmation ? 'required before sending' : 'not required', enforced: policy.requireProductionConfirmation },
    { label: 'Requests in production environments', value: policy.blockProductionRequests ? 'blocked' : 'allowed', enforced: policy.blockProductionRequests },
    { label: 'Local-only mode', value: policy.enforceLocalOnly ? 'forced on' : 'user choice', enforced: policy.enforceLocalOnly },
    { label: 'Maximum script timeout', value: `${policy.maxScriptTimeoutMs} ms`, enforced: true },
    { label: 'Exporting secrets', value: policy.allowSecretExport ? 'allowed' : 'not allowed', enforced: !policy.allowSecretExport },
    { label: 'Maximum response size', value: `${bytesToMb(policy.maxResponseBytes)} MB`, enforced: true },
    { label: 'Blocked hosts', value: policy.blockedHosts.length ? policy.blockedHosts.join(', ') : 'none', enforced: policy.blockedHosts.length > 0 },
  ];
}

/** Light validation for a proxy URL typed by the user (empty is allowed). */
export function validateProxyUrl(value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`);
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(u.protocol)) return 'Use an http:// or https:// proxy address.';
    if (u.username || u.password) return 'Do not put credentials in the proxy URL; use the username and password fields.';
    return null;
  } catch {
    return 'Enter a valid proxy address such as http://proxy.example.com:8080.';
  }
}

/** Split a pasted PEM bundle check: true when the text looks like a PEM certificate. */
export function looksLikePem(text: string, label: 'CERTIFICATE' | 'PRIVATE KEY'): boolean {
  if (label === 'CERTIFICATE') return /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(text);
  return /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]+-----END (?:[A-Z]+ )?PRIVATE KEY-----/.test(text);
}

/** Group items by `domain` (leading dot removed, lower-case), domains sorted alphabetically. */
export function groupByDomain<T extends { domain: string }>(items: T[]): Array<{ domain: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const key = it.domain.replace(/^\./, '').toLowerCase();
    const list = map.get(key) ?? [];
    list.push(it);
    map.set(key, list);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([domain, list]) => ({ domain, items: list }));
}
