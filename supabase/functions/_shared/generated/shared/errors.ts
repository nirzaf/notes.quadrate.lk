export type QNotesErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'INSUFFICIENT_SCOPE'
  | 'CORS_ORIGIN_DENIED'
  | 'VALIDATION_ERROR'
  | 'NOTE_NOT_FOUND'
  | 'NOTE_VERSION_CONFLICT'
  | 'NOTE_SLUG_CONFLICT'
  | 'MUTATION_REUSE_CONFLICT'
  | 'DUPLICATE_BLOCK_KEY'
  | 'INVALID_COPY_BLOCK'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_TOO_LARGE'
  | 'UNSUPPORTED_ATTACHMENT_TYPE'
  | 'ATTACHMENT_NOT_UPLOADED'
  | 'SEMANTIC_SEARCH_UNAVAILABLE'
  | 'EXPORT_TOO_LARGE'
  | 'INTERNAL_ERROR';

export class QNotesValidationError extends Error {
  readonly code: QNotesErrorCode = 'VALIDATION_ERROR';
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'QNotesValidationError';
    this.details = details;
  }
}
