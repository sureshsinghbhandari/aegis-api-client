import { AppError } from '@aegis/core';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Passphrase-based authenticated encryption for backups and secret exports.
 * Format (JSON): { v, kdf, salt, iv, tag, data } with base64 fields.
 * KDF: scrypt (N=2^15, r=8, p=1); cipher: AES-256-GCM.
 */
export interface EncryptedEnvelope {
  format: 'aegis-encrypted';
  v: 1;
  kdf: 'scrypt';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function encryptWithPassphrase(plain: Uint8Array | string, passphrase: string): EncryptedEnvelope {
  if (!passphrase) throw new AppError('VALIDATION_FAILED', 'A passphrase is required.');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const input = typeof plain === 'string' ? Buffer.from(plain, 'utf8') : Buffer.from(plain);
  const data = Buffer.concat([cipher.update(input), cipher.final()]);
  return {
    format: 'aegis-encrypted',
    v: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return typeof value === 'object' && value !== null && (value as { format?: unknown }).format === 'aegis-encrypted';
}

export function decryptWithPassphrase(envelope: EncryptedEnvelope, passphrase: string): Buffer {
  try {
    const key = scryptSync(passphrase, Buffer.from(envelope.salt, 'base64'), 32, SCRYPT);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  } catch (cause) {
    throw new AppError('VALIDATION_FAILED', 'Could not decrypt: wrong passphrase or corrupted data.', {}, { cause });
  }
}
