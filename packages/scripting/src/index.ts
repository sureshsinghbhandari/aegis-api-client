import type { ScriptRunInput, ScriptRunResult } from '@aegis/core';
import { executeScript } from './sandbox';

export { discardSandboxModule } from './sandbox';
export {
  DEFAULT_MAX_SEND_REQUESTS,
  DEFAULT_MAX_STACK_BYTES,
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_MESSAGE_CHARS,
  MAX_TESTS,
  resolveLimits,
} from './limits';
export type { ResolvedLimits } from './limits';

const SCOPES = ['globals', 'environment', 'collectionVariables', 'variables', 'iterationData'] as const;

function assertValidInput(input: ScriptRunInput): void {
  if (typeof input !== 'object' || input === null) throw new TypeError('runScript: input is required');
  if (typeof input.source !== 'string') throw new TypeError('runScript: input.source must be a string');
  if (input.phase !== 'prerequest' && input.phase !== 'test') throw new TypeError('runScript: input.phase must be "prerequest" or "test"');
  if (typeof input.host?.sendRequest !== 'function') throw new TypeError('runScript: input.host.sendRequest is required');
  if (typeof input.request !== 'object' || input.request === null) throw new TypeError('runScript: input.request is required');
  if (typeof input.info !== 'object' || input.info === null) throw new TypeError('runScript: input.info is required');
  if (typeof input.variables !== 'object' || input.variables === null) throw new TypeError('runScript: input.variables is required');
  for (const scope of SCOPES) {
    if (typeof input.variables[scope] !== 'object' || input.variables[scope] === null) {
      throw new TypeError(`runScript: input.variables.${scope} is required`);
    }
  }
  if (!Array.isArray(input.cookies)) throw new TypeError('runScript: input.cookies must be an array');
}

/**
 * Run one pre-request or test script in a fresh, isolated QuickJS sandbox.
 * Never rejects because of the SCRIPT (errors, timeouts, out-of-memory and
 * cancellation are reported in the result); it only throws TypeError for
 * malformed input (programmer errors).
 */
export async function runScript(input: ScriptRunInput): Promise<ScriptRunResult> {
  assertValidInput(input);
  return executeScript(input);
}
