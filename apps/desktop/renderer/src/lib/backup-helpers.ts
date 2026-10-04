export const MIN_PASSPHRASE_LENGTH = 8;

/** Returns an error message, or null when the passphrase pair is acceptable (empty = unencrypted backup). */
export function validateBackupPassphrase(passphrase: string, confirm: string): string | null {
  if (passphrase === '' && confirm === '') return null;
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters for the passphrase.`;
  if (passphrase !== confirm) return 'The passphrases do not match.';
  return null;
}

/** Explains what the resulting backup will contain regarding secrets. */
export function describeBackupSecrets(passphrase: string, allowSecretExport: boolean): string {
  if (passphrase === '') return 'Secrets are NOT included: without a passphrase the backup is not encrypted, so secret values are left out.';
  if (!allowSecretExport) return 'Your organization policy does not allow exporting secrets, so they are left out even though the backup is encrypted.';
  return 'Secrets are included and the whole backup is encrypted with your passphrase. Keep the passphrase safe: it cannot be recovered.';
}
