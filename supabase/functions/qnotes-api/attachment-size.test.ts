import assert from 'node:assert/strict';
import test from 'node:test';
import { validateUploadedAttachmentSize } from './attachment-size.ts';

test('accepts an uploaded attachment whose byte size matches metadata', () => {
  assert.deepEqual(validateUploadedAttachmentSize(12, 12, 100), { ok: true });
});

test('rejects an attachment with a mismatched byte size', () => {
  assert.deepEqual(validateUploadedAttachmentSize(12, 11, 100), { ok: false, reason: 'mismatch' });
  assert.deepEqual(validateUploadedAttachmentSize(12, 13, 100), { ok: false, reason: 'mismatch' });
});

test('rejects an attachment larger than the configured limit', () => {
  assert.deepEqual(validateUploadedAttachmentSize(101, 101, 100), { ok: false, reason: 'too_large' });
});
