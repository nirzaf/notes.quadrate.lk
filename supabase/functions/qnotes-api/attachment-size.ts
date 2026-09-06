export type AttachmentSizeFailure = 'mismatch' | 'too_large';

export type AttachmentSizeValidation =
  | { ok: true }
  | { ok: false; reason: AttachmentSizeFailure };

export function validateUploadedAttachmentSize(
  declaredSizeBytes: number,
  actualSizeBytes: number,
  maxSizeBytes: number,
): AttachmentSizeValidation {
  if (actualSizeBytes > maxSizeBytes) return { ok: false, reason: 'too_large' };
  if (declaredSizeBytes !== actualSizeBytes) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}
