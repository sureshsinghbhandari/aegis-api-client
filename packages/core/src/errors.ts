/** Stable, machine-readable error codes. Never remove a code; UI and tests rely on them. */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_CANCELLED'
  | 'NETWORK_ERROR'
  | 'TLS_ERROR'
  | 'RESPONSE_TOO_LARGE'
  | 'REQUEST_TOO_LARGE'
  | 'TOO_MANY_REDIRECTS'
  | 'POLICY_VIOLATION'
  | 'CONFIRMATION_REQUIRED'
  | 'SCRIPT_TIMEOUT'
  | 'SCRIPT_ERROR'
  | 'SCRIPT_MEMORY'
  | 'IMPORT_INVALID'
  | 'IMPORT_TOO_LARGE'
  | 'IMPORT_FAILED'
  | 'PATH_NOT_ALLOWED'
  | 'SECRET_STORAGE_UNAVAILABLE'
  | 'AUTH_FAILED'
  | 'IPC_INVALID_ARGUMENT'
  | 'INTERNAL';

export interface SerializedAppError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Structured application error. `message` is safe to show to end users. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toJSON(): SerializedAppError {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Convert anything thrown into a serializable, user-safe error (no stack trace). */
export function toSerializedError(error: unknown): SerializedAppError {
  if (error instanceof AppError) return error.toJSON();
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    const e = error as SerializedAppError;
    return { code: e.code, message: e.message, details: e.details ?? {} };
  }
  return { code: 'INTERNAL', message: 'An unexpected error occurred.', details: {} };
}
