import type { ProxyOptions } from '@aegis/core';

/** Does `hostname` match a NO_PROXY style list (`example.com`, `.example.com`, `*.example.com`, `host:port`, `*`)? */
export function shouldBypassProxy(url: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  let host: string;
  let port: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    port = u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    // loopback is only proxied when the user explicitly lists nothing; keep Postman/curl behaviour: still honour NO_PROXY below
  }
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const [pattern, entryPort] = entry.includes(':') && !entry.startsWith('[') ? (entry.split(':') as [string, string]) : [entry, undefined];
    if (entryPort && entryPort !== port) continue;
    const bare = pattern.replace(/^\*?\./, '');
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** Proxy from HTTP_PROXY / HTTPS_PROXY / NO_PROXY environment variables, honouring NO_PROXY. */
export function resolveProxyFromEnv(url: string, env: Record<string, string | undefined> = process.env): ProxyOptions | undefined {
  const get = (name: string) => env[name] ?? env[name.toLowerCase()];
  const noProxy = get('NO_PROXY');
  if (shouldBypassProxy(url, noProxy)) return undefined;
  const isHttps = url.toLowerCase().startsWith('https:');
  const raw = (isHttps ? (get('HTTPS_PROXY') ?? get('HTTP_PROXY')) : get('HTTP_PROXY')) ?? get('ALL_PROXY');
  if (!raw) return undefined;
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    const options: ProxyOptions = { url: `${u.protocol}//${u.host}`, ...(noProxy ? { noProxy } : {}) };
    if (u.username) options.username = decodeURIComponent(u.username);
    if (u.password) options.password = decodeURIComponent(u.password);
    return options;
  } catch {
    return undefined;
  }
}
