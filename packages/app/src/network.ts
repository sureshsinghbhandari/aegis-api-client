import { resolveProxyFromEnv, type NetworkLimits } from '@aegis/http-client';
import type { ProxyOptions, TlsOptions } from '@aegis/core';
import type { AppContext } from './context';

export const PROXY_PASSWORD_KEY = 'proxy:password';

export interface NetworkConfig {
  tls: TlsOptions;
  proxy?: ProxyOptions;
  limits: NetworkLimits;
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
  };
}
