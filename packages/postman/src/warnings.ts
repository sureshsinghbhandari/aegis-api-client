import type { ImportSeverity, ImportWarningModel } from '@aegis/core';

export const MAX_WARNINGS = 2000;
export const MAX_SOURCE_VALUE_LENGTH = 300;

/** Render an arbitrary source value as a short string for display in the import report. */
export function truncateSource(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_SOURCE_VALUE_LENGTH ? `${text.slice(0, MAX_SOURCE_VALUE_LENGTH)}…` : text;
}

/**
 * Collects import warnings with bounded memory: source values are truncated and
 * the number of non-error entries is capped (a final INFO reports how many were dropped).
 * ERROR entries are never suppressed.
 */
export class WarningCollector {
  private readonly items: ImportWarningModel[] = [];
  private suppressed = 0;

  add(severity: ImportSeverity, path: string, message: string, sourceValue?: unknown): void {
    if (severity !== 'ERROR' && this.items.length >= MAX_WARNINGS) {
      this.suppressed += 1;
      return;
    }
    const entry: ImportWarningModel = { severity, path, message };
    const source = truncateSource(sourceValue);
    if (source !== undefined) entry.sourceValue = source;
    this.items.push(entry);
  }

  info(path: string, message: string, sourceValue?: unknown): void {
    this.add('INFO', path, message, sourceValue);
  }

  warn(path: string, message: string, sourceValue?: unknown): void {
    this.add('WARNING', path, message, sourceValue);
  }

  error(path: string, message: string, sourceValue?: unknown): void {
    this.add('ERROR', path, message, sourceValue);
  }

  get hasErrors(): boolean {
    return this.items.some((w) => w.severity === 'ERROR');
  }

  toArray(): ImportWarningModel[] {
    const out = this.items.map((w) => ({ ...w }));
    if (this.suppressed > 0) out.push({ severity: 'INFO', path: '', message: `${this.suppressed} more warnings suppressed` });
    return out;
  }
}
