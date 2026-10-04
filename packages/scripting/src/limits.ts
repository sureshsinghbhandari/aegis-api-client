import type { ScriptLimits } from '@aegis/core';

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/**
 * QuickJS runs on the HOST's native call stack (WASM), but its stack-overflow
 * check measures a different (shadow) stack. Values above ~256 KiB therefore let
 * deep recursion overflow the host stack before QuickJS notices. Keep it small.
 */
export const DEFAULT_MAX_STACK_BYTES = 128 * 1024;
export const MIN_STACK_BYTES = 32 * 1024;
export const MAX_STACK_BYTES = 256 * 1024;
export const DEFAULT_MAX_SEND_REQUESTS = 20;

export const MAX_CONSOLE_ENTRIES = 1000;
export const MAX_CONSOLE_MESSAGE_CHARS = 16 * 1024;
export const MAX_TESTS = 5000;
export const MAX_SOURCE_CHARS = 2 * 1024 * 1024;
export const MAX_PENDING_TIMERS = 1000;

export interface ResolvedLimits {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
  maxSendRequests: number;
}

function positiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function resolveLimits(limits: Partial<ScriptLimits> | undefined): ResolvedLimits {
  const l = limits ?? {};
  const stack = positiveFinite(l.maxStackSizeBytes) ? l.maxStackSizeBytes : DEFAULT_MAX_STACK_BYTES;
  return {
    timeoutMs: positiveFinite(l.timeoutMs) ? Math.min(l.timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    memoryLimitBytes: positiveFinite(l.memoryLimitBytes) ? Math.floor(l.memoryLimitBytes) : DEFAULT_MEMORY_LIMIT_BYTES,
    maxStackSizeBytes: Math.floor(Math.min(MAX_STACK_BYTES, Math.max(MIN_STACK_BYTES, stack))),
    maxSendRequests:
      typeof l.maxSendRequests === 'number' && Number.isFinite(l.maxSendRequests) && l.maxSendRequests >= 0
        ? Math.floor(l.maxSendRequests)
        : DEFAULT_MAX_SEND_REQUESTS,
  };
}
