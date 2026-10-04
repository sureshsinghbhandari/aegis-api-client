import { CookieJar, Cookie } from 'tough-cookie';
import type { CookieJarHook, ScriptCookie } from '@aegis/core';
import type { CookieRepository } from '@aegis/storage';

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
      },
    };
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
    return cookies
      .filter((c) => !c.httpOnly)
      .map((c) => ({
        name: c.key,
        value: c.value,
        domain: c.domain ?? '',
        path: c.path ?? '/',
        ...(c.expires instanceof Date ? { expires: c.expires.toISOString() } : {}),
        secure: c.secure,
        httpOnly: false,
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      }));
  }

  /** Drop the in-memory jar so the next request reloads from the database (after UI edits). */
  invalidate(workspaceId: string): void {
    this.jars.delete(workspaceId);
  }
}
