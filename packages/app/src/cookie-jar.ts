import { CookieJar, Cookie, canonicalDomain, defaultPath } from 'tough-cookie';
import type { CookieJarHook, ScriptCookie, ScriptCookieJarOp } from '@aegis/core';
import type { CookieRepository } from '@aegis/storage';

export interface ScriptCookieChange {
  name: string;
  domain: string;
  path: string;
}

function toScriptCookie(c: Cookie): ScriptCookie {
  return {
    name: c.key,
    value: c.value,
    domain: c.domain ?? '',
    path: c.path ?? '/',
    ...(c.expires instanceof Date ? { expires: c.expires.toISOString() } : {}),
    secure: c.secure,
    httpOnly: false,
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  };
}

function parseJarUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid cookie URL "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Cookie URLs must use http or https');
  return url;
}

/**
 * Per-workspace cookie jar (RFC 6265 semantics via tough-cookie) persisted in
 * SQLite. Cookie values are kept in secret storage by the repository.
 */
export class CookieJarService {
  private readonly jars = new Map<string, Promise<CookieJar>>();

  constructor(private readonly repo: CookieRepository) {}

  private jarFor(workspaceId: string): Promise<CookieJar> {
    let jar = this.jars.get(workspaceId);
    if (!jar) {
      jar = this.load(workspaceId);
      this.jars.set(workspaceId, jar);
    }
    return jar;
  }

  private async load(workspaceId: string): Promise<CookieJar> {
    const jar = new CookieJar(undefined, { rejectPublicSuffixes: false, allowSpecialUseDomain: true });
    this.repo.deleteExpired(new Date().toISOString());
    for (const row of this.repo.list(workspaceId, { revealValues: true })) {
      const cookie = new Cookie({
        key: row.name,
        value: row.value,
        domain: row.domain.replace(/^\./, ''),
        path: row.path,
        hostOnly: row.hostOnly,
        secure: row.secure,
        httpOnly: row.httpOnly,
        sameSite: row.sameSite ?? undefined,
        expires: row.expiresAt ? new Date(row.expiresAt) : 'Infinity',
      });
      try {
        await jar.setCookie(cookie, `${row.secure ? 'https' : 'http'}://${row.domain.replace(/^\./, '')}${row.path}`, { ignoreError: true });
      } catch {
        /* skip unparsable rows */
      }
    }
    return jar;
  }

  /** Hook for the HTTP engine, bound to a workspace. */
  hookFor(workspaceId: string): CookieJarHook {
    return {
      getCookieHeader: async (url) => {
        const jar = await this.jarFor(workspaceId);
        const header = await jar.getCookieString(url);
        return header || undefined;
      },
      storeSetCookies: async (url, setCookies) => {
        const jar = await this.jarFor(workspaceId);
        for (const raw of setCookies) {
          let stored: Cookie | undefined;
          try {
            stored = await jar.setCookie(raw, url, { ignoreError: true });
          } catch {
            continue;
          }
          if (!stored) continue;
          this.persist(workspaceId, stored);
        }
      },
    };
  }

  /** Mirror a cookie that the in-memory jar accepted into the database (or drop it when it expired). */
  private persist(workspaceId: string, stored: Cookie): void {
    // expiryTime() accounts for Max-Age (Max-Age=0 means "delete this cookie") as well as Expires.
    const expiry = stored.expiryTime() ?? Infinity;
    const expired = expiry === -Infinity || (Number.isFinite(expiry) && expiry <= Date.now());
    if (expired) {
      this.removeFromRepo(workspaceId, stored.domain ?? '', stored.path ?? '/', stored.key);
    } else {
      this.repo.upsert({
        workspaceId,
        domain: stored.domain ?? '',
        path: stored.path ?? '/',
        name: stored.key,
        value: stored.value,
        hostOnly: stored.hostOnly ?? true,
        secure: stored.secure,
        httpOnly: stored.httpOnly,
        sameSite: stored.sameSite ?? null,
        expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null,
      });
    }
  }

  private async removeCookie(workspaceId: string, jar: CookieJar, cookie: Cookie): Promise<void> {
    await jar.store.removeCookie(cookie.domain ?? '', cookie.path ?? '/', cookie.key);
    this.removeFromRepo(workspaceId, cookie.domain ?? '', cookie.path ?? '/', cookie.key);
  }

  /**
   * `pm.cookies.jar()` operations. `httpOnly` cookies are invisible to scripts and can neither be
   * created, replaced nor removed by them; `clear` silently keeps them. Returns the matching cookies
   * (reads), the stored cookie (`set`) and the list of cookies that changed (for auditing).
   */
  async scriptOperation(workspaceId: string, op: ScriptCookieJarOp): Promise<{ cookies: ScriptCookie[]; changed: ScriptCookieChange[] }> {
    const url = parseJarUrl(op.url);
    const jar = await this.jarFor(workspaceId);
    const href = url.toString();
    switch (op.op) {
      case 'get':
        return { cookies: (await this.cookiesForScripts(workspaceId, href)).filter((c) => c.name === op.name), changed: [] };
      case 'getAll':
        return { cookies: await this.cookiesForScripts(workspaceId, href), changed: [] };
      case 'set': {
        const c = op.cookie;
        const domain = canonicalDomain(c.domain ?? url.hostname) ?? url.hostname;
        const path = c.path ?? defaultPath(url.pathname);
        const existing = await jar.store.findCookie(domain, path, c.name);
        if (existing?.httpOnly) throw new Error(`Cookie "${c.name}" is httpOnly and cannot be modified by scripts`);
        let expires: Date | 'Infinity' = 'Infinity';
        if (c.expires !== undefined) {
          expires = new Date(c.expires);
          if (Number.isNaN(expires.getTime())) throw new Error('Invalid cookie "expires" value');
        }
        const cookie = new Cookie({
          key: c.name,
          value: c.value,
          ...(c.domain !== undefined ? { domain } : {}),
          ...(c.path !== undefined ? { path } : {}),
          secure: c.secure ?? url.protocol === 'https:',
          httpOnly: false,
          ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
          ...(c.maxAge !== undefined ? { maxAge: c.maxAge } : {}),
          expires,
        });
        const stored = await jar.setCookie(cookie, href);
        if (!stored) throw new Error('The cookie was rejected by the cookie jar');
        this.persist(workspaceId, stored);
        const change = { name: stored.key, domain: stored.domain ?? domain, path: stored.path ?? path };
        const expiry = stored.expiryTime() ?? Infinity;
        const alive = !(expiry === -Infinity || (Number.isFinite(expiry) && expiry <= Date.now()));
        return { cookies: alive ? [toScriptCookie(stored)] : [], changed: [change] };
      }
      case 'unset': {
        const matches = (await jar.getCookies(href)).filter((c) => c.key === op.name);
        if (matches.some((c) => c.httpOnly)) throw new Error(`Cookie "${op.name}" is httpOnly and cannot be modified by scripts`);
        const changed: ScriptCookieChange[] = [];
        for (const c of matches) {
          await this.removeCookie(workspaceId, jar, c);
          changed.push({ name: c.key, domain: c.domain ?? '', path: c.path ?? '/' });
        }
        return { cookies: [], changed };
      }
      case 'clear': {
        const changed: ScriptCookieChange[] = [];
        for (const c of await jar.getCookies(href)) {
          if (c.httpOnly) continue;
          await this.removeCookie(workspaceId, jar, c);
          changed.push({ name: c.key, domain: c.domain ?? '', path: c.path ?? '/' });
        }
        return { cookies: [], changed };
      }
      default:
        throw new Error('Unsupported cookie jar operation');
    }
  }

  private removeFromRepo(workspaceId: string, domain: string, path: string, name: string): void {
    const row = this.repo.list(workspaceId).find((r) => r.domain.replace(/^\./, '') === domain.replace(/^\./, '') && r.path === path && r.name === name);
    if (row) this.repo.delete(row.id);
  }

  /** Cookies applicable to `url`, without httpOnly cookies (scripts must not see those). */
  async cookiesForScripts(workspaceId: string, url: string): Promise<ScriptCookie[]> {
    const jar = await this.jarFor(workspaceId);
    let cookies: Cookie[];
    try {
      cookies = await jar.getCookies(url);
    } catch {
      return [];
    }
    return cookies.filter((c) => !c.httpOnly).map(toScriptCookie);
  }

  /** Drop the in-memory jar so the next request reloads from the database (after UI edits). */
  invalidate(workspaceId: string): void {
    this.jars.delete(workspaceId);
  }
}
