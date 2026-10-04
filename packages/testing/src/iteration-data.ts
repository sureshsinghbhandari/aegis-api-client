import { AppError } from '@aegis/core';

export type DataRow = Record<string, string>;

const MAX_ROWS = 100_000;

/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, BOM). First row is the header. */
export function parseCsv(input: string): DataRow[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) records.push(row);
    row = [];
    if (records.length > MAX_ROWS + 1) throw new AppError('VALIDATION_FAILED', `The data file has more than ${MAX_ROWS} rows.`);
  };
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
    } else {
      field += c;
    }
    i++;
  }
  if (inQuotes) throw new AppError('VALIDATION_FAILED', 'The CSV data file has an unterminated quoted field.');
  if (field !== '' || row.length > 0) pushRow();
  if (records.length === 0) return [];
  const header = records[0]!.map((h) => h.trim());
  if (header.some((h) => h === '')) throw new AppError('VALIDATION_FAILED', 'The CSV header contains an empty column name.');
  return records.slice(1).map((r) => {
    const out: DataRow = {};
    header.forEach((h, idx) => {
      if (h === '__proto__' || h === 'constructor' || h === 'prototype') return;
      out[h] = r[idx] ?? '';
    });
    return out;
  });
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** JSON data: an array of objects (one iteration each) or a single object (one iteration). */
export function parseJsonData(input: string): DataRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (cause) {
    throw new AppError('VALIDATION_FAILED', 'The JSON data file is not valid JSON.', {}, { cause });
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length > MAX_ROWS) throw new AppError('VALIDATION_FAILED', `The data file has more than ${MAX_ROWS} rows.`);
  return rows.map((r, idx) => {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) {
      throw new AppError('VALIDATION_FAILED', `JSON data row ${idx + 1} must be an object.`);
    }
    const out: DataRow = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = stringify(v);
    }
    return out;
  });
}

/** Detect CSV vs JSON by extension (falling back to content sniffing) and parse. */
export function parseIterationData(fileName: string, content: string): DataRow[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return parseJsonData(content);
  if (lower.endsWith('.csv')) return parseCsv(content);
  const t = content.trimStart();
  return t.startsWith('[') || t.startsWith('{') ? parseJsonData(content) : parseCsv(content);
}
