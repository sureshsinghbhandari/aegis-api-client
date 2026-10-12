import { buildPatch } from '../../lib/settings-helpers';
import { SettingsGroup, TextField, type SectionProps } from './common';

/**
 * Settings -> General -> Files: the working directory for relative file paths.
 * Imported Postman form-data / binary `src` paths are relative; they are only ever read from inside this
 * directory (`assertSafeFilePath` with `allowedRoots`). Absolute paths picked in the app are not affected.
 */
export function WorkingDirectorySection({ settings, save }: Pick<SectionProps, 'settings' | 'save'>) {
  const value = settings.files?.workingDirectory ?? '';
  return (
    <SettingsGroup title="Files" description="Relative file paths (for example form-data files from an imported Postman collection) are resolved inside this directory only. Leave empty to reject relative paths.">
      <TextField
        label="Working directory"
        value={value}
        placeholder="C:\\projects\\api-fixtures or /home/me/api-fixtures"
        hint="Absolute directory path. Files outside it cannot be referenced by a relative path."
        validate={validateWorkingDirectory}
        onCommit={(v) => void save(buildPatch(['files', 'workingDirectory'], v.trim()))}
      />
    </SettingsGroup>
  );
}

/** Empty is allowed (relative paths rejected); otherwise it must look like an absolute path. */
export function validateWorkingDirectory(value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  if (v.includes('\0')) return 'The path contains invalid characters.';
  if (/^\\\\/.test(v) || /^\/\//.test(v)) return 'Network (UNC) paths are not allowed.';
  if (/^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('/')) return null;
  return 'Enter an absolute directory path.';
}
