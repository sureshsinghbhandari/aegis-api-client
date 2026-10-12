import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AegisApp, type PlatformBridge } from '@aegis/app';
import type { AegisEvents } from '@aegis/core';
import { AuditLogger, CipherBackedSecretStorage, Logger, loadPolicyFromFiles, type LogRecord, type LogSink, type PolicyService } from '@aegis/security';
import { Storage } from '@aegis/storage';
import { UsageError } from './args';
import { MemoryAesCipher } from './memory-cipher';

export const CLI_NAME = 'aegis-cli';

export function cliVersion(): string {
  return typeof __AEGIS_CLI_VERSION__ === 'string' ? __AEGIS_CLI_VERSION__ : 'dev';
}

/** Engine log records go to stderr only; stdout is reserved for the reporters. */
class StderrLogSink implements LogSink {
  constructor(private readonly verbose: boolean) {}
  write(record: LogRecord): void {
    if (record.level === 'ERROR' || (this.verbose && record.level === 'WARN')) {
      const extra = record.data !== undefined ? ` ${JSON.stringify(record.data)}` : '';
      process.stderr.write(`[${CLI_NAME}] ${record.level.toLowerCase()}: ${record.msg}${extra}\n`);
    }
  }
}

/**
 * Drizzle migrations are read from disk. In the repository they live under database/migrations
 * (two levels above dist/cli); a packaged CLI ships them next to the bundle or names them with
 * AEGIS_MIGRATIONS_DIR.
 */
export function resolveMigrationsDir(env: NodeJS.ProcessEnv = process.env, bundleDir: string = typeof __dirname === 'string' ? __dirname : process.cwd()): string {
  const candidates = [env.AEGIS_MIGRATIONS_DIR, path.join(bundleDir, 'migrations'), path.resolve(bundleDir, '..', '..', 'database', 'migrations'), path.resolve(process.cwd(), 'database', 'migrations')].filter(
    (p): p is string => !!p,
  );
  for (const c of candidates) if (existsSync(c)) return c;
  throw new UsageError(`Database migrations were not found (looked in ${candidates.join(', ')}). Set AEGIS_MIGRATIONS_DIR.`);
}

/** Same lookup order as the desktop app, with `--policy` first. */
export function loadCliPolicy(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): { policy: PolicyService; file: string | null } {
  if (explicit) {
    if (!existsSync(explicit)) throw new UsageError(`Policy file not found: ${explicit}`);
    const loaded = loadPolicyFromFiles([explicit]);
    if (!loaded.file) throw new UsageError(`Policy file could not be read or is not valid JSON: ${explicit}`);
    return loaded;
  }
  return loadPolicyFromFiles([
    env.AEGIS_POLICY_FILE,
    process.platform === 'win32' ? path.join(env.ProgramData ?? 'C:\\ProgramData', 'Aegis', 'policy.json') : undefined,
    process.platform === 'darwin' ? '/Library/Application Support/Aegis/policy.json' : undefined,
    process.platform === 'linux' ? '/etc/aegis/policy.json' : undefined,
  ]);
}

export interface CliApp {
  app: AegisApp;
  api: AegisApp['api'];
  policy: PolicyService;
  policyFile: string | null;
  events: EventEmitter;
  storage: Storage;
  close(): Promise<void>;
}

/**
 * Compose the application services exactly like the desktop main process does, but on an in-memory
 * database, a process-local secret cipher and a platform bridge without dialogs or OAuth windows.
 */
export function createCliApp(options: { policyFile?: string; verbose: boolean; env?: NodeJS.ProcessEnv }): CliApp {
  const env = options.env ?? process.env;
  const migrationsFolder = resolveMigrationsDir(env);
  const { policy, file: policyFile } = loadCliPolicy(options.policyFile, env);
  const logger = new Logger([new StderrLogSink(options.verbose)], options.verbose ? 'DEBUG' : 'WARN');
  const cipher = new MemoryAesCipher();
  const storage = new Storage({ dbPath: ':memory:', migrationsFolder, createSecretStorage: (blobs) => new CipherBackedSecretStorage(cipher, blobs) });
  const audit = new AuditLogger(storage.repos.audit, () => storage.repos.settings.getAll().security.auditLogEnabled, () => storage.repos.settings.getAll().security.redactionPatterns);
  const events = new EventEmitter();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'aegis-cli-'));

  const platform: PlatformBridge = {
    pickFile: async () => null,
    saveFile: async () => null,
    authorize: async () => {
      throw new Error('interactive OAuth is not supported in the CLI');
    },
  };

  const app = createApp({
    storage,
    policy,
    logger,
    audit,
    platform,
    paths: { dataDir: tmp, responsesDir: path.join(tmp, 'responses'), backupsDir: path.join(tmp, 'backups') },
    info: { name: 'Aegis API Client CLI', version: cliVersion(), platform: process.platform },
    emit: <K extends keyof AegisEvents>(channel: K, payload: AegisEvents[K]) => void events.emit(channel, payload),
    secretStorageAvailable: true,
  });

  // History is pointless in a throw-away database and would only cost time.
  storage.repos.settings.update({ history: { enabled: false } });

  return {
    app,
    api: app.api,
    policy,
    policyFile,
    events,
    storage,
    async close() {
      await app.dispose();
      storage.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
