import { app, BrowserWindow, dialog, Menu, net, protocol, safeStorage, session, shell, type MenuItemConstructorOptions } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, type PlatformBridge } from '@aegis/app';
import { parsePolicy, AuditLogger, ConsoleLogSink, Logger, PolicyService, CipherBackedSecretStorage, type LogRecord, type LogSink, type SecretCipher } from '@aegis/security';
import { Storage } from '@aegis/storage';
import { DEFAULT_POLICY, type AegisEvents } from '@aegis/core';
import { registerIpc } from './ipc';
import { runOAuthWindow } from './oauth-window';

const DEV_URL = !app.isPackaged ? process.env.AEGIS_DEV_URL : undefined;
const APP_NAME = 'Aegis API Client';

if (process.env.AEGIS_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.AEGIS_USER_DATA_DIR));
app.setName(APP_NAME);

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);

/** Rotating JSON-lines file log (redaction already applied by Logger). */
class FileLogSink implements LogSink {
  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  write(record: LogRecord): void {
    try {
      if (existsSync(this.file) && statSync(this.file).size > 5 * 1024 * 1024) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      /* logging must never crash the app */
    }
  }
}

function loadPolicy(): PolicyService {
  const candidates = [
    process.env.AEGIS_POLICY_FILE,
    process.platform === 'win32' ? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Aegis', 'policy.json') : undefined,
    process.platform === 'darwin' ? '/Library/Application Support/Aegis/policy.json' : undefined,
    process.platform === 'linux' ? '/etc/aegis/policy.json' : undefined,
    app.isPackaged ? path.join(process.resourcesPath, 'policy.json') : undefined,
  ].filter((p): p is string => !!p);
  for (const file of candidates) {
    try {
      if (existsSync(file)) return new PolicyService(parsePolicy(JSON.parse(readFileSync(file, 'utf8'))));
    } catch {
      /* a broken policy file must not silently weaken policy: fall through to defaults (which are restrictive) */
    }
  }
  return new PolicyService(DEFAULT_POLICY);
}

function createCipher(): SecretCipher {
  const backendOk = () => process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
  const label =
    process.platform === 'win32' ? 'Windows DPAPI (Electron safeStorage)' : process.platform === 'darwin' ? 'macOS Keychain (Electron safeStorage)' : 'Secret Service / libsecret keyring (Electron safeStorage)';
  return {
    description: label,
    isAvailable: () => safeStorage.isEncryptionAvailable() && backendOk(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob)),
  };
}

let mainWindow: BrowserWindow | null = null;

function emit<K extends keyof AegisEvents>(channel: K, payload: AegisEvents[K]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function createPlatform(): PlatformBridge {
  return {
    async pickFile({ title, filters }) {
      const res = await dialog.showOpenDialog(mainWindow ?? undefined!, { title, properties: ['openFile'], filters });
      if (res.canceled || !res.filePaths[0]) return null;
      const file = res.filePaths[0];
      return { path: file, name: path.basename(file), size: statSync(file).size };
    },
    async saveFile({ title, defaultName, filters }) {
      const res = await dialog.showSaveDialog(mainWindow ?? undefined!, { title, defaultPath: defaultName, filters });
      return res.canceled || !res.filePath ? null : res.filePath;
    },
    authorize: ({ authUrl, redirectUri }) => runOAuthWindow(mainWindow, authUrl, redirectUri),
    async resolveSystemProxy(url) {
      return session.defaultSession.resolveProxy(url);
    },
  };
}

function buildMenu(): void {
  const send = (action: string) => () => mainWindow?.webContents.send('menu:action', { action });
  const unsupported = (what: string) => () =>
    void dialog.showMessageBox(mainWindow ?? undefined!, { type: 'info', title: `${what} is not available yet`, message: `${what} is on the roadmap and is not implemented in this version.`, detail: 'See README → Known limitations.' });
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Request', accelerator: 'CmdOrCtrl+N', click: send('new-request') },
        { label: 'New Collection', click: send('new-collection') },
        { type: 'separator' },
        {
          label: 'Import',
          submenu: [
            { label: 'Postman Collection…', accelerator: 'CmdOrCtrl+O', click: send('import-collection') },
            { label: 'Postman Environment…', click: send('import-environment') },
            { label: 'OpenAPI…', click: unsupported('OpenAPI import') },
            { label: 'Backup…', click: send('import-backup') },
          ],
        },
        {
          label: 'Export',
          submenu: [
            { label: 'Postman Collection v2.1…', click: send('export-collection') },
            { label: 'Postman Environment…', click: send('export-environment') },
            { label: 'Backup…', click: send('export-backup') },
          ],
        },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette / Search', accelerator: 'CmdOrCtrl+K', click: send('search') },
        { label: 'Toggle Console', accelerator: 'CmdOrCtrl+`', click: send('toggle-console') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: `About ${APP_NAME}`, click: send('about') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (!(url.startsWith('app://') || (DEV_URL && url.startsWith(DEV_URL)))) e.preventDefault();
    });
  });
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

function registerAppProtocol(): void {
  const root = path.join(app.getAppPath(), 'dist', 'renderer');
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const resolved = path.normalize(path.join(root, rel));
    // path traversal guard
    if (!resolved.startsWith(root + path.sep) && resolved !== root) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(resolved).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#14161a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(DEV_URL ?? 'app://aegis/index.html');
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  const logger = new Logger([new ConsoleLogSink(), new FileLogSink(path.join(userData, 'logs', 'app.log'))], app.isPackaged ? 'INFO' : 'DEBUG');
  const policy = loadPolicy();
  const migrationsFolder = app.isPackaged ? path.join(process.resourcesPath, 'migrations') : path.join(app.getAppPath(), 'database', 'migrations');
  mkdirSync(userData, { recursive: true });
  const cipher = createCipher();
  const storage = new Storage({
    dbPath: path.join(userData, 'aegis.sqlite'),
    migrationsFolder,
    createSecretStorage: (blobs) => new CipherBackedSecretStorage(cipher, blobs),
  });
  const audit = new AuditLogger(storage.repos.audit, () => storage.repos.settings.getAll().security.auditLogEnabled, () => storage.repos.settings.getAll().security.redactionPatterns);
  const aegis = createApp({
    storage,
    policy,
    logger,
    audit,
    platform: createPlatform(),
    paths: { dataDir: userData, responsesDir: path.join(app.getPath('temp'), 'aegis-responses'), backupsDir: path.join(userData, 'backups') },
    info: { name: APP_NAME, version: app.getVersion(), platform: process.platform },
    emit,
    secretStorageAvailable: cipher.isAvailable(),
  });
  registerIpc(aegis.handlers, logger, DEV_URL);
  app.on('before-quit', () => {
    void aegis.dispose();
    storage.close();
  });
  logger.info('started', { version: app.getVersion(), secretStorage: cipher.isAvailable(), policyFile: policy.current !== DEFAULT_POLICY });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void app.whenReady().then(async () => {
    registerAppProtocol();
    hardenSession();
    await bootstrap();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
