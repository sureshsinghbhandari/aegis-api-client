/**
 * Text -> document for every importer. JSON first; YAML (OpenAPI/Swagger files)
 * through the `yaml` package with the YAML 1.2 core schema only: no custom tags,
 * no merge keys, bounded alias expansion (billion-laughs guard).
 */
import { AppError } from '@aegis/core';
import { parse as parseYaml } from 'yaml';
import { failImport } from './shared';
import type { WarningCollector } from './warnings';

/** YAML documents are far more expensive to parse than JSON; keep them smaller. */
export const MAX_YAML_BYTES = 64 * 1024 * 1024;

/** Max number of alias expansions a YAML document may perform (yaml's default is 100). */
const MAX_ALIAS_COUNT = 100;

export function looksLikeYaml(fileName: string | undefined, text: string): boolean {
  if (fileName && /\.ya?ml$/i.test(fileName)) return true;
  const head = text.slice(0, 4096).replace(/^﻿/, '').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return false;
  if (head === '') return false;
  // JSON would have started with { or [; YAML roots look like `key:`, `---` or `# comment`.
  return /^(---|#|%YAML|[A-Za-z_"'][^\n]*:)/.test(head) || /^openapi:|^swagger:/m.test(head);
}

/**
 * Parse an import file. A JSON string is parsed as JSON; text that is not JSON
 * but looks like YAML (or has a .yaml/.yml name) is parsed as YAML. Prototype
 * keys from YAML mappings never become own properties (the value is rebuilt
 * through JSON), so the result is plain JSON data either way.
 */
export function parseImportText(input: string, fileName: string | undefined, maxBytes: number, w: WarningCollector): unknown {
  if (input.length > maxBytes) {
    throw new AppError('IMPORT_TOO_LARGE', `The file is larger than the import limit of ${Math.floor(maxBytes / (1024 * 1024))} MiB.`, { maxBytes });
  }
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const yaml = looksLikeYaml(fileName, text);
  if (!yaml) {
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      if (!/^\s*[{[]/.test(text) && text.trim() !== '') return parseYamlText(text, w);
      return failImport(w, '', `The file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return parseYamlText(text, w);
}

function parseYamlText(text: string, w: WarningCollector): unknown {
  if (text.length > MAX_YAML_BYTES) {
    throw new AppError('IMPORT_TOO_LARGE', `YAML files larger than ${Math.floor(MAX_YAML_BYTES / (1024 * 1024))} MiB cannot be imported; convert the file to JSON.`, { maxBytes: MAX_YAML_BYTES });
  }
  let value: unknown;
  try {
    value = parseYaml(text, {
      version: '1.2',
      schema: 'core',
      merge: false,
      maxAliasCount: MAX_ALIAS_COUNT,
      uniqueKeys: true,
      prettyErrors: false,
      strict: true,
      logLevel: 'error',
    });
  } catch (e) {
    if (e instanceof RangeError) throw new AppError('IMPORT_INVALID', 'The document is nested too deeply to import.', {}, { cause: e });
    return failImport(w, '', `The file is not valid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  if (value === undefined || value === null) return failImport(w, '', 'The YAML file is empty.');
  // Rebuild as plain JSON: drops Map/Set-like values and keys that only live on the prototype.
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch (e) {
    if (e instanceof RangeError) throw new AppError('IMPORT_INVALID', 'The document is nested too deeply to import.', {}, { cause: e });
    return failImport(w, '', 'The YAML document cannot be represented as JSON.');
  }
}
