import { isIP } from 'node:net';
import { resolveProxyFromEnv, type NetworkLimits } from '@aegis/http-client';
import type { EnterprisePolicy, HostOverride, HttpVersionPreference, ProxyOptions, TlsOptions } from '@aegis/core';
import type { AppContext } from './context';

export const PROXY_PASSWORD_KEY = 'proxy:password';

export interface NetworkConfig {
  tls: TlsOptions;
  proxy?: ProxyOptions;
  limits: NetworkLimits;
  /** Global HTTP version preference (per-request settings may override). */
  httpVersion: HttpVersionPreference;
  /** Host overrides (host -> IP literal) after policy filtering; empty when policy forbids them. */
  hosts: Record<string, string>;
  /** Only root for relative upload paths; undefined when not configured. */
  workingDirectory?: string;
  /** Notes for the Timeline / warnings (e.g. overrides ignored by policy). */
  notes: string[];
}

/**
 * Valid host overrides as a lookup map. Entries with an empty host or a non-IP address are dropped;
 * when policy forbids overrides the map is empty and a note explains why (only if any were configured).
 */
export function resolveHostOverrides(entries: readonly HostOverride[], policy: EnterprisePolicy): { hosts: Record<string, string>; notes: string[] } {
  const valid = entries.filter((e) => e && typeof e.host === 'string' && typeof e.address === 'string' && e.host.trim() !== '' && isIP(e.address.trim().replace(/^\[|\]$/g, '')) !== 0);
  if (valid.length === 0) return { hosts: {}, notes: [] };
  if (!policy.allowHostOverrides) return { hosts: {}, notes: ['Host overrides are configured but disabled by organization policy (allowHostOverrides); real DNS was used.'] };
  const hosts: Record<string, string> = {};
  for (const e of valid) hosts[e.host.trim().toLowerCase()] = e.address.trim().replace(/^\[|\]$/g, '');
  return { hosts, notes: [] };
}

/** Parse a Chromium proxy string such as `PROXY host:3128; DIRECT`. */
export function parseChromiumProxy(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const first = value.split(';')[0]?.trim();
  if (!first || /^DIRECT$/i.test(first)) return undefined;
  const m = /^(PROXY|HTTP|HTTPS)\s+(\S+)$/i.exec(first);
  if (!m) return undefined; // SOCKS and unknown types are not supported
  return `${m[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${m[2]}`;
}

/**
 * TLS, proxy and size/time limits for a request to `url`, from user settings
 * clamped by enterprise policy. TLS verification is only ever disabled when
 * policy permits AND the user explicitly turned it off.
 */
export async function buildNetworkConfig(ctx: AppContext, url: string): Promise<NetworkConfig> {
  const settings = ctx.settings();
  const repos = ctx.storage.repos;
  const host = new URL(url).hostname;

  const tls: TlsOptions = { rejectUnauthorized: settings.network.verifyTls };
  const ca = repos.certificates.trustedCAs();
  if (ca.length) tls.ca = ca;
  const client = repos.certificates.clientCertificateFor(host);
  if (client && (client.cert || client.pfxBase64)) tls.clientCertificate = client;

  let proxy: ProxyOptions | undefined;
  const p = settings.network.proxy;
  if (p.mode === 'manual') {
    const target = url.toLowerCase().startsWith('https:') ? p.httpsProxy || p.httpProxy : p.httpProxy || p.httpsProxy;
    if (target) {
      proxy = { url: /^[a-z]+:\/\//i.test(target) ? target : `http://${target}`, ...(p.noProxy ? { noProxy: p.noProxy } : {}) };
      if (p.username) {
        proxy.username = p.username;
        const password = repos.vault.storage.getSync(PROXY_PASSWORD_KEY);
        if (password) proxy.password = password;
      }
    }
  } else if (p.mode === 'system') {
    const fromOs = parseChromiumProxy(await ctx.deps.platform.resolveSystemProxy?.(url));
    proxy = fromOs ? { url: fromOs } : resolveProxyFromEnv(url);
  }

  const overrides = resolveHostOverrides(settings.network.hosts ?? [], ctx.deps.policy.current);
  const workingDirectory = (settings.files?.workingDirectory ?? '').trim();

  return {
    tls,
    ...(proxy ? { proxy } : {}),
    limits: {
      timeoutMs: settings.network.timeoutMs,
      followRedirects: settings.network.followRedirects,
      maxRedirects: settings.network.maxRedirects,
      maxResponseBytes: settings.network.maxResponseBytes,
      maxRequestBytes: settings.network.maxRequestBytes,
    },
    httpVersion: settings.network.httpVersion ?? 'auto',
    hosts: overrides.hosts,
    ...(workingDirectory ? { workingDirectory } : {}),
    notes: overrides.notes,
  };
}
