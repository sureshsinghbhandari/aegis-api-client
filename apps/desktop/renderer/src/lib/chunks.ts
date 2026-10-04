/** Helpers for the chunked large-response viewer. Pure functions (no React). */

export const LARGE_BODY_BYTES = 2 * 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024;

/**
 * Split text into display rows: one row per line, with lines longer than `maxLen`
 * broken into several rows so a single minified line cannot create a gigantic DOM node.
 */
export function splitDisplayLines(text: string, maxLen = 2000): string[] {
  if (text === '') return [];
  const rows: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.length <= maxLen) {
      rows.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += maxLen) rows.push(line.slice(i, i + maxLen));
  }
  // a trailing newline produces an empty last row that carries no information
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** Byte offset for a 0..1 position in a body of `total` bytes, aligned down to `chunk`. */
export function offsetForFraction(fraction: number, total: number, chunk = CHUNK_BYTES): number {
  const f = Math.min(1, Math.max(0, fraction));
  const raw = Math.min(Math.floor(f * total), Math.max(0, total - 1));
  return Math.floor(raw / chunk) * chunk;
}
