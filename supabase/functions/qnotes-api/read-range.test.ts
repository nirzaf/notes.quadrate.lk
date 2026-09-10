import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../_shared/errors.ts';
import { contentSlice, fitJsonContent, parseReadRange, resolveReadRange } from './read-range.ts';

test('resolves byte and line ranges while preserving exact newlines', () => {
  const value = 'one\r\ntwo\n三\n';
  assert.deepEqual(resolveReadRange(value, parseReadRange({ offset: '5' })), { startOffset: 5, endOffset: 13, maxBytes: 64 * 1024 });
  assert.deepEqual(resolveReadRange(value, parseReadRange({ lineStart: '2', lineEnd: '2' })), { startOffset: 5, endOffset: 9, maxBytes: 64 * 1024 });
});

test('fits a serialized page and guarantees a progressing continuation', () => {
  const value = '😀'.repeat(100);
  const page = fitJsonContent(value, { startOffset: 0, endOffset: new TextEncoder().encode(value).byteLength, maxBytes: 256 }, (slice, truncated) => ({
    content: slice.content,
    offset: slice.startOffset,
    nextOffset: slice.endOffset,
    totalBytes: slice.totalBytes,
    truncated,
  }));
  assert.ok(new TextEncoder().encode(JSON.stringify({ data: page })).byteLength <= 256);
  assert.ok(page.nextOffset > page.offset);
  assert.equal(page.truncated, true);
});

test('rejects malformed ranges and a budget too small for the envelope', () => {
  assert.throws(() => parseReadRange({ offset: 1, lineStart: 1 }), ApiError);
  assert.throws(() => contentSlice('😀', 1, 4, 4), ApiError);
  assert.throws(() => fitJsonContent('content', { startOffset: 0, endOffset: 7, maxBytes: 1 }, (slice) => ({ content: slice.content, metadata: 'required' })), /too small/);
});
