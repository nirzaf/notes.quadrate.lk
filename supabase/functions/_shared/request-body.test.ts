import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedRequest, readRequestBody, RequestBodyTooLarge } from './request-body.ts';

test('checks actual streamed bytes when Content-Length is misleading', async () => {
  const request = new Request('https://example.test', {
    method: 'POST',
    headers: { 'content-length': '1' },
    body: '12345',
  });
  assert.deepEqual(Array.from(await readRequestBody(request, 5)), Array.from(new TextEncoder().encode('12345')));
});

test('rejects a declared body over the limit before reading it', async () => {
  const request = new Request('https://example.test', {
    method: 'POST',
    headers: { 'content-length': '6' },
    body: '123456',
  });
  await assert.rejects(readRequestBody(request, 5), RequestBodyTooLarge);
});

test('rejects a chunked body when the accumulated bytes exceed the limit', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2, 3));
      controller.enqueue(Uint8Array.of(4, 5, 6));
      controller.close();
    },
  });
  const request = new Request('https://example.test', { method: 'POST', body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
  await assert.rejects(readRequestBody(request, 5), RequestBodyTooLarge);
});

test('rebuilds a bounded request for downstream parsers', async () => {
  const original = new Request('https://example.test/path', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'abc' });
  const bounded = await boundedRequest(original, 3);
  assert.equal(bounded.method, 'POST');
  assert.equal(bounded.headers.get('content-type'), 'text/plain');
  assert.equal(await bounded.text(), 'abc');
});
