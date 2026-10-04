import type { AppSettings, ImportProgress, AegisEvents } from '@aegis/core';
import type { AuditLogger, Logger, PolicyService } from '@aegis/security';
import type { Storage } from '@aegis/storage';
import type { AuthRegistry } from '@aegis/authentication';
import type { runScript } from '@aegis/scripting';
import type { HttpProtocolClient } from '@aegis/http-client';
import type { CookieJarService } from './cookie-jar';
import type { ResponseStore } from './response-store';

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Everything the application layer needs from the host shell (Electron, tests, a future CLI). */
export interface PlatformBridge {
  /** Show an open-file dialog. Returns null if the user cancelled. */
  pickFile(options: { title: string; filters: FileFilter[] }): Promise<{ path: string; name: string; size: number } | null>;
  /** Show a save dialog. Returns null if the user cancelled. */
  saveFile(options: { title: string; defaultName: string; filters: FileFilter[] }): Promise<string | null>;
  /** Interactive OAuth 2.0 authorization (browser window). Resolves with the returned code/state. */
  authorize(options: { authUrl: string; redirectUri: string }): Promise<{ code: string; state: string }>;
  /** Resolve the OS proxy for a URL (e.g. via Electron's session.resolveProxy). Optional. */
  resolveSystemProxy?(url: string): Promise<string | undefined>;
}

export interface AppPaths {
  dataDir: string;
  /** Spilled response bodies. */
  responsesDir: string;
  backupsDir: string;
}

export interface AppInfoSource {
  name: string;
  version: string;
  platform: string;
}

export interface AppDeps {
  storage: Storage;
  policy: PolicyService;
  logger: Logger;
  audit: AuditLogger;
  platform: PlatformBridge;
  paths: AppPaths;
  info: AppInfoSource;
  emit<K extends keyof AegisEvents>(channel: K, payload: AegisEvents[K]): void;
  secretStorageAvailable: boolean;
  /** Override for tests. Defaults to `runScript` from @aegis/scripting. */
  runScript?: typeof runScript;
  now?: () => number;
  httpClient?: HttpProtocolClient;
  authRegistry?: AuthRegistry;
}

/** Shared services every feature module uses. */
export interface AppContext {
  deps: AppDeps;
  storage: Storage;
  cookies: CookieJarService;
  responses: ResponseStore;
  settings(): AppSettings;
  rawSettings(): AppSettings;
  now(): number;
  progress(p: ImportProgress, token?: string): void;
}
