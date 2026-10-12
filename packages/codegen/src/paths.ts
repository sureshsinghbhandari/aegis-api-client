/**
 * File-reference validation for text that arrives from outside the app
 * (pasted cURL commands). Mirrors `checkImportedFilePath` in @aegis/security
 * without depending on Node's `path` module so the renderer can use it:
 * only plain relative paths survive; everything that could point outside the
 * user's working directory is rejected and reported.
 */

export interface PathVerdict {
  safe: boolean;
  reason?: string;
}

const WINDOWS_DRIVE = /^[A-Za-z]:/;

function hasTraversal(p: string): boolean {
  return p.split(/[\\/]+/).some((seg) => seg === '..');
}

export function checkPastedFilePath(src: string): PathVerdict {
  if (typeof src !== 'string' || src.length === 0) return { safe: false, reason: 'empty path' };
  if (src.length > 1024) return { safe: false, reason: 'path too long' };
  if (src.includes('\0')) return { safe: false, reason: 'contains NUL byte' };
  if (hasTraversal(src)) return { safe: false, reason: 'path traversal (..)' };
  if (/^(\\\\|\/\/)/.test(src)) return { safe: false, reason: 'UNC path' };
  if (/^\\\\[?.]\\/.test(src)) return { safe: false, reason: 'device path' };
  if (/^file:/i.test(src)) return { safe: false, reason: 'file: URL' };
  if (WINDOWS_DRIVE.test(src) || src.startsWith('/') || src.startsWith('\\')) return { safe: false, reason: 'absolute path' };
  if (src.startsWith('~')) return { safe: false, reason: 'home-directory path' };
  if (/%[^%]+%|\$\{?[A-Za-z_]/.test(src)) return { safe: false, reason: 'environment variable expansion' };
  return { safe: true };
}
