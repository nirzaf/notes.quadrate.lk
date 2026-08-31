import type { QNotesErrorCode } from '@qnotes/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: QNotesErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: QNotesErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function errorBody(error: ApiError, requestId: string) {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
