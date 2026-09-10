export type AttachmentSignatureFailure = 'type_mismatch';

export type AttachmentSignatureValidation =
  | { ok: true }
  | { ok: false; reason: AttachmentSignatureFailure };

function startsWithBytes(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function startsWithText(bytes: Uint8Array, value: string): boolean {
  return startsWithBytes(bytes, Array.from(new TextEncoder().encode(value)));
}

export function validateAttachmentSignature(mimeType: string, bytes: Uint8Array): AttachmentSignatureValidation {
  if (mimeType === 'application/pdf') return startsWithText(bytes, '%PDF-') ? { ok: true } : { ok: false, reason: 'type_mismatch' };
  if (mimeType === 'image/png') return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? { ok: true } : { ok: false, reason: 'type_mismatch' };
  if (mimeType === 'image/jpeg') return startsWithBytes(bytes, [0xff, 0xd8, 0xff]) ? { ok: true } : { ok: false, reason: 'type_mismatch' };
  if (mimeType === 'image/webp') return startsWithText(bytes, 'RIFF') && startsWithText(bytes.slice(8), 'WEBP') ? { ok: true } : { ok: false, reason: 'type_mismatch' };
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'type_mismatch' };
    }
  }
  return { ok: false, reason: 'type_mismatch' };
}
