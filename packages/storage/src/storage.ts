import { nowIso } from '@aegis/core';
import { MemorySecretStorage, type SecretBlobStore, type SyncSecretStorage } from '@aegis/security';
import { openDatabase, type DbHandle, type OpenedDatabase } from './database';
import { CollectionRepository } from './repositories/collections';
import { HistoryRepository } from './repositories/history';
import {
  AuditRepository,
  BackupRepository,
  CertificateRepository,
  CookieRepository,
  ImportRepository,
  RunRepository,
  SecretBlobRepository,
  SettingsRepository,
} from './repositories/misc';
import { createVariableStores } from './repositories/variables';
import { EnvironmentRepository, WorkspaceRepository } from './repositories/workspaces';
import { SecretVault } from './vault';

export interface Repositories {
  workspaces: WorkspaceRepository;
  environments: EnvironmentRepository;
  collections: CollectionRepository;
  vars: ReturnType<typeof createVariableStores>;
  history: HistoryRepository;
  settings: SettingsRepository;
  audit: AuditRepository;
  cookies: CookieRepository;
  certificates: CertificateRepository;
  imports: ImportRepository;
  runs: RunRepository;
  backups: BackupRepository;
  blobs: SecretBlobRepository;
  vault: SecretVault;
}

export function createRepositories(db: DbHandle, secrets: SyncSecretStorage, blobs: SecretBlobRepository, now: () => string = nowIso): Repositories {
  const vault = new SecretVault(secrets);
  const vars = createVariableStores(db, vault);
  const collections = new CollectionRepository(db, vault, vars, now);
  return {
    workspaces: new WorkspaceRepository(db, collections, vars, now),
    environments: new EnvironmentRepository(db, vars, now),
    collections,
    vars,
    history: new HistoryRepository(db, now),
    settings: new SettingsRepository(db, now),
    audit: new AuditRepository(db, now),
    cookies: new CookieRepository(db, secrets, now),
    certificates: new CertificateRepository(db, secrets, now),
    imports: new ImportRepository(db, now),
    runs: new RunRepository(db, now),
    backups: new BackupRepository(db, now),
    blobs,
    vault,
  };
}

export interface StorageOptions {
  /** SQLite file path or `:memory:`. */
  dbPath: string;
  /** Folder with drizzle migrations. */
  migrationsFolder: string;
  /**
   * Build the secret storage on top of the ciphertext blob store. The desktop
   * app supplies an OS-backed cipher; tests default to in-memory.
   */
  createSecretStorage?: (blobs: SecretBlobStore) => SyncSecretStorage;
  now?: () => string;
}

export class Storage {
  readonly opened: OpenedDatabase;
  readonly repos: Repositories;
  readonly secrets: SyncSecretStorage;
  private readonly now: () => string;
  private readonly blobs: SecretBlobRepository;

  constructor(options: StorageOptions) {
    this.now = options.now ?? nowIso;
    this.opened = openDatabase(options.dbPath, { migrationsFolder: options.migrationsFolder });
    this.blobs = new SecretBlobRepository(this.opened.db, this.now);
    this.secrets = options.createSecretStorage ? options.createSecretStorage(this.blobs) : new MemorySecretStorage();
    this.repos = createRepositories(this.opened.db, this.secrets, this.blobs, this.now);
  }

  /**
   * Run `fn` atomically. Any exception rolls EVERYTHING back (rows and secret
   * blobs, because both live in the same SQLite connection).
   */
  transaction<T>(fn: (repos: Repositories) => T): T {
    return this.opened.db.transaction((tx) => fn(createRepositories(tx, this.secrets, this.blobs, this.now)));
  }

  close(): void {
    this.opened.close();
  }
}
