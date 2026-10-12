/**
 * Bulk edit ("text mode") for key/value tables. Pure functions (no React).
 *
 * Format (one entry per line): `key:value`. A `//` prefix disables the row.
 * Descriptions and other fields (form-data type, content type, file path)
 * are not part of the text; they are carried over from the previous rows
 * whose key is unchanged, so toggling bulk edit never loses them.
 */
import type { FormDataEntry, KeyValueEntry } from '@aegis/core';

export const BULK_PLACEHOLDER = 'key:value\n// disabled:value';

export function serializeBulk(rows: readonly KeyValueEntry[]): string {
  return rows.map((r) => `${r.enabled ? '' : '//'}${r.key}:${r.value}`).join('\n');
}

interface ParsedLine {
  key: string;
  value: string;
  enabled: boolean;
}

function parseLines(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '') continue;
    let enabled = true;
    if (line.startsWith('//')) {
      enabled = false;
      line = line.slice(2).trim();
      if (line === '') continue;
    }
    const colon = line.indexOf(':');
    const key = (colon === -1 ? line : line.slice(0, colon)).trim();
    const value = colon === -1 ? '' : line.slice(colon + 1).trim();
    out.push({ key, value, enabled });
  }
  return out;
}

/**
 * Match parsed lines to previous rows by key (same position preferred, then the
 * first unused row with that key) so extra fields survive a round-trip.
 */
function matchPrevious<T extends { key: string }>(lines: ParsedLine[], previous: readonly T[]): Array<T | undefined> {
  const used = new Set<number>();
  return lines.map((line, i) => {
    const same = previous[i];
    if (same && !used.has(i) && same.key === line.key) {
      used.add(i);
      return same;
    }
    const idx = previous.findIndex((p, j) => !used.has(j) && p.key === line.key);
    if (idx === -1) return undefined;
    used.add(idx);
    return previous[idx];
  });
}

/** Parse bulk text into rows, preserving descriptions of rows whose key is unchanged. */
export function parseBulk(text: string, previous: readonly KeyValueEntry[] = []): KeyValueEntry[] {
  const lines = parseLines(text);
  const matched = matchPrevious(lines, previous);
  return lines.map((line, i) => {
    const prev = matched[i];
    const row: KeyValueEntry = { key: line.key, value: line.value, enabled: line.enabled };
    if (prev?.description) row.description = prev.description;
    return row;
  });
}

/** form-data rows: file rows show their file name; a line whose key and value match a previous file row keeps it. */
export function serializeFormBulk(rows: readonly FormDataEntry[]): string {
  return rows.map((r) => `${r.enabled ? '' : '//'}${r.key}:${r.value}`).join('\n');
}

export function parseFormBulk(text: string, previous: readonly FormDataEntry[] = []): FormDataEntry[] {
  const lines = parseLines(text);
  const matched = matchPrevious(lines, previous);
  return lines.map((line, i) => {
    const prev = matched[i];
    if (prev && prev.type === 'file' && prev.value === line.value) return { ...prev, enabled: line.enabled };
    const row: FormDataEntry = { key: line.key, type: prev?.type === 'variable' ? 'variable' : 'text', value: line.value, enabled: line.enabled };
    if (prev?.description) row.description = prev.description;
    if (prev?.contentType) row.contentType = prev.contentType;
    return row;
  });
}
