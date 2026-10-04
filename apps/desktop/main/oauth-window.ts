import { BrowserWindow } from 'electron';

/**
 * Interactive OAuth 2.0 authorization in an isolated, non-persistent window.
 * The redirect URI is never actually loaded: navigation to it is intercepted
 * and the `code`/`state` query parameters are read from the URL.
 */
export function runOAuthWindow(parent: BrowserWindow | null, authUrl: string, redirectUri: string): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//i.test(authUrl)) {
      reject(new Error('The authorization URL must use http or https.'));
      return;
    }
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parent ?? undefined,
      modal: !!parent,
      title: 'Authorize',
      webPreferences: { partition: `oauth-${Date.now()}`, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      if (!win.isDestroyed()) win.close();
    };
    const inspect = (event: { preventDefault(): void }, url: string) => {
      if (!url.startsWith(redirectUri)) return;
      event.preventDefault();
      const u = new URL(url);
      const error = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      if (error) finish(() => reject(new Error(`Authorization failed: ${u.searchParams.get('error_description') ?? error}`)));
      else if (!code) finish(() => reject(new Error('The authorization response did not contain a code.')));
      else finish(() => resolve({ code, state: u.searchParams.get('state') ?? '' }));
    };
    win.webContents.on('will-redirect', (e, url) => inspect(e, url));
    win.webContents.on('will-navigate', (e, url) => inspect(e, url));
    win.on('closed', () => finish(() => reject(new Error('The authorization window was closed.'))));
    void win.loadURL(authUrl);
  });
}
