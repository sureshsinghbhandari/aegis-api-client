import type { EnvironmentBundle, ImportWarningModel, VariableEntry } from '@aegis/core';
import { detectPostmanFormat } from './detect';
import { cloneAt, collectExtras } from './import-parts';
import type { JsonObject } from './shared';
import { DEFAULT_MAX_BYTES, failImport, isRecord, parseJsonInput, readDescription, toStr } from './shared';
import { WarningCollector } from './warnings';

export interface ParseEnvironmentResult {
  bundle: EnvironmentBundle;
  warnings: ImportWarningModel[];
}

type Kind = 'environment' | 'globals';

const VALUE_KNOWN: ReadonlySet<string> = new Set(['key', 'value', 'type', 'enabled', 'disabled', 'description']);
const TOP_KNOWN: ReadonlySet<string> = new Set(['name', 'values']);
const TOP_QUIET: ReadonlySet<string> = new Set(['id', '_postman_variable_scope', '_postman_exported_at', '_postman_exported_using']);

function convertValues(w: WarningCollector, values: unknown[]): VariableEntry[] {
  const out: VariableEntry[] = [];
  values.forEach((raw, i) => {
    const path = `values[${i}]`;
    if (!isRecord(raw) || typeof raw.key !== 'string') {
      w.warn(path, 'Variable has no key; skipped', raw);
      return;
    }
    for (const k of Object.keys(raw)) if (!VALUE_KNOWN.has(k)) w.warn(`${path}.${k}`, `Unsupported field "${k}" ignored`, raw[k]);
    if (isRecord(raw.value) || Array.isArray(raw.value)) w.warn(`${path}.value`, 'Structured variable value stored as JSON text', raw.value);
    const type = typeof raw.type === 'string' ? raw.type : undefined;
    const entry: VariableEntry = {
      key: raw.key,
      initialValue: toStr(raw.value),
      isSecret: type === 'secret',
      enabled: raw.enabled !== false && raw.disabled !== true,
    };
    const description = readDescription(raw.description).text;
    if (description !== '') entry.description = description;
    if (type !== undefined) entry.type = type;
    out.push(entry);
  });
  return out;
}

function parseValuesDocument(input: string | object, kind: Kind): ParseEnvironmentResult {
  const w = new WarningCollector();
  const doc = parseJsonInput(input, DEFAULT_MAX_BYTES, w);
  if (!isRecord(doc)) failImport(w, '', `This is not a Postman ${kind}: the top-level JSON value must be an object.`);
  const detected = detectPostmanFormat(doc);
  if (detected.startsWith('collection')) failImport(w, '', `This file is a Postman collection, not a ${kind}. Use the collection import instead.`);
  if (!Array.isArray(doc.values)) failImport(w, 'values', `This is not a Postman ${kind}: the "values" array is missing.`);
  if (detected !== kind) w.warn('_postman_variable_scope', `The file declares scope "${toStr(doc._postman_variable_scope)}" but is imported as a ${kind}`);

  const fallbackName = kind === 'globals' ? 'Globals' : 'Imported environment';
  if (typeof doc.name !== 'string' || doc.name.trim() === '') w.warn('name', `The ${kind} has no name; using "${fallbackName}"`);
  const sourceMetadata: JsonObject = {};
  const extras = collectExtras(w, doc, TOP_KNOWN, '', TOP_QUIET) ?? {};
  for (const [k, v] of Object.entries(extras)) sourceMetadata[k] = cloneAt(w, v, k);

  const bundle: EnvironmentBundle = {
    name: typeof doc.name === 'string' && doc.name.trim() !== '' ? doc.name : fallbackName,
    variables: convertValues(w, doc.values),
    sourceMetadata,
  };
  return { bundle, warnings: w.toArray() };
}

/** Convert a Postman environment export into an {@link EnvironmentBundle}. */
export function parsePostmanEnvironment(input: string | object): ParseEnvironmentResult {
  return parseValuesDocument(input, 'environment');
}

/** Convert a Postman globals export; `bundle.name` is the file's name or "Globals". */
export function parsePostmanGlobals(input: string | object): ParseEnvironmentResult {
  return parseValuesDocument(input, 'globals');
}
