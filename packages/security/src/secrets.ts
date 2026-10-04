import { AppError } from '@aegis/core';

/**
 * Abstraction over OS-backed secret storage.
 *  - Windows: DPAPI / Credential Manager
 *  - macOS: Keychain
 *  - Linux: Secret Service / libsecret keyring
 * The Electron implementation wraps `safeStorage`; see apps/desktop/main.
 */
export interface SecretStorageProvider {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  /** Optional: delete every key with the given prefix. */
  deleteByPrefix?(prefix: string): Promise<void>;
  /** Human-readable description of the protection in use, shown in Settings. */
  readonly description: string;
}

/**
 * Synchronous facet of a secret store. Repositories use it so that secrets are
 * written inside the same SQLite transaction as the rows that reference them
 * (an import rollback therefore also discards its secrets).
 */
export interface SyncSecretStorage extends SecretStorageProvider {
  setSync(key: string, value: string): void;
  getSync(key: string): string | null;
  deleteSync(key: string): void;
  deleteByPrefixSync(prefix: string): void;
}

/** Non-persistent provider used by tests and as an explicit "no secure storage" fallback. */
export class MemorySecretStorage implements SyncSecretStorage {
  readonly description = 'In-memory (not persisted)';
  private readonly map = new Map<string, string>();

  setSync(key: string, value: string): void {
    this.map.set(key, value);
  }
  getSync(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  deleteSync(key: string): void {
    this.map.delete(key);
  }
  deleteByPrefixSync(prefix: string): void {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }

  async set(key: string, value: string): Promise<void> {
    this.setSync(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.getSync(key);
  }
  async delete(key: string): Promise<void> {
    this.deleteSync(key);
  }
  async deleteByPrefix(prefix: string): Promise<void> {
    this.deleteByPrefixSync(prefix);
  }

  /** Test helper. */
  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** Raw encrypted-blob persistence (e.g. the `secrets` table). Holds ciphertext only. */
export interface SecretBlobStore {
  put(key: string, blob: Uint8Array): void;
  get(key: string): Uint8Array | null;
  delete(key: string): void;
  deleteByPrefix(prefix: string): void;
}

/** Symmetric cipher backed by the OS (e.g. Electron safeStorage). */
export interface SecretCipher {
  readonly description: string;
  isAvailable(): boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(cipher: Uint8Array): string;
}

/**
 * SecretStorageProvider that encrypts with an OS-backed cipher and stores only
 * ciphertext in a blob store. Secrets never reach the database as plaintext.
 */
export class CipherBackedSecretStorage implements SyncSecretStorage {
  constructor(
    private readonly cipher: SecretCipher,
    private readonly blobs: SecretBlobStore,
  ) {}

  get description(): string {
    return this.cipher.description;
  }

  private assertAvailable(): void {
    if (!this.cipher.isAvailable()) {
      throw new AppError('SECRET_STORAGE_UNAVAILABLE', 'Secure storage is not available on this system. Secret values cannot be saved.');
    }
  }

  setSync(key: string, value: string): void {
    this.assertAvailable();
    this.blobs.put(key, this.cipher.encrypt(value));
  }
  getSync(key: string): string | null {
    const blob = this.blobs.get(key);
    if (!blob) return null;
    this.assertAvailable();
    return this.cipher.decrypt(blob);
  }
  deleteSync(key: string): void {
    this.blobs.delete(key);
  }
  deleteByPrefixSync(prefix: string): void {
    this.blobs.deleteByPrefix(prefix);
  }

  async set(key: string, value: string): Promise<void> {
    this.setSync(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.getSync(key);
  }
  async delete(key: string): Promise<void> {
    this.deleteSync(key);
  }
  async deleteByPrefix(prefix: string): Promise<void> {
    this.deleteByPrefixSync(prefix);
  }
}

export const SECRET_REF_PREFIX = 'secretref:';

export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_REF_PREFIX);
}

export function secretRefKey(ref: string): string {
  return ref.slice(SECRET_REF_PREFIX.length);
}
