import path from 'node:path';
import { CipherBackedSecretStorage, type SecretCipher } from '@aegis/security';
import { Storage } from '@aegis/storage';

export const MIGRATIONS = path.resolve(__dirname, '../../database/migrations');

/** Reversible fake cipher: proves only ciphertext reaches the blob table. */
export class FakeCipher implements SecretCipher {
  readonly description = 'fake';
  isAvailable(): boolean {
    return true;
  }
  encrypt(plain: string): Uint8Array {
    return Buffer.from(`ENC:${Buffer.from(plain, 'utf8').reverse().toString('base64')}`, 'utf8');
  }
  decrypt(cipher: Uint8Array): string {
    const text = Buffer.from(cipher).toString('utf8');
    return Buffer.from(Buffer.from(text.slice(4), 'base64').reverse()).toString('utf8');
  }
}

export function createTestStorage(): Storage {
  return new Storage({
    dbPath: ':memory:',
    migrationsFolder: MIGRATIONS,
    createSecretStorage: (blobs) => new CipherBackedSecretStorage(new FakeCipher(), blobs),
  });
}
