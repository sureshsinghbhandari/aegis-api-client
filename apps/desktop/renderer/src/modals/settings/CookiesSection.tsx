import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CookieView } from '@aegis/core';
import { api, errorMessage } from '../../lib/api';
import { groupByDomain } from '../../lib/settings-helpers';
import { MASK } from '../../lib/ui-format';
import { Button, EmptyState, ErrorBanner, Spinner } from '../../components/ui';
import { useApp } from '../../store/app';
import { useUi } from '../../store/ui';
import { SettingsGroup } from './common';

export function CookiesSection() {
  const workspaceId = useApp((s) => s.workspaceId);
  const [cookies, setCookies] = useState<CookieView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      setCookies(await api.cookies.list({ workspaceId }));
      setRevealed({});
    } catch (e) {
      setError(errorMessage(e));
      setCookies([]);
    }
  }, [workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupByDomain(cookies ?? []), [cookies]);

  const reveal = async (c: CookieView) => {
    try {
      const value = await api.cookies.reveal({ id: c.id });
      setRevealed((r) => ({ ...r, [c.id]: value }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const hide = (id: string) =>
    setRevealed((r) => {
      const { [id]: _drop, ...rest } = r;
      return rest;
    });

  const del = async (c: CookieView) => {
    try {
      await api.cookies.delete({ id: c.id });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const clear = async (domain?: string) => {
    if (!workspaceId) return;
    const ok = await useUi.getState().confirm({
      title: domain ? `Clear cookies for ${domain}` : 'Clear all cookies',
      message: domain ? `Delete all stored cookies for ${domain}?` : 'Delete all stored cookies of this workspace? You may be signed out of APIs that use cookie sessions.',
      confirmLabel: 'Delete cookies',
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await api.cookies.clear({ workspaceId, ...(domain ? { domain } : {}) });
      useApp.getState().toast(`${n} cookie(s) deleted`, 'success');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <SettingsGroup title="Cookies" description="Cookies received from servers are kept per workspace and sent back automatically. Values are hidden until you reveal them.">
      <div className="set-row">
        <Button size="sm" onClick={() => void load()}>
          Refresh
        </Button>
        <Button size="sm" variant="danger" disabled={!cookies?.length} onClick={() => void clear()}>
          Clear all
        </Button>
      </div>
      {error && <ErrorBanner message={error} onRetry={() => void load()} />}
      {cookies === null ? (
        <Spinner label="Loading cookies" />
      ) : cookies.length === 0 ? (
        <EmptyState title="No cookies stored" />
      ) : (
        groups.map((g) => (
          <div key={g.domain} className="cookie-group">
            <div className="cookie-domain">
              <strong>{g.domain}</strong>
              <Button size="sm" variant="ghost" onClick={() => void clear(g.domain)}>
                Clear domain
              </Button>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Value</th>
                  <th>Path</th>
                  <th>Flags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {g.items.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.name}</td>
                    <td className="mono cookie-value">{revealed[c.id] ?? MASK}</td>
                    <td className="mono">{c.path}</td>
                    <td>{[c.secure && 'Secure', c.httpOnly && 'HttpOnly', c.hostOnly && 'HostOnly', c.sameSite].filter(Boolean).join(' · ')}</td>
                    <td className="tbl-actions">
                      {revealed[c.id] === undefined ? (
                        <Button size="sm" onClick={() => void reveal(c)}>
                          Reveal
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => hide(c.id)}>
                          Hide
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => void del(c)} aria-label={`Delete cookie ${c.name}`}>
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </SettingsGroup>
  );
}
