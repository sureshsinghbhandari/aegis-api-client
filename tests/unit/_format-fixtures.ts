import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { AppError } from '@aegis/core';
import type { CollectionBundle } from '@aegis/core';
import { compareCollectionBundles, exportPostmanCollection, parsePostmanCollection, serializePostmanJson, validatePostmanV21Structure } from '@aegis/postman';

const ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));

export type FixtureDir = 'har' | 'insomnia' | 'postman-v1' | 'dump' | 'postman';

export function formatFixtureText(dir: FixtureDir, name: string): string {
  return readFileSync(`${ROOT}${dir}/${name}`, 'utf8');
}

export function formatFixtureJson(dir: FixtureDir, name: string): any {
  return JSON.parse(formatFixtureText(dir, name));
}

export function failure(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected the call to throw');
}

export function ownKeysDeep(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => ownKeysDeep(v, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.push(k);
      ownKeysDeep(v, found);
    }
  }
  return found;
}

/**
 * Imported bundle -> Postman v2.1 export -> structurally valid -> re-import is
 * semantically equal (the contract every importer must satisfy).
 */
export function expectRoundTrip(bundle: CollectionBundle): void {
  const exported = exportPostmanCollection(bundle, { includeSecrets: true });
  expect(validatePostmanV21Structure(exported)).toEqual([]);
  const text = serializePostmanJson(exported);
  const again = parsePostmanCollection(text);
  expect(compareCollectionBundles(bundle, again.bundle)).toEqual([]);
  // deterministic and idempotent
  expect(serializePostmanJson(exportPostmanCollection(again.bundle, { includeSecrets: true }))).toBe(text);
}

/** Every `-literal` marker of the source must be absent from the imported data. */
export function literalsOf(text: string): string[] {
  return [...new Set(text.match(/[A-Za-z0-9._]*-literal-?[A-Za-z0-9._]*/g) ?? [])];
}
