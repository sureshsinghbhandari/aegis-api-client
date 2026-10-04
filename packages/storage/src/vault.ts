import { AUTH_SECRET_PARAMS, isVariableReferenceOnly, type AuthConfig, type AuthParamValue } from '@aegis/core';
import { SECRET_REF_PREFIX, isSecretRef, isSensitiveKey, secretRefKey, type SyncSecretStorage } from '@aegis/security';

export type SecretMode =
  /** Secret fields are returned as `secretref:` references (safe for the UI). */
  | 'refs'
  /** Secret fields are resolved to their real values (executor, duplicate, export with secrets). */
  | 'resolve'
  /** Secret fields are blanked (export without secrets). Variable references (`{{x}}`) are kept. */
  | 'blank';

export function isSecretAuthParam(type: string, key: string): boolean {
  const known = AUTH_SECRET_PARAMS[type];
  if (known) return known.includes(key);
  return isSensitiveKey(key);
}

/** Moves credential values out of ordinary rows into secret storage and back. */
export class SecretVault {
  constructor(readonly storage: SyncSecretStorage) {}

  /** Replace secret auth parameters by references; all values for `ownerKey` are rewritten atomically. */
  sealAuth(auth: AuthConfig, ownerKey: string): AuthConfig {
    const prefix = `auth:${ownerKey}:`;
    const plain = new Map<string, string>();
    const params: Record<string, AuthParamValue> = {};
    for (const [key, value] of Object.entries(auth.params)) {
      if (typeof value === 'string' && value !== '' && isSecretAuthParam(auth.type, key)) {
        if (isVariableReferenceOnly(value)) {
          params[key] = value;
        } else if (isSecretRef(value)) {
          const existing = this.storage.getSync(secretRefKey(value));
          if (existing !== null) plain.set(key, existing);
        } else {
          plain.set(key, value);
        }
      } else {
        params[key] = value;
      }
    }
    this.storage.deleteByPrefixSync(prefix);
    for (const [key, value] of plain) {
      this.storage.setSync(prefix + key, value);
      params[key] = SECRET_REF_PREFIX + prefix + key;
    }
    return { type: auth.type, params };
  }

  openAuth(auth: AuthConfig, mode: SecretMode): AuthConfig {
    if (mode === 'refs') return auth;
    const params: Record<string, AuthParamValue> = {};
    for (const [key, value] of Object.entries(auth.params)) {
      if (isSecretRef(value)) {
        params[key] = mode === 'resolve' ? (this.storage.getSync(secretRefKey(value)) ?? '') : '';
      } else if (mode === 'blank' && typeof value === 'string' && value !== '' && isSecretAuthParam(auth.type, key) && !isVariableReferenceOnly(value)) {
        params[key] = '';
      } else {
        params[key] = value;
      }
    }
    return { type: auth.type, params };
  }

  deleteAuth(ownerKey: string): void {
    this.storage.deleteByPrefixSync(`auth:${ownerKey}:`);
  }
}
