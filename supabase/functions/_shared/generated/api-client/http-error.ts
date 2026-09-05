import type { QNotesErrorCode } from '@qnotes/shared';

export class QNotesHttpError extends Error {
  readonly status: number;
  readonly code: QNotesErrorCode;
  readonly requestId: string;
  readonly details?: unknown;

  constructor(status: number, code: QNotesErrorCode, message: string, requestId: string, details?: unknown) {
    super(message);
    this.name = 'QNotesHttpError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    if (details !== undefined) this.details = details;
  }
}
