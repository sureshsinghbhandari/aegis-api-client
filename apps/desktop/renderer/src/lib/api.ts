import type { AegisApi, ErrorCode, SerializedAppError } from '@aegis/core';

/** Error thrown by every `api.*` call. Mirrors the main-process AppError. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  constructor(e: SerializedAppError) {
    super(e.message);
    this.name = 'ApiError';
    this.code = e.code;
    this.details = e.details ?? {};
  }
}

type Raw = Omit<AegisApi, 'events'> & { events: AegisApi['events'] };

declare global {
  interface Window {
    api: Raw;
  }
}

const PREFIX = 'AEGIS_ERR:';

export function parseIpcError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const at = message.indexOf(PREFIX);
  if (at !== -1) {
    try {
      return new ApiError(JSON.parse(message.slice(at + PREFIX.length)) as SerializedAppError);
    } catch {
      /* fall through */
    }
  }
  return new ApiError({ code: 'INTERNAL', message: 'An unexpected error occurred.' });
}

function wrap<T extends object>(ns: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(ns as Record<string, (a?: unknown) => Promise<unknown>>)) {
    out[name] = async (args?: unknown) => {
      try {
        return await fn(args);
      } catch (error) {
        throw parseIpcError(error);
      }
    };
  }
  return out as T;
}

function build(): Omit<AegisApi, 'events'> & { events: AegisApi['events'] } {
  const raw = window.api as unknown as Record<string, object>;
  const out: Record<string, unknown> = {};
  for (const [ns, methods] of Object.entries(raw)) out[ns] = ns === 'events' ? methods : wrap(methods);
  return out as unknown as Raw;
}

/** Typed, error-normalised bridge to the main process. */
export const api: Raw = build();

export function errorMessage(error: unknown): string {
  return parseIpcError(error).message;
}
