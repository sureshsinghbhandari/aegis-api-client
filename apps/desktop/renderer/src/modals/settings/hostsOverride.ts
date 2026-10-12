/** Pure helpers for the host-override editor (Settings -> Network). No React. */
import type { HostOverride } from '@aegis/core';

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^\[?[0-9a-f:]+(%[a-z0-9]+)?\]?$/i;

/** True for a syntactically valid host name (no scheme, port or path). */
export function isValidHostName(host: string): boolean {
  const h = host.trim().replace(/\.$/, '');
  if (h === '' || h.length > 253) return false;
  return h.split('.').every((label) => HOST_LABEL.test(label));
}

/** True for an IPv4 or IPv6 literal (brackets optional). */
export function isIpLiteral(address: string): boolean {
  const a = address.trim();
  if (IPV4.test(a)) return true;
  const bare = a.replace(/^\[|\]$/g, '');
  return IPV6.test(a) && bare.includes(':') && bare.split('::').length <= 2 && bare.split(':').every((g) => g === '' || /^[0-9a-f]{1,4}(%[a-z0-9]+)?$/i.test(g));
}

/** Error message for one override row, or null when it is valid. */
export function validateHostOverride(entry: HostOverride): string | null {
  if (!isValidHostName(entry.host)) return 'Enter a host name such as api.example.com (no scheme, port or path).';
  if (!isIpLiteral(entry.address)) return 'Enter an IPv4 or IPv6 address.';
  return null;
}

/** Normalised copy of `entries` with blank rows removed and hosts lower-cased; later rows win on duplicates. */
export function normalizeHostOverrides(entries: readonly HostOverride[]): HostOverride[] {
  const map = new Map<string, string>();
  for (const e of entries) {
    const host = e.host.trim().toLowerCase().replace(/\.$/, '');
    const address = e.address.trim().replace(/^\[|\]$/g, '');
    if (host === '' && address === '') continue;
    map.set(host, address);
  }
  return [...map.entries()].map(([host, address]) => ({ host, address }));
}

/** Parse the bulk text form: one `host address` (or `host=address`, `address host` like /etc/hosts) per line; `#` comments ignored. */
export function parseHostsText(text: string): HostOverride[] {
  const out: HostOverride[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/[\s=]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const [a, b] = parts as [string, string];
    // hosts-file order (address first) is accepted too
    if (isIpLiteral(a) && !isIpLiteral(b)) out.push({ host: b, address: a });
    else out.push({ host: a, address: b });
  }
  return normalizeHostOverrides(out);
}
