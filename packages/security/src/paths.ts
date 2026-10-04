import { AppError } from '@aegis/core';
import path from 'node:path';

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

export interface PathCheckOptions {
  /** If given, the resolved path must be inside one of these directories. */
  allowedRoots?: string[];
  /** Permit UNC (\\\\server\\share) paths. Default false (NTLM credential leak risk). */
  allowUnc?: boolean;
}

function fail(message: string, p: string): never {
  throw new AppError('PATH_NOT_ALLOWED', message, { path: p.length > 200 ? `${p.slice(0, 200)}…` : p });
}

/** True if `p` contains `..` as a path segment (either separator). */
export function hasTraversal(p: string): boolean {
  return p.split(/[\\/]+/).some((seg) => seg === '..');
}

export function isUncPath(p: string): boolean {
  return p.startsWith('\\\\') || p.startsWith('//');
}

/**
 * Validate a user-chosen local file path before it is read for upload.
 * Rejects NUL bytes, device namespaces, UNC paths (unless allowed), and paths
 * outside `allowedRoots` when roots are given. Returns the normalised absolute path.
 */
export function assertSafeFilePath(p: string, options: PathCheckOptions = {}): string {
  if (typeof p !== 'string' || p.length === 0) fail('A file path is required.', String(p));
  if (p.includes('\0')) fail('The file path contains invalid characters.', p);
  if (/^\\\\[?.]\\/.test(p)) fail('Device paths are not allowed.', p);
  if (/^file:/i.test(p)) fail('file: URLs are not allowed as file paths.', p);
  if (isUncPath(p) && !options.allowUnc) fail('Network (UNC) paths are not allowed.', p);
  if (!path.isAbsolute(p) && !options.allowedRoots?.length) fail('An absolute file path is required.', p);
  if (options.allowedRoots?.length) {
    const base = path.isAbsolute(p) ? p : path.join(options.allowedRoots[0]!, p);
    const resolved = path.resolve(base);
    const inside = options.allowedRoots.some((root) => {
      const rel = path.relative(path.resolve(root), resolved);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!inside) fail('The file path is outside the permitted directories.', p);
    return resolved;
  }
  return path.resolve(p);
}

export interface ImportedPathVerdict {
  safe: boolean;
  reason?: string;
}

/**
 * Validate a file reference found inside an imported document (e.g. Postman
 * form-data `src`). Only plain relative paths without traversal are accepted;
 * absolute, UNC, drive-letter, home (`~`), environment-expanded and `file:` references are rejected.
 */
export function checkImportedFilePath(src: string): ImportedPathVerdict {
  if (typeof src !== 'string' || src.length === 0) return { safe: false, reason: 'empty path' };
  if (src.length > 1024) return { safe: false, reason: 'path too long' };
  if (src.includes('\0')) return { safe: false, reason: 'contains NUL byte' };
  if (hasTraversal(src)) return { safe: false, reason: 'path traversal (..)' };
  if (isUncPath(src)) return { safe: false, reason: 'UNC path' };
  if (/^\\\\[?.]\\/.test(src)) return { safe: false, reason: 'device path' };
  if (/^file:/i.test(src)) return { safe: false, reason: 'file: URL' };
  if (path.posix.isAbsolute(src) || path.win32.isAbsolute(src) || WINDOWS_DRIVE.test(src) || src.startsWith('/') || src.startsWith('\\')) {
    return { safe: false, reason: 'absolute path' };
  }
  if (src.startsWith('~')) return { safe: false, reason: 'home-directory path' };
  if (/%[^%]+%|\$\{?[A-Za-z_]/.test(src)) return { safe: false, reason: 'environment variable expansion' };
  return { safe: true };
}

/** Make `name` safe as a single file name component. */
export function sanitizeFileName(name: string, fallback = 'file'): string {
  const cleaned = name
    .replace(/[\0-\x1f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  const result = cleaned && !reserved.test(cleaned) ? cleaned : fallback;
  return result;
}

const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.js', '.jar', '.sh', '.app', '.dll', '.lnk']);

/** Files we never auto-open after download; callers must only reveal them in the file manager. */
export function isExecutableExtension(fileName: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}
