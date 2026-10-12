import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretCipher } from '@aegis/security';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Process-local secret cipher for the CLI. The AES-256-GCM key is generated when the process starts and
 * never leaves memory, so secrets imported from environment files are held encrypted in the in-memory
 * SQLite database and become unrecoverable as soon as the process exits.
 */
export class MemoryAesCipher implements SecretCipher {
  readonly description = 'In-memory AES-256-GCM (process lifetime only)';
  private readonly key = randomBytes(32);

  isAvailable(): boolean {
    return true;
  }

  encrypt(plain: string): Uint8Array {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(blob: Uint8Array): string {
    const buf = Buffer.from(blob);
    if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('secret blob is truncated');
    const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, IV_BYTES));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }
}
