import type { EnvironmentBundle, VariableEntry } from '@aegis/core';
import type { JsonObject } from './shared';
import { mergeExtras, uuidFromName } from './shared';

export interface EnvironmentExportOptions {
  /** Emit secret values. Default false: secret values are exported as "". */
  includeSecrets?: boolean;
}

/** Source fields that change on every export and are therefore not re-emitted. */
const VOLATILE_KEYS: ReadonlySet<string> = new Set(['_postman_exported_at', '_postman_variable_scope', 'id']);

function exportValue(v: VariableEntry, includeSecrets: boolean): JsonObject {
  const current = v.currentValue !== undefined && v.currentValue !== '' ? v.currentValue : v.initialValue;
  const out: JsonObject = {
    key: v.key,
    value: v.isSecret && !includeSecrets ? '' : current,
    type: v.isSecret ? 'secret' : v.type === 'any' ? 'any' : 'default',
    enabled: v.enabled,
  };
  if (v.description) out.description = v.description;
  return out;
}

function exportValuesDocument(env: EnvironmentBundle, scope: 'environment' | 'globals', options: EnvironmentExportOptions): JsonObject {
  const includeSecrets = options.includeSecrets === true;
  const source = env.sourceMetadata ?? {};
  const out: JsonObject = {
    id: typeof source.id === 'string' ? source.id : uuidFromName(`${scope}:${env.name}`),
    name: env.name,
    values: env.variables.map((v) => exportValue(v, includeSecrets)),
    _postman_variable_scope: scope,
  };
  mergeExtras(out, Object.fromEntries(Object.entries(source).filter(([k]) => !VOLATILE_KEYS.has(k))));
  return out;
}

/** Export an environment as Postman environment JSON (deterministic; no export timestamp). */
export function exportPostmanEnvironment(env: EnvironmentBundle, options: EnvironmentExportOptions = {}): JsonObject {
  return exportValuesDocument(env, 'environment', options);
}

/** Export globals as Postman globals JSON (scope "globals"). */
export function exportPostmanGlobals(env: EnvironmentBundle, options: EnvironmentExportOptions = {}): JsonObject {
  return exportValuesDocument(env, 'globals', options);
}
