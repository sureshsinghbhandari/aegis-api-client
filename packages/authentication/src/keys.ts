import { createPrivateKey, type KeyObject } from 'node:crypto';
import { AppError } from '@aegis/core';

/**
 * Load a private key given as PEM text (PKCS#8 or PKCS#1/SEC1), as a `data:` URI with a
 * base64 DER body (the form Atlassian ASAP tooling emits, e.g.
 * `data:application/pkcs8;kid=...;base64,...`) or as an existing KeyObject.
 * Throws `AUTH_FAILED` with a short, secret-free message when the key cannot be parsed.
 */
export function loadPrivateKey(key: string | KeyObject, what = 'private key'): KeyObject {
  if (typeof key !== 'string') return key;
  const text = key.trim();
  if (!text) throw new AppError('AUTH_FAILED', `A ${what} is required.`);
  try {
    if (text.startsWith('data:')) {
      const comma = text.indexOf(',');
      if (comma === -1) throw new Error('malformed data URI');
      const meta = text.slice(5, comma);
      const payload = text.slice(comma + 1);
      const der = meta.split(';').includes('base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'latin1');
      const type = /pkcs1|rsa/i.test(meta) ? 'pkcs1' : 'pkcs8';
      return createPrivateKey({ key: der, format: 'der', type });
    }
    return createPrivateKey(text);
  } catch (cause) {
    throw new AppError('AUTH_FAILED', `The ${what} could not be parsed. Provide a PEM private key (PKCS#8 or PKCS#1) or a base64 data: URI.`, {}, { cause });
  }
}
