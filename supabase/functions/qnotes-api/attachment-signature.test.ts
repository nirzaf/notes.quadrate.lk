import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAttachmentSignature } from './attachment-signature.ts';

test('attachment signatures accept the declared supported formats', () => {
  assert.deepEqual(validateAttachmentSignature('application/pdf', new TextEncoder().encode('%PDF-1.7')), { ok: true });
  assert.deepEqual(validateAttachmentSignature('image/png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { ok: true });
  assert.deepEqual(validateAttachmentSignature('image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), { ok: true });
  assert.deepEqual(validateAttachmentSignature('image/webp', new TextEncoder().encode('RIFF1234WEBP')), { ok: true });
  assert.deepEqual(validateAttachmentSignature('text/plain', new TextEncoder().encode('plain text')), { ok: true });
});

test('attachment signatures reject mismatched or malformed bytes', () => {
  assert.deepEqual(validateAttachmentSignature('application/pdf', new TextEncoder().encode('plain text')), { ok: false, reason: 'type_mismatch' });
  assert.deepEqual(validateAttachmentSignature('image/png', new TextEncoder().encode('not png')), { ok: false, reason: 'type_mismatch' });
  assert.deepEqual(validateAttachmentSignature('image/webp', new TextEncoder().encode('RIFF1234NOPE')), { ok: false, reason: 'type_mismatch' });
  assert.deepEqual(validateAttachmentSignature('text/plain', Uint8Array.from([0xff])), { ok: false, reason: 'type_mismatch' });
});
