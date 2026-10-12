import { GUEST_BUILTINS, GUEST_SHIMS } from './guest/builtins';
import { GUEST_CORE } from './guest/core';
import { GUEST_LIBS } from './guest/libs';
import { GUEST_PM } from './guest/pm';
import { GUEST_REQUEST } from './guest/request';
import { GUEST_RESPONSE } from './guest/response';

/** Stage 1: globals that must exist before chai is evaluated (also the web-platform built-ins). */
export const BOOTSTRAP_SOURCE: string = GUEST_SHIMS + '\n' + GUEST_BUILTINS;

/**
 * Stage 2: an expression that evaluates to `function (host, inputJson)`.
 * Calling it installs `pm`, `expect`, `console`, ... on the global object and
 * returns `{ snapshot(), describe(error) }`. The chai bundle must already have
 * been evaluated (it publishes `globalThis.__aegisChai`, which is consumed and
 * deleted here so scripts cannot reach it).
 */
export const PRELUDE_SOURCE: string =
  '(function (host, inputJson) {\n' +
  "'use strict';\n" +
  'const chai = globalThis.__aegisChai;\n' +
  'delete globalThis.__aegisChai;\n' +
  'delete globalThis.Event;\n' +
  'delete globalThis.EventTarget;\n' +
  GUEST_CORE +
  GUEST_REQUEST +
  GUEST_RESPONSE +
  GUEST_LIBS +
  GUEST_PM +
  '\n})';

/**
 * The user script is wrapped in an async function so top-level `await` and
 * `return` work (like Postman) while keeping sloppy-mode semantics and the
 * original line numbers (no newline is added before the user's first line).
 */
export function wrapUserScript(source: string): string {
  return '(async function () {' + source + '\n})()';
}
