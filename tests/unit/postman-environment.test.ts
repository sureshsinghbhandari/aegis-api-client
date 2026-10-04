import { describe, expect, it } from 'vitest';
import type { AppError, EnvironmentBundle } from '@aegis/core';
import {
  exportPostmanEnvironment,
  exportPostmanGlobals,
  parsePostmanEnvironment,
  parsePostmanGlobals,
  serializePostmanJson,
} from '@aegis/postman';
import { fixtureJson, fixtureText } from './_postman-fixtures';

describe('parsePostmanEnvironment', () => {
  it('maps values to variables (secret, disabled, type) and keeps source fields', () => {
    const { bundle, warnings } = parsePostmanEnvironment(fixtureText('environment-basic.json'));
    expect(bundle.name).toBe('Staging');
    expect(bundle.variables).toEqual([
      { key: 'baseUrl', initialValue: 'https://staging.api.example.com/v1', isSecret: false, enabled: true, type: 'default' },
      { key: 'apiToken', initialValue: 'env-secret-token-literal-6677', isSecret: true, enabled: true, type: 'secret' },
      { key: 'username', initialValue: 'qa-user', isSecret: false, enabled: true, type: 'default' },
      { key: 'debugFlag', initialValue: '1', isSecret: false, enabled: false, type: 'default' },
      { key: 'anything', initialValue: 'x', isSecret: false, enabled: true, type: 'any' },
    ]);
    expect(bundle.sourceMetadata).toEqual({
      id: fixtureJson('environment-basic.json').id,
      _postman_variable_scope: 'environment',
      _postman_exported_at: '2024-05-02T10:21:33.481Z',
      _postman_exported_using: 'Postman/11.1.0',
    });
    expect(warnings.filter((w) => w.severity !== 'INFO')).toEqual([]);
  });

  it('imports globals, defaulting the name', () => {
    const globals = parsePostmanGlobals(fixtureText('globals-basic.json'));
    expect(globals.bundle.name).toBe('My Workspace Globals');
    expect(globals.bundle.variables.map((v) => [v.key, v.isSecret, v.enabled])).toEqual([['tenant', false, true], ['globalSecret', true, true], ['oldVar', false, false]]);
    const unnamed = parsePostmanGlobals({ values: [], _postman_variable_scope: 'globals' });
    expect(unnamed.bundle.name).toBe('Globals');
    expect(unnamed.warnings).toContainEqual(expect.objectContaining({ severity: 'WARNING', path: 'name' }));
    expect(parsePostmanEnvironment({ values: [] }).bundle.name).toBe('Imported environment');
  });

  it('warns about unknown fields, structured values and variables without keys', () => {
    const { bundle, warnings } = parsePostmanEnvironment({
      name: 'Odd',
      values: [{ key: 'a', value: { nested: true }, enabled: true, extra: 1 }, { value: 'no key' }, { key: 'n', value: 5, description: 'five' }],
      'x-owner': 'me',
    });
    expect(bundle.variables.map((v) => [v.key, v.initialValue])).toEqual([['a', '{"nested":true}'], ['n', '5']]);
    expect(bundle.variables[1]!.description).toBe('five');
    expect(bundle.sourceMetadata).toEqual({ 'x-owner': 'me' });
    const paths = warnings.filter((w) => w.severity === 'WARNING').map((w) => w.path);
    expect(paths).toEqual(expect.arrayContaining(['values[0].extra', 'values[0].value', 'values[1]', 'x-owner']));
  });

  it('rejects documents that are not environments', () => {
    const fail = (input: string | object): AppError => {
      try {
        parsePostmanEnvironment(input);
      } catch (e) {
        return e as AppError;
      }
      throw new Error('expected failure');
    };
    expect(fail('nope').code).toBe('IMPORT_INVALID');
    expect(fail('[]').code).toBe('IMPORT_INVALID');
    expect(fail({ name: 'x' }).code).toBe('IMPORT_INVALID');
    expect(fail(fixtureText('kitchen-sink.json')).message).toMatch(/collection/);
    expect((fail({}).details.warnings as Array<{ severity: string }>)[0]!.severity).toBe('ERROR');
  });

  it('warns when a globals file is imported as an environment', () => {
    const r = parsePostmanEnvironment(fixtureText('globals-basic.json'));
    expect(r.warnings).toContainEqual(expect.objectContaining({ severity: 'WARNING', path: '_postman_variable_scope' }));
  });
});

describe('exportPostmanEnvironment / exportPostmanGlobals', () => {
  const env = (): EnvironmentBundle => parsePostmanEnvironment(fixtureText('environment-basic.json')).bundle;

  it('exports Postman environment JSON without volatile fields', () => {
    const out = exportPostmanEnvironment(env());
    expect(Object.keys(out)).toEqual(['id', 'name', 'values', '_postman_variable_scope', '_postman_exported_using']);
    expect(out.id).toBe(fixtureJson('environment-basic.json').id);
    expect(out._postman_variable_scope).toBe('environment');
    expect(out).not.toHaveProperty('_postman_exported_at');
    expect(out.values).toEqual([
      { key: 'baseUrl', value: 'https://staging.api.example.com/v1', type: 'default', enabled: true },
      { key: 'apiToken', value: '', type: 'secret', enabled: true },
      { key: 'username', value: 'qa-user', type: 'default', enabled: true },
      { key: 'debugFlag', value: '1', type: 'default', enabled: false },
      { key: 'anything', value: 'x', type: 'any', enabled: true },
    ]);
  });

  it('includes secrets only on request and prefers the current value', () => {
    const bundle = env();
    bundle.variables[0]!.currentValue = 'http://localhost:3000';
    bundle.variables[1]!.currentValue = 'rotated-secret';
    const safe = JSON.stringify(exportPostmanEnvironment(bundle));
    expect(safe).not.toContain('env-secret-token-literal-6677');
    expect(safe).not.toContain('rotated-secret');
    expect(safe).toContain('http://localhost:3000');
    const full = exportPostmanEnvironment(bundle, { includeSecrets: true }) as { values: Array<{ key: string; value: string }> };
    expect(full.values[1]!.value).toBe('rotated-secret');
    bundle.variables[1]!.currentValue = '';
    expect((exportPostmanEnvironment(bundle, { includeSecrets: true }) as { values: Array<{ value: string }> }).values[1]!.value).toBe('env-secret-token-literal-6677');
  });

  it('is deterministic, derives a stable id when none is known, and survives a round trip', () => {
    const bundle: EnvironmentBundle = { name: 'Fresh', variables: [{ key: 'k', initialValue: 'v', isSecret: false, enabled: true }] };
    const a = serializePostmanJson(exportPostmanEnvironment(bundle));
    expect(serializePostmanJson(exportPostmanEnvironment(bundle))).toBe(a);
    expect(JSON.parse(a).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const again = parsePostmanEnvironment(exportPostmanEnvironment(env(), { includeSecrets: true })).bundle;
    expect(again.variables).toEqual(env().variables.map((v) => ({ ...v })));
    expect(serializePostmanJson(exportPostmanEnvironment(again, { includeSecrets: true }))).toBe(serializePostmanJson(exportPostmanEnvironment(env(), { includeSecrets: true })));
  });

  it('exports globals with the globals scope', () => {
    const globals = parsePostmanGlobals(fixtureText('globals-basic.json')).bundle;
    const out = exportPostmanGlobals(globals);
    expect(out._postman_variable_scope).toBe('globals');
    expect(out.name).toBe('My Workspace Globals');
    expect((out.values as Array<{ value: string }>)[1]!.value).toBe('');
    expect(JSON.stringify(exportPostmanGlobals(globals, { includeSecrets: true }))).toContain('globals-secret-literal-1290');
    expect(parsePostmanGlobals(out).bundle.variables.map((v) => v.key)).toEqual(['tenant', 'globalSecret', 'oldVar']);
  });
});
